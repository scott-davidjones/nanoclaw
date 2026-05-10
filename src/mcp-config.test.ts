import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadMcpServers } from './mcp-config.js';

describe('loadMcpServers', () => {
  let tmp: string;
  let homeDir: string;
  let cwd: string;
  let envExtra: string;
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-test-'));
    homeDir = path.join(tmp, 'home');
    cwd = path.join(tmp, 'repo');
    envExtra = path.join(tmp, 'env-extra');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(envExtra, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const log = (msg: string) => logs.push(msg);

  function writeJson(p: string, obj: unknown) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
  }

  it('returns empty when no config files exist', () => {
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers).toEqual({});
    expect(result.sources).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('reads repo .mcp.json', () => {
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: {
        memory: { type: 'http', url: 'http://localhost:3456/mcp' },
      },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers).toEqual({
      memory: { type: 'http', url: 'http://localhost:3456/mcp' },
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      name: 'memory',
      origin: 'repo-file',
    });
  });

  it('reads user-level mcp.json', () => {
    writeJson(path.join(homeDir, '.config', 'nanoclaw', 'mcp.json'), {
      mcpServers: {
        memory: { type: 'http', url: 'http://user:3456/mcp' },
      },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers.memory).toEqual({
      type: 'http',
      url: 'http://user:3456/mcp',
    });
    expect(result.sources[0].origin).toBe('user-file');
  });

  it('repo overlays user on name conflict', () => {
    writeJson(path.join(homeDir, '.config', 'nanoclaw', 'mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'http://user:3456/mcp' } },
    });
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'http://repo:3456/mcp' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers.memory).toEqual({
      type: 'http',
      url: 'http://repo:3456/mcp',
    });
  });

  it('merges multiple files in mcp.d/ in lexicographic order', () => {
    writeJson(path.join(cwd, '.mcp.d', '01-memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'first' } },
    });
    writeJson(path.join(cwd, '.mcp.d', '02-qmd.json'), {
      mcpServers: { qmd: { type: 'http', url: 'second' } },
    });
    writeJson(path.join(cwd, '.mcp.d', '03-memory-override.json'), {
      mcpServers: { memory: { type: 'http', url: 'third' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers).toEqual({
      memory: { type: 'http', url: 'third' },
      qmd: { type: 'http', url: 'second' },
    });
  });

  it('mcp.d/ overlays mcp.json at the same layer', () => {
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'from-file' } },
    });
    writeJson(path.join(cwd, '.mcp.d', 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'from-dir' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers.memory).toEqual({
      type: 'http',
      url: 'from-dir',
    });
  });

  it('env-extra paths are layered after user and repo', () => {
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'repo' } },
    });
    writeJson(path.join(envExtra, 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'env' } },
    });
    const result = loadMcpServers({
      cwd,
      homeDir,
      envPath: envExtra,
      log,
    });
    expect(result.servers.memory).toEqual({ type: 'http', url: 'env' });
  });

  it('env-extra accepts colon-separated mix of files and dirs', () => {
    const extraFile = path.join(tmp, 'extra.json');
    writeJson(extraFile, {
      mcpServers: { git: { command: 'git-mcp' } },
    });
    writeJson(path.join(envExtra, 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'env-dir' } },
    });
    const result = loadMcpServers({
      cwd,
      homeDir,
      envPath: `${extraFile}:${envExtra}`,
      log,
    });
    expect(result.servers).toEqual({
      git: { command: 'git-mcp' },
      memory: { type: 'http', url: 'env-dir' },
    });
  });

  it('malformed JSON in one file does not crash the loader', () => {
    fs.mkdirSync(path.join(cwd, '.mcp.d'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.mcp.d', 'broken.json'), '{not json');
    writeJson(path.join(cwd, '.mcp.d', 'good.json'), {
      mcpServers: { memory: { type: 'http', url: 'survived' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers.memory).toEqual({
      type: 'http',
      url: 'survived',
    });
    expect(logs.some((l) => l.includes('invalid JSON') && l.includes('broken.json'))).toBe(true);
  });

  it('files missing the mcpServers key contribute nothing', () => {
    writeJson(path.join(cwd, '.mcp.json'), { somethingElse: true });
    writeJson(path.join(cwd, '.mcp.d', 'good.json'), {
      mcpServers: { memory: { type: 'http', url: 'ok' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers).toEqual({
      memory: { type: 'http', url: 'ok' },
    });
  });

  it('rejects mcpServers that is not an object', () => {
    writeJson(path.join(cwd, '.mcp.json'), { mcpServers: ['not', 'a', 'map'] });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(result.servers).toEqual({});
    expect(logs.some((l) => l.includes('must be an object map'))).toBe(true);
  });

  it('ignores non-.json files in mcp.d/', () => {
    writeJson(path.join(cwd, '.mcp.d', 'good.json'), {
      mcpServers: { memory: { type: 'http', url: 'ok' } },
    });
    fs.writeFileSync(path.join(cwd, '.mcp.d', 'README.md'), 'docs');
    fs.writeFileSync(path.join(cwd, '.mcp.d', 'memory.json.bak'), '{}');
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    expect(Object.keys(result.servers)).toEqual(['memory']);
  });

  it('full layer cascade — user file < user dir < repo file < repo dir < env', () => {
    // Same server name in every layer; expect last-wins.
    writeJson(path.join(homeDir, '.config', 'nanoclaw', 'mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'user-file' } },
    });
    writeJson(
      path.join(homeDir, '.config', 'nanoclaw', 'mcp.d', 'memory.json'),
      { mcpServers: { memory: { type: 'http', url: 'user-dir' } } },
    );
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'repo-file' } },
    });
    writeJson(path.join(cwd, '.mcp.d', 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'repo-dir' } },
    });
    writeJson(path.join(envExtra, 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'env' } },
    });
    const result = loadMcpServers({
      cwd,
      homeDir,
      envPath: envExtra,
      log,
    });
    expect(result.servers.memory).toEqual({
      type: 'http',
      url: 'env',
    });
  });

  it('empty NANOCLAW_MCP_CONFIG_PATH segments are tolerated', () => {
    writeJson(path.join(envExtra, 'memory.json'), {
      mcpServers: { memory: { type: 'http', url: 'env' } },
    });
    const result = loadMcpServers({
      cwd,
      homeDir,
      envPath: `::${envExtra}::`,
      log,
    });
    expect(result.servers.memory).toEqual({ type: 'http', url: 'env' });
  });

  it('records distinct provenance entries per overlay', () => {
    writeJson(path.join(homeDir, '.config', 'nanoclaw', 'mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'user' } },
    });
    writeJson(path.join(cwd, '.mcp.json'), {
      mcpServers: { memory: { type: 'http', url: 'repo' } },
    });
    const result = loadMcpServers({ cwd, homeDir, envPath: undefined, log });
    const memorySources = result.sources.filter((s) => s.name === 'memory');
    expect(memorySources.map((s) => s.origin)).toEqual([
      'user-file',
      'repo-file',
    ]);
  });
});
