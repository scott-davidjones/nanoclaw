/**
 * MCP server configuration loader.
 *
 * Aggregates MCP server definitions from a layered set of locations so skills
 * (and the user) can add servers without editing core files. Layers (later
 * overlays earlier on name conflicts):
 *
 *   1. User:  ~/.config/nanoclaw/mcp.json + ~/.config/nanoclaw/mcp.d/*.json
 *   2. Repo:  <cwd>/.mcp.json            + <cwd>/.mcp.d/*.json
 *   3. Env:   each path in NANOCLAW_MCP_CONFIG_PATH (colon-separated). A path
 *             that points at a file is loaded directly; a directory is scanned
 *             for *.json. Env paths layer in the order they appear.
 *
 * Each JSON file is expected to look like a partial Claude Code MCP config:
 *
 *   { "mcpServers": { "memory": { "type": "http", "url": "..." } } }
 *
 * Files missing the `mcpServers` key contribute nothing (we don't crash); files
 * with malformed JSON are logged and skipped. Within a directory, files are
 * loaded in lexicographic order — later files in the same directory win on
 * conflicts (mirrors nginx conf.d / systemd .d behaviour).
 *
 * The loader runs on the host (inside the nanoclaw process). The resolved
 * server map is serialised into ContainerInput.extraMcpServers and merged with
 * the runtime-bound built-ins inside the agent-runner. Symlinks in the layer
 * directories work transparently — point them at brain repo files for shared
 * canonical configs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * MCP server config shape. Matches the Claude Agent SDK's mcpServers value.
 * Kept intentionally loose — we don't validate beyond "object with strings" so
 * we can pass new SDK fields through without churn.
 */
export type McpServerConfig = {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** Per-server provenance — useful for debug logging. */
export interface McpServerSource {
  name: string;
  origin: 'user-file' | 'user-dir' | 'repo-file' | 'repo-dir' | 'env';
  path: string;
}

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
  sources: McpServerSource[];
}

type Logger = (msg: string) => void;

/**
 * One entry in the search order. `kind` distinguishes single-file from
 * directory-scan locations so we can read mcp.json before mcp.d/*.json at
 * the same layer.
 */
interface SearchEntry {
  origin: McpServerSource['origin'];
  kind: 'file' | 'dir';
  path: string;
}

/**
 * Build the ordered list of locations to scan. Order is significant — earlier
 * entries are overlaid by later ones on name conflict.
 */
function buildSearchOrder(opts: {
  cwd: string;
  homeDir: string;
  envPath: string | undefined;
}): SearchEntry[] {
  const { cwd, homeDir, envPath } = opts;
  const entries: SearchEntry[] = [];

  // Layer 1: user
  const userBase = path.join(homeDir, '.config', 'nanoclaw');
  entries.push({
    origin: 'user-file',
    kind: 'file',
    path: path.join(userBase, 'mcp.json'),
  });
  entries.push({
    origin: 'user-dir',
    kind: 'dir',
    path: path.join(userBase, 'mcp.d'),
  });

  // Layer 2: repo (cwd)
  entries.push({
    origin: 'repo-file',
    kind: 'file',
    path: path.join(cwd, '.mcp.json'),
  });
  entries.push({
    origin: 'repo-dir',
    kind: 'dir',
    path: path.join(cwd, '.mcp.d'),
  });

  // Layer 3: env-extra
  if (envPath && envPath.trim()) {
    for (const raw of envPath.split(':')) {
      const p = raw.trim();
      if (!p) continue;
      // Decide file vs dir at scan time (the path may not exist yet); default
      // to dir-scan if the path lacks a .json suffix, file otherwise. This is
      // a heuristic, but `*.json` suffixed entries are almost always meant to
      // be single files and bare paths are almost always meant to be dirs.
      const kind: SearchEntry['kind'] = p.toLowerCase().endsWith('.json')
        ? 'file'
        : 'dir';
      entries.push({ origin: 'env', kind, path: p });
    }
  }

  return entries;
}

/**
 * Read and parse one JSON file. Returns the partial mcpServers map (possibly
 * empty). Malformed files log and return empty rather than throwing — a single
 * bad file shouldn't take the whole nanoclaw process down.
 */
function readMcpFile(
  filePath: string,
  log: Logger | undefined,
): Record<string, McpServerConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    // ENOENT is expected (optional files). Other errors get logged.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      log?.(
        `mcp-config: failed to read ${filePath}: ${(err as Error).message}`,
      );
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    log?.(`mcp-config: invalid JSON in ${filePath}: ${(err as Error).message}`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object') {
    log?.(`mcp-config: ${filePath} is not an object — ignoring`);
    return {};
  }

  const obj = parsed as { mcpServers?: unknown };
  const servers = obj.mcpServers;

  if (servers === undefined) {
    // Empty or {} mcp config — that's fine. Loader treats absence as zero
    // contribution; matches Claude Code's own .mcp.json default shape.
    return {};
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    log?.(
      `mcp-config: ${filePath}: mcpServers must be an object map — ignoring`,
    );
    return {};
  }

  // Shallow clone so callers don't mutate the parsed JSON.
  return { ...(servers as Record<string, McpServerConfig>) };
}

/**
 * Read a directory of *.json files in lexicographic order, merging later files
 * over earlier ones. Symlinks resolve transparently — point them at the brain
 * repo if you want shared canonical files.
 */
function readMcpDir(
  dirPath: string,
  log: Logger | undefined,
): Array<{ file: string; servers: Record<string, McpServerConfig> }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log?.(`mcp-config: failed to scan ${dirPath}: ${(err as Error).message}`);
    }
    return [];
  }

  const jsonFiles = entries
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();

  const out: Array<{ file: string; servers: Record<string, McpServerConfig> }> =
    [];
  for (const name of jsonFiles) {
    const filePath = path.join(dirPath, name);
    // Skip directories that happen to end in .json — symlinks to files are OK.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ file: filePath, servers: readMcpFile(filePath, log) });
  }
  return out;
}

/**
 * Load and merge MCP server config from the layered search order.
 *
 * Caller normally passes `cwd: process.cwd()` (the nanoclaw project root). The
 * `homeDir` and `envPath` overrides exist for tests; in production they default
 * to the current user's home directory and `process.env.NANOCLAW_MCP_CONFIG_PATH`.
 */
export function loadMcpServers(opts: {
  cwd: string;
  homeDir?: string;
  envPath?: string;
  log?: Logger;
}): LoadedMcpConfig {
  const homeDir = opts.homeDir ?? os.homedir();
  const envPath = opts.envPath ?? process.env.NANOCLAW_MCP_CONFIG_PATH;
  const log = opts.log;

  const entries = buildSearchOrder({ cwd: opts.cwd, homeDir, envPath });

  const merged: Record<string, McpServerConfig> = {};
  const sources: McpServerSource[] = [];

  for (const entry of entries) {
    if (entry.kind === 'file') {
      const servers = readMcpFile(entry.path, log);
      for (const [name, cfg] of Object.entries(servers)) {
        merged[name] = cfg;
        sources.push({ name, origin: entry.origin, path: entry.path });
      }
    } else {
      const dirEntries = readMcpDir(entry.path, log);
      for (const { file, servers } of dirEntries) {
        for (const [name, cfg] of Object.entries(servers)) {
          merged[name] = cfg;
          sources.push({ name, origin: entry.origin, path: file });
        }
      }
    }
  }

  return { servers: merged, sources };
}
