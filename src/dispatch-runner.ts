/**
 * Subagent dispatch handler.
 *
 * The agent-runner side `dispatch_*` MCP tools (Phase 3) write a JSON
 * task into `data/ipc/<group>/dispatches/`. The IPC watcher in `ipc.ts`
 * picks the file up and calls `processDispatchIpc` here. This module:
 *
 *   1. Validates the agent name (must be one of the known five).
 *   2. Resolves agent → persona file (e.g. cypher → developer.md) and
 *      reads the `model` from YAML frontmatter.
 *   3. Reads optional context_files into a prepended block on the prompt.
 *   4. Spawns a subagent container via `runSubagentContainer` with the
 *      right model + NANOCLAW_SUBAGENT_NAME so the agent-runner loads
 *      the persona automatically.
 *   5. On completion, logs the result and (if `pipeline=true`) sends a
 *      synthetic follow-up message to the originating group.
 *
 * Pipeline=false (default for one-off dispatches): subagent reports its
 * own progress and final result directly to the user via
 * `mcp__nanoclaw__send_message`. Orchestrator never sees the result.
 *
 * Pipeline=true (for orchestrator-driven Cypher → Vector → Sentinel runs):
 * after subagent exits, the dispatcher writes a synthetic [DISPATCH_RESULT]
 * message to the originating group's IPC inbox so the orchestrator's next
 * turn picks up the result and advances the pipeline. **Wake-up integration
 * is currently a TODO** — the message gets queued via group-queue
 * `sendMessage` if a container is active; if the orchestrator's container
 * has already ended its turn the message will sit until the orchestrator
 * is woken by something else. Full wake-up handling lives in Phase 2.5.
 */

import fs from 'fs';
import path from 'path';

import { runSubagentContainer } from './container-runner.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

/**
 * Stable mapping from public dispatch tool names (the five we expose to
 * the model) to the persona filename inside `$BRAIN_AGENTS_DIR`. The host
 * resolves this so the MCP tool side just carries the agent name.
 */
const AGENT_PERSONA_FILES: Record<string, string> = {
  cypher: 'developer.md',
  vector: 'tester.md',
  prism: 'ui-tester.md',
  sentinel: 'reviewer.md',
  triage: 'triage.md',
};

/** Set of valid agent identifiers — for type-narrowing input validation. */
export const KNOWN_AGENTS = Object.freeze(
  Object.keys(AGENT_PERSONA_FILES) as ReadonlyArray<keyof typeof AGENT_PERSONA_FILES>,
);

export interface DispatchTask {
  type: 'dispatch';
  dispatch_id: string;
  agent: string;
  task_description: string;
  context_files?: string[];
  pipeline?: boolean;
  originating_group: string;
  chat_jid: string;
  timestamp: string;
}

export interface DispatchResult {
  dispatch_id: string;
  agent: string;
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  durationMs: number;
}

export interface DispatchDeps {
  /**
   * Host path to the brain repo's agents directory. Subagent personas and
   * BASE_*.md live here. Defaults from BRAIN_ROOT env if not provided.
   */
  brainAgentsHostDir: string;
  /**
   * Look up a registered group by folder name. The dispatch needs the
   * group's full RegisteredGroup record (jid, name, etc.) to spawn the
   * subagent container with the right mounts.
   */
  resolveGroup: (folder: string) => RegisteredGroup | null;
  /**
   * Send a synthetic follow-up message to the originating group when
   * `pipeline=true`. Should write to `data/ipc/<group>/input/` so an
   * active orchestrator container picks it up via stdin pipe.
   * Returns true if the message was queued, false if no active container.
   */
  pipeFollowUp?: (groupJid: string, text: string) => boolean;
}

