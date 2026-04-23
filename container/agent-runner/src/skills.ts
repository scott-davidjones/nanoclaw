import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Skill-constraint loader and parser.
 *
 * Reads SKILL.md files from the standard skill directories inside the
 * agent container, extracts the optional `deniedCommands` frontmatter field
 * (array of regex strings), compiles each to a RegExp, and returns a map
 * keyed by skill name.
 *
 * Convention for authors:
 *   deniedCommands:
 *     - "(?:^|[\\s;|&])sudo(?:$|\\s)"
 *
 * Patterns are matched against the Bash tool's `command` input. Use command-
 * boundary anchors like `(?:^|[\s;|&])` + `(?:$|\s)` to match a bare token
 * rather than substring — `\bsudo\b` also matches `sudo-files` and similar
 * paths. See the tpp skill for a worked example.
 */

export interface ParsedSkillFrontmatter {
  name?: string;
  deniedCommands?: string[];
}

const DEFAULT_SKILL_DIRS = [
  '/home/node/.claude/skills',
  '/workspace/project/.claude/skills',
];

export function parseSkillFrontmatter(
  skillMdContent: string,
): ParsedSkillFrontmatter | null {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(\n|$)/.exec(skillMdContent);
  if (!match) return null;
  let data: unknown;
  try {
    data = yaml.load(match[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  let deniedCommands: string[] | undefined;
  if (Array.isArray(obj.deniedCommands)) {
    deniedCommands = obj.deniedCommands.filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return { name, deniedCommands };
}

export function loadSkillConstraints(
  skillDirs: string[] = DEFAULT_SKILL_DIRS,
  logFn: (msg: string) => void = () => {},
): Map<string, RegExp[]> {
  const map = new Map<string, RegExp[]>();
  for (const dir of skillDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillMdPath = path.join(dir, entry, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      let content: string;
      try {
        content = fs.readFileSync(skillMdPath, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(content);
      if (!parsed) continue;
      const { name, deniedCommands } = parsed;
      if (!name || !deniedCommands || deniedCommands.length === 0) continue;
      const compiled: RegExp[] = [];
      for (const pat of deniedCommands) {
        try {
          compiled.push(new RegExp(pat));
        } catch (err) {
          logFn(
            `Skill "${name}" has invalid deniedCommands regex ${JSON.stringify(pat)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (compiled.length === 0) continue;
      // Later dirs override earlier — last-write-wins per skill name.
      map.set(name, compiled);
      logFn(`Loaded ${compiled.length} denied pattern(s) for skill "${name}"`);
    }
  }
  return map;
}

/**
 * Pull the skill name from a Skill-tool invocation's input. Returns null if
 * the input isn't a Skill-tool payload. The Skill tool's input schema has a
 * `skill` string field.
 */
export function extractSkillName(input: unknown): string | null {
  if (input && typeof input === 'object' && 'skill' in input) {
    const v = (input as { skill?: unknown }).skill;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Pull the `command` string from a Bash-tool invocation's input.
 */
export function extractBashCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in input) {
    const v = (input as { command?: unknown }).command;
    if (typeof v === 'string') return v;
  }
  return null;
}
