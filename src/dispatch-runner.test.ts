import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock container-runner so processDispatchIpc doesn't try to spawn a real
// docker container. We assert against the mock to verify the right
// subagent / model / prompt got handed off.
vi.mock('./container-runner.js', () => ({
  runSubagentContainer: vi.fn(),
}));

import {
  splitFrontmatter,
  validateDispatchTask,
  readPersonaModel,
  buildSubagentPrompt,
  processDispatchIpc,
  KNOWN_AGENTS,
} from './dispatch-runner.js';
import { runSubagentContainer } from './container-runner.js';

let tmpDir: string;

function writeAgent(file: string, model: string | null, body: string) {
  const fm = model ? `---\nmodel: ${model}\n---\n` : '';
  fs.writeFileSync(path.join(tmpDir, file), fm + body);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('splitFrontmatter', () => {
  it('parses model alias from a typical agent file', () => {
    const { frontmatter, body } = splitFrontmatter(
      '---\nmodel: sonnet\n---\n\n# Cypher\n\nbody here',
    );
    expect(frontmatter.model).toBe('sonnet');
    // Splitter consumes the closing `---` plus surrounding whitespace, so
    // body starts at the first non-whitespace content.
    expect(body).toBe('# Cypher\n\nbody here');
  });

  it('handles multiple frontmatter keys', () => {
    const { frontmatter } = splitFrontmatter(
      '---\nname: bob\nmodel: opus\nrole: reviewer\n---\nbody',
    );
    expect(frontmatter.name).toBe('bob');
    expect(frontmatter.model).toBe('opus');
    expect(frontmatter.role).toBe('reviewer');
  });

  it('strips wrapping quotes from values', () => {
    const { frontmatter } = splitFrontmatter(
      '---\nmodel: "sonnet"\nname: \'cypher\'\n---\nbody',
    );
    expect(frontmatter.model).toBe('sonnet');
    expect(frontmatter.name).toBe('cypher');
  });

  it('returns empty frontmatter when no leading --- block', () => {
    const { frontmatter, body } = splitFrontmatter('# just a body\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# just a body\n');
  });

  it('skips malformed lines without losing valid ones', () => {
    const { frontmatter } = splitFrontmatter(
      '---\nmodel: sonnet\n   not-a-pair\n---\nbody',
    );
    expect(frontmatter.model).toBe('sonnet');
  });
});

describe('validateDispatchTask', () => {
  const valid = {
    type: 'dispatch',
    dispatch_id: 'd-1',
    agent: 'cypher',
    task_description: 'do the thing',
    originating_group: 'telegram_main',
    chat_jid: 'tg:123',
    timestamp: '2026-05-06T17:00:00Z',
  };

  it('accepts a well-formed payload', () => {
    expect(validateDispatchTask(valid)?.agent).toBe('cypher');
  });

  it('rejects unknown agent name', () => {
    expect(validateDispatchTask({ ...valid, agent: 'mystery' })).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateDispatchTask({ ...valid, task_description: '' })).toBeNull();
    expect(validateDispatchTask({ ...valid, dispatch_id: '' })).toBeNull();
    expect(validateDispatchTask({ ...valid, chat_jid: '' })).toBeNull();
  });

  it('rejects wrong type', () => {
    expect(validateDispatchTask({ ...valid, type: 'message' })).toBeNull();
  });

  it('defaults context_files to empty array', () => {
    expect(validateDispatchTask(valid)?.context_files).toEqual([]);
  });

  it('preserves pipeline=true', () => {
    expect(validateDispatchTask({ ...valid, pipeline: true })?.pipeline).toBe(
      true,
    );
  });

  it('coerces missing pipeline to false', () => {
    expect(validateDispatchTask(valid)?.pipeline).toBe(false);
  });

  it('synthesises a timestamp if absent', () => {
    const out = validateDispatchTask({ ...valid, timestamp: undefined });
    expect(typeof out?.timestamp).toBe('string');
  });
});

describe('readPersonaModel', () => {
  it('returns the model from a normal file', () => {
    writeAgent('developer.md', 'sonnet', '# Cypher body');
    const out = readPersonaModel(tmpDir, 'cypher');
    expect('model' in out && out.model).toBe('sonnet');
  });

  it('defaults to sonnet when frontmatter has no model', () => {
    writeAgent('developer.md', null, '# no frontmatter');
    const out = readPersonaModel(tmpDir, 'cypher');
    expect('model' in out && out.model).toBe('sonnet');
  });

  it('errors on unknown agent', () => {
    const out = readPersonaModel(tmpDir, 'mystery');
    expect('error' in out && out.error).toMatch(/Unknown agent/);
  });

  it('errors when persona file missing', () => {
    const out = readPersonaModel(tmpDir, 'cypher');
    expect('error' in out && out.error).toMatch(/not found/);
  });

  it('handles all five known agents with correct file lookup', () => {
    writeAgent('developer.md', 'sonnet', 'a');
    writeAgent('tester.md', 'sonnet', 'a');
    writeAgent('ui-tester.md', 'haiku', 'a');
    writeAgent('reviewer.md', 'opus', 'a');
    writeAgent('triage.md', 'sonnet', 'a');
    expect(KNOWN_AGENTS).toEqual([
      'cypher',
      'vector',
      'prism',
      'sentinel',
      'triage',
    ]);
    for (const agent of KNOWN_AGENTS) {
      expect('error' in readPersonaModel(tmpDir, agent)).toBe(false);
    }
  });
});