/**
 * Strip a leading frontmatter block (--- ... ---) and parse it. Subagent
 * frontmatters in this codebase only ever carry simple scalar key:value
 * pairs (model, name, etc.), so we parse with a small regex instead of
 * pulling js-yaml into the host's deps. Lines that don't match are
 * silently skipped — same lenient behaviour as a real YAML parser would
 * give for our usage.
 */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) {
      // Strip surrounding quotes, leave embedded characters alone.
      frontmatter[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  const body = content.slice(match[0].length);
  return { frontmatter, body };
}

/**
 * Validate an incoming dispatch IPC payload. Returns null if invalid (with
 * a logged error so the host can move the file to the IPC errors dir).
 */
export function validateDispatchTask(data: unknown): DispatchTask | null {
  if (!data || typeof data !== 'object') return null;
  const t = data as Partial<DispatchTask>;
  if (t.type !== 'dispatch') return null;
  if (typeof t.dispatch_id !== 'string' || !t.dispatch_id) return null;
  if (typeof t.agent !== 'string' || !(t.agent in AGENT_PERSONA_FILES))
    return null;
  if (typeof t.task_description !== 'string' || !t.task_description) return null;
  if (typeof t.originating_group !== 'string' || !t.originating_group)
    return null;
  if (typeof t.chat_jid !== 'string' || !t.chat_jid) return null;
  return {
    type: 'dispatch',
    dispatch_id: t.dispatch_id,
    agent: t.agent,
    task_description: t.task_description,
    context_files: Array.isArray(t.context_files) ? t.context_files : [],
    pipeline: t.pipeline === true,
    originating_group: t.originating_group,
    chat_jid: t.chat_jid,
    timestamp: typeof t.timestamp === 'string' ? t.timestamp : new Date().toISOString(),
  };
}

/**
 * Read the persona for a known agent. Returns the model alias parsed from
 * frontmatter (or 'sonnet' as a permissive default if unset). Body is not
 * returned — the agent-runner reads the file again container-side after
 * frontmatter is stripped. Frontmatter parsing here is purely so the host
 * knows what to set ANTHROPIC_MODEL to before spawning.
 */
export function readPersonaModel(
  brainAgentsHostDir: string,
  agent: string,
): { model: string; personaPath: string } | { error: string } {
  const file = AGENT_PERSONA_FILES[agent];
  if (!file) return { error: `Unknown agent: ${agent}` };
  const personaPath = path.join(brainAgentsHostDir, file);
  if (!fs.existsSync(personaPath)) {
    return { error: `Persona file not found at ${personaPath}` };
  }
  let content: string;
  try {
    content = fs.readFileSync(personaPath, 'utf-8');
  } catch (err) {
    return {
      error: `Failed to read persona at ${personaPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { frontmatter } = splitFrontmatter(content);
  const model =
    typeof frontmatter.model === 'string' && frontmatter.model
      ? frontmatter.model
      : 'sonnet';
  return { model, personaPath };
}

/**
 * Build the prompt that goes into the subagent container. Prepends any
 * context_files content as a `<context>` block so Cypher/Vector/etc. see
 * the orchestrator's hints without having to re-discover them.
 */
export function buildSubagentPrompt(
  taskDescription: string,
  contextFiles: string[] = [],
  brainAgentsHostDir: string,
): string {
  if (contextFiles.length === 0) return taskDescription;
  const blocks: string[] = ['<context>'];
  for (const ref of contextFiles) {
    // Only allow paths under known mount roots. brainAgentsHostDir's parent
    // is the brain mount; /workspace/group/ is the per-group writable root.
    // Reject anything else as a precaution against path traversal.
    const safeRoots = [
      brainAgentsHostDir,
      '/workspace/group',
      '/workspace/brain',
      '/workspace/project',
    ];
    const resolved = path.resolve(ref);
    const allowed = safeRoots.some((root) =>
      resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!allowed) {
      blocks.push(`<file path="${ref}" status="skipped" reason="outside-allowed-roots"/>`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      blocks.push(`<file path="${ref}" status="missing"/>`);
      continue;
    }
    try {
      const body = fs.readFileSync(resolved, 'utf-8');
      blocks.push(`<file path="${ref}">\n${body}\n</file>`);
    } catch (err) {
      blocks.push(
        `<file path="${ref}" status="read-error" reason="${err instanceof Error ? err.message : String(err)}"/>`,
      );
    }
  }
  blocks.push('</context>', '', taskDescription);
  return blocks.join('\n');
}

/**
 * Process a dispatch IPC payload end-to-end: validate, resolve persona,
 * spawn subagent container, return result. Caller is responsible for
 * deleting the IPC file on success or moving it to errors/ on failure.
 */
export async function processDispatchIpc(
  data: unknown,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const startTime = Date.now();
  const task = validateDispatchTask(data);

  if (!task) {
    return {
      dispatch_id: 'unknown',
      agent: 'unknown',
      status: 'error',
      result: null,
      error: 'Invalid dispatch payload — missing required fields or unknown agent',
      durationMs: 0,
    };
  }

  const personaResult = readPersonaModel(deps.brainAgentsHostDir, task.agent);
  if ('error' in personaResult) {
    logger.error(
      { dispatch_id: task.dispatch_id, agent: task.agent, error: personaResult.error },
      'Dispatch persona resolution failed',
    );
    return {
      dispatch_id: task.dispatch_id,
      agent: task.agent,
      status: 'error',
      result: null,
      error: personaResult.error,
      durationMs: Date.now() - startTime,
    };
  }

  const group = deps.resolveGroup(task.originating_group);
  if (!group) {
    return {
      dispatch_id: task.dispatch_id,
      agent: task.agent,
      status: 'error',
      result: null,
      error: `Originating group not registered: ${task.originating_group}`,
      durationMs: Date.now() - startTime,
    };
  }

  const prompt = buildSubagentPrompt(
    task.task_description,
    task.context_files,
    deps.brainAgentsHostDir,
  );

  logger.info(
    {
      dispatch_id: task.dispatch_id,
      agent: task.agent,
      model: personaResult.model,
      group: group.name,
      pipeline: task.pipeline,
      promptChars: prompt.length,
    },
    'Dispatching subagent',
  );

  const containerResult = await runSubagentContainer({
    group,
    chatJid: task.chat_jid,
    subagentName: task.agent,
    model: personaResult.model,
    prompt,
    dispatchId: task.dispatch_id,
  });

  const result: DispatchResult = {
    dispatch_id: task.dispatch_id,
    agent: task.agent,
    status: containerResult.status,
    result: containerResult.result,
    error: containerResult.error,
    durationMs: Date.now() - startTime,
  };

  // Pipeline mode: notify the originating orchestrator so it can advance
  // to the next stage. Currently best-effort — pipeFollowUp returns false
  // if the orchestrator's container isn't active. Full wake-up (spawn
  // a fresh orchestrator turn when no container is active) is a Phase 2.5
  // task; for now if the orchestrator's gone, the result lands in the
  // log + the user already saw the subagent's send_message stream.
  if (task.pipeline && deps.pipeFollowUp) {
    const summary =
      result.status === 'success'
        ? `[DISPATCH_RESULT] ${task.agent} completed (id=${task.dispatch_id})\n\n${result.result || '(no final text emitted)'}`
        : `[DISPATCH_RESULT] ${task.agent} FAILED (id=${task.dispatch_id})\n\n${result.error || 'unknown error'}`;
    const queued = deps.pipeFollowUp(task.chat_jid, summary);
    if (!queued) {
      logger.warn(
        { dispatch_id: task.dispatch_id, group: group.name },
        'Pipeline follow-up not queued — orchestrator container not active. TODO: spawn a fresh turn so the pipeline advances.',
      );
    }
  }

  return result;
}
