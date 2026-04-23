import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractBashCommand,
  extractSkillName,
  loadSkillConstraints,
  parseSkillFrontmatter,
} from '../container/agent-runner/src/skills.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-constraints-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(skillName: string, frontmatter: string, body = ''): void {
  const dir = path.join(tmpDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n${body}`,
  );
}

describe('parseSkillFrontmatter', () => {
  it('returns null when no frontmatter present', () => {
    expect(parseSkillFrontmatter('# just a heading\n')).toBeNull();
  });

  it('returns null on malformed YAML', () => {
    expect(parseSkillFrontmatter('---\nname: [unclosed\n---\n')).toBeNull();
  });

  it('parses name and deniedCommands', () => {
    const out = parseSkillFrontmatter(
      '---\nname: tpp\ndeniedCommands:\n  - "sudo"\n  - "rm -rf"\n---\nbody',
    );
    expect(out?.name).toBe('tpp');
    expect(out?.deniedCommands).toEqual(['sudo', 'rm -rf']);
  });

  it('omits deniedCommands when missing', () => {
    const out = parseSkillFrontmatter('---\nname: x\n---\n');
    expect(out?.name).toBe('x');
    expect(out?.deniedCommands).toBeUndefined();
  });

  it('filters non-string entries from deniedCommands', () => {
    const out = parseSkillFrontmatter(
      '---\nname: x\ndeniedCommands:\n  - "ok"\n  - 42\n  - null\n---\n',
    );
    expect(out?.deniedCommands).toEqual(['ok']);
  });
});

describe('loadSkillConstraints', () => {
  it('returns empty map when directory does not exist', () => {
    const map = loadSkillConstraints([path.join(tmpDir, 'nope')]);
    expect(map.size).toBe(0);
  });

  it('compiles deniedCommands into RegExps keyed by skill name', () => {
    writeSkill(
      'tpp',
      'name: tpp\ndeniedCommands:\n  - "(?:^|[\\\\s;|&])sudo(?:$|\\\\s)"',
    );
    const map = loadSkillConstraints([tmpDir]);
    const patterns = map.get('tpp');
    expect(patterns).toBeDefined();
    expect(patterns).toHaveLength(1);
    expect(patterns![0].test('sudo apt update')).toBe(true);
    expect(patterns![0].test('echo sudo-ish')).toBe(false);
    expect(patterns![0].test('ls && sudo rm')).toBe(true);
  });

  it('skips skills with no deniedCommands', () => {
    writeSkill('quiet', 'name: quiet');
    const map = loadSkillConstraints([tmpDir]);
    expect(map.has('quiet')).toBe(false);
  });

  it('logs and skips invalid regex but keeps valid siblings', () => {
    writeSkill(
      'mixed',
      'name: mixed\ndeniedCommands:\n  - "valid"\n  - "(unbalanced"',
    );
    const messages: string[] = [];
    const map = loadSkillConstraints([tmpDir], (m) => messages.push(m));
    const patterns = map.get('mixed');
    expect(patterns).toHaveLength(1);
    expect(patterns![0].source).toBe('valid');
    expect(messages.some((m) => m.includes('invalid deniedCommands'))).toBe(
      true,
    );
  });

  it('drops skills where every regex is invalid', () => {
    writeSkill('broken', 'name: broken\ndeniedCommands:\n  - "(unbalanced"');
    const map = loadSkillConstraints([tmpDir], () => {});
    expect(map.has('broken')).toBe(false);
  });

  it('later directory overrides earlier for same skill name', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-b-'));
    try {
      fs.mkdirSync(path.join(dirA, 'shared'));
      fs.writeFileSync(
        path.join(dirA, 'shared', 'SKILL.md'),
        '---\nname: shared\ndeniedCommands:\n  - "first"\n---\n',
      );
      fs.mkdirSync(path.join(dirB, 'shared'));
      fs.writeFileSync(
        path.join(dirB, 'shared', 'SKILL.md'),
        '---\nname: shared\ndeniedCommands:\n  - "second"\n---\n',
      );
      const map = loadSkillConstraints([dirA, dirB]);
      const patterns = map.get('shared');
      expect(patterns).toHaveLength(1);
      expect(patterns![0].source).toBe('second');
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('extractSkillName', () => {
  it('returns null for non-object input', () => {
    expect(extractSkillName(null)).toBeNull();
    expect(extractSkillName('skill-name')).toBeNull();
    expect(extractSkillName(undefined)).toBeNull();
  });

  it('returns null when skill field missing', () => {
    expect(extractSkillName({ args: '' })).toBeNull();
  });

  it('returns null when skill is empty string', () => {
    expect(extractSkillName({ skill: '' })).toBeNull();
  });

  it('returns the skill name from a Skill-tool input', () => {
    expect(extractSkillName({ skill: 'tpp', args: 'connect martis' })).toBe(
      'tpp',
    );
  });
});

describe('extractBashCommand', () => {
  it('returns null when command field missing', () => {
    expect(extractBashCommand({ description: 'hi' })).toBeNull();
    expect(extractBashCommand(null)).toBeNull();
  });

  it('returns the command string', () => {
    expect(extractBashCommand({ command: 'ls -la' })).toBe('ls -la');
  });

  it('returns empty string as-is (caller decides)', () => {
    expect(extractBashCommand({ command: '' })).toBe('');
  });
});
