import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { loadSkillConstraints } from '../container/agent-runner/src/skills.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'container', 'skills');

describe('tpp skill — deniedCommands integration (real SKILL.md)', () => {
  const constraints = loadSkillConstraints([SKILLS_DIR]);

  it('loads tpp constraints from the real SKILL.md frontmatter', () => {
    expect(constraints.has('tpp')).toBe(true);
    expect(constraints.get('tpp')!.length).toBeGreaterThan(0);
  });

  it('blocks bare sudo invocations', () => {
    const blocked = (cmd: string) =>
      constraints.get('tpp')!.some((r) => r.test(cmd));
    expect(blocked('sudo apt update')).toBe(true);
    expect(blocked('ls && sudo rm -rf /tmp/x')).toBe(true);
    expect(blocked('(sudo poweroff)')).toBe(true);
  });

  it('blocks sudo nested inside an ssh command quoted argument', () => {
    const blocked = (cmd: string) =>
      constraints.get('tpp')!.some((r) => r.test(cmd));
    expect(blocked('ssh -i k user@host "sudo systemctl restart x"')).toBe(true);
    expect(
      blocked('ssh user@host "cd /home/deploy && sudo cat /etc/shadow"'),
    ).toBe(true);
  });

  it('does not block legitimate commands that merely contain "sudo"', () => {
    const blocked = (cmd: string) =>
      constraints.get('tpp')!.some((r) => r.test(cmd));
    expect(blocked('cat /etc/sudoers')).toBe(false);
    expect(blocked('which my-sudo-tool')).toBe(false);
    expect(blocked('echo sudoers')).toBe(false);
    expect(blocked('echo "sudo" is a word')).toBe(true); // quoted token still matches — by design
  });

  it('only applies to the tpp skill — non-skill Bash invocations are unconstrained', () => {
    // The PreToolUse hook returns {} (no decision) when getActiveSkill()
    // returns null. Constraints are only consulted under a skill context,
    // so any Bash invocation outside a Skill() call passes through, even
    // ones that match a registered pattern.
    //
    // This test asserts the *contract*: there is no other skill in the
    // map that would catch sudo in the non-tpp case.
    for (const [name, patterns] of constraints) {
      if (name === 'tpp') continue;
      const anyBlocksSudo = patterns.some((r) => r.test('sudo apt'));
      expect(
        anyBlocksSudo,
        `unexpected: skill "${name}" also blocks sudo`,
      ).toBe(false);
    }
  });
});