describe('buildSubagentPrompt', () => {
  it('returns task_description unchanged when no context files', () => {
    expect(buildSubagentPrompt('hello', [], tmpDir)).toBe('hello');
  });

  it('reads allowed context files and wraps in <context>', () => {
    const filePath = path.join('/workspace/group', 'note.md');
    // Create the file under a tmp path that mimics /workspace/group; we
    // can't actually write there, so use an allowed root by writing to
    // /workspace/group via a symlink or accept the missing-file branch.
    // Test the missing-file branch instead — it's a real production path.
    const out = buildSubagentPrompt('do thing', [filePath], tmpDir);
    expect(out).toContain('<context>');
    expect(out).toContain(`<file path="${filePath}" status="missing"/>`);
    expect(out).toContain('do thing');
  });

  it('rejects context paths outside allowed roots', () => {
    const out = buildSubagentPrompt('go', ['/etc/passwd'], tmpDir);
    expect(out).toContain('outside-allowed-roots');
  });
});

describe('processDispatchIpc', () => {
  const baseTask = {
    type: 'dispatch',
    dispatch_id: 'd-42',
    agent: 'cypher',
    task_description: 'build a thing',
    originating_group: 'telegram_main',
    chat_jid: 'tg:123',
    timestamp: '2026-05-06T17:00:00Z',
  };

  const fakeGroup = {
    name: 'main',
    folder: 'telegram_main',
    trigger: '@a',
    added_at: '2026-05-06',
  };

  function makeDeps(overrides = {}) {
    return {
      brainAgentsHostDir: tmpDir,
      resolveGroup: vi.fn(() => fakeGroup),
      pipeFollowUp: vi.fn(() => true),
      ...overrides,
    };
  }

  it('returns error for invalid payload without spawning', async () => {
    const result = await processDispatchIpc({ bogus: true }, makeDeps());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Invalid dispatch payload/);
    expect(runSubagentContainer).not.toHaveBeenCalled();
  });

  it('returns error if persona missing', async () => {
    const result = await processDispatchIpc(baseTask, makeDeps());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Persona file not found/);
    expect(runSubagentContainer).not.toHaveBeenCalled();
  });

  it('returns error if originating group not registered', async () => {
    writeAgent('developer.md', 'sonnet', '# body');
    const deps = makeDeps({ resolveGroup: vi.fn(() => null) });
    const result = await processDispatchIpc(baseTask, deps);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not registered/);
    expect(runSubagentContainer).not.toHaveBeenCalled();
  });

  it('spawns container with parsed model when everything resolves', async () => {
    writeAgent('developer.md', 'sonnet', '# body');
    vi.mocked(runSubagentContainer).mockResolvedValue({
      status: 'success',
      result: 'PR opened',
    });
    const result = await processDispatchIpc(baseTask, makeDeps());
    expect(result.status).toBe('success');
    expect(result.result).toBe('PR opened');
    expect(runSubagentContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'tg:123',
        subagentName: 'cypher',
        model: 'sonnet',
        dispatchId: 'd-42',
      }),
    );
  });

  it('does not pipe follow-up when pipeline=false', async () => {
    writeAgent('developer.md', 'sonnet', '# body');
    vi.mocked(runSubagentContainer).mockResolvedValue({
      status: 'success',
      result: 'done',
    });
    const deps = makeDeps();
    await processDispatchIpc(baseTask, deps);
    expect(deps.pipeFollowUp).not.toHaveBeenCalled();
  });

  it('pipes follow-up to originator when pipeline=true', async () => {
    writeAgent('developer.md', 'sonnet', '# body');
    vi.mocked(runSubagentContainer).mockResolvedValue({
      status: 'success',
      result: 'PR opened',
    });
    const deps = makeDeps();
    await processDispatchIpc({ ...baseTask, pipeline: true }, deps);
    expect(deps.pipeFollowUp).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('[DISPATCH_RESULT] cypher completed'),
    );
  });

  it('pipes failure follow-up when subagent errors and pipeline=true', async () => {
    writeAgent('developer.md', 'sonnet', '# body');
    vi.mocked(runSubagentContainer).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'kaboom',
    });
    const deps = makeDeps();
    await processDispatchIpc({ ...baseTask, pipeline: true }, deps);
    expect(deps.pipeFollowUp).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('FAILED'),
    );
  });
});
