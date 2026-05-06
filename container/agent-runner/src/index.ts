/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  ContentBlock,
  ToolUseBlock,
  extractAssistantText,
  extractThinkingText,
  extractToolUses,
  isEmptyAssistantResponse,
  summariseContent,
} from './content-blocks.js';
import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  extractBashCommand,
  extractSkillName,
  loadSkillConstraints,
} from './skills.js';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}

interface EmptyResponseInfo {
  model?: string;
  inputTokens?: number;
  thinkingPreview?: string;
  contentTypes: string[];
  timestamp: string;
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
}
interface TextContentBlock {
  type: 'text';
  text: string;
}
type UserContentBlock = ImageContentBlock | TextContentBlock;

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  emptyResponse?: EmptyResponseInfo;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | UserContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  pushMultimodal(content: UserContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * PreToolUse hook: enforce per-skill deniedCommands.
 *
 * When a Bash tool invocation is about to run inside a skill context, check
 * the skill's deniedCommands patterns. If any match the Bash `command`
 * string, deny with a reason the model sees on its next turn.
 *
 * Skill context is passed in via the `getActiveSkill` closure — the caller
 * (runQuery) updates activeSkillName eagerly when it sees Skill tool_use
 * blocks in assistant messages, so the getter returns the most recent skill
 * invocation's name by the time this hook fires.
 *
 * Only Bash is checked. Other tool types pass through unchanged even if
 * a skill declared matching patterns — the deniedCommands convention targets
 * Bash commands specifically.
 */
function createPreToolUseHook(
  skillConstraints: Map<string, RegExp[]>,
  getActiveSkill: () => string | null,
): HookCallback {
  return async (input) => {
    const hook = input as PreToolUseHookInput;
    if (hook.tool_name !== 'Bash') return {};

    const skillName = getActiveSkill();
    if (!skillName) return {};

    const patterns = skillConstraints.get(skillName);
    if (!patterns || patterns.length === 0) return {};

    const command = extractBashCommand(hook.tool_input);
    if (!command) return {};

    for (const pat of patterns) {
      if (pat.test(command)) {
        log(
          `PreToolUse DENY: skill="${skillName}" pattern=${pat} command="${command.slice(0, 200)}"`,
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Skill "${skillName}" forbids commands matching ${pat}. Stop the attempt, report the blocked operation to the user, and do not retry with variations.`,
          },
        };
      }
    }
    return {};
  };
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

/**
 * Patterns that mark a user request as "dev-shaped" — i.e. the kind of
 * thing that should be dispatched to Cypher via the Task tool rather than
 * answered directly by the orchestrator. Anchored on common verbs/phrasings
 * Scott actually uses; expand as we observe more failure modes.
 */
const DEV_REQUEST_PATTERNS: RegExp[] = [
  /\bcreate\s+(?:me\s+)?(?:a|an|the)?\s*\w*\s*skill\b/i,
  /\badd\s+(?:the\s+|an?\s+)?ability\s+to\b/i,
  /\bbuild\s+(?:me\s+)?(?:a|an|the)\b/i,
  /\bmake\s+(?:me\s+)?(?:a|an|the)\s+(?:script|tool|plugin|module|feature|skill|command|hook)\b/i,
  /\bimplement\s+\w/i,
  /\bfix\s+(?:the\s+)?(?:bug|issue|broken)\b/i,
  /\brefactor\b/i,
  /\bpromote\s+\w+\s+to\b/i,
  /\bport\s+\w+\s+to\b/i,
  /\bswitch\s+\w+\s+to\b/i,
  /\bworks?\s+but\s+I\s+want\b/i,
  /\b(?:write|develop|code)\s+(?:me\s+)?(?:a|an|the)\b/i,
  /\bopen\s+a\s+pr\b/i,
];

function isDevRequest(text: string): boolean {
  if (!text) return false;
  return DEV_REQUEST_PATTERNS.some((p) => p.test(text));
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text?: string } =>
          !!c && typeof c === 'object' && 'type' in c,
      )
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('');
  }
  return '';
}

/**
 * Block end-of-turn for dev-shaped user requests when no Task dispatch
 * happened. Soft rules in groups/global/CLAUDE.md are not enough: Gemma 4
 * (Artemis) repeatedly violates "Execute, don't narrate" by sending a
 * planning message and ending the turn. This hook reads the transcript at
 * Stop time, checks the most recent user message for dev-shaped patterns,
 * and if no `Task` tool_use happened since that message, blocks the stop
 * with a system message instructing the agent to dispatch.
 *
 * Only fires for the main orchestrator. Subagents (Cypher, Vector, etc.)
 * shouldn't dispatch Task themselves; they do the work.
 *
 * `stop_hook_active === true` means the hook is firing on a continuation
 * after a previous block; pass through to avoid infinite loops if the
 * agent still refuses to dispatch after one prompt.
 */
function createStopHook(isMain: boolean): HookCallback {
  return async (input) => {
    if (!isMain) return {};
    const stopInput = input as StopHookInput;
    if (stopInput.stop_hook_active) return {};

    const transcriptPath = stopInput.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    let entries: unknown[];
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      entries = content
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e): e is Record<string, unknown> => !!e);
    } catch {
      return {};
    }

    // Find the most recent user message (the request currently being answered).
    let lastUserIdx = -1;
    let lastUserText = '';
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type?: string; message?: { content?: unknown } };
      if (entry.type === 'user' && entry.message?.content) {
        const text = extractUserText(entry.message.content);
        if (text) {
          lastUserIdx = i;
          lastUserText = text;
          break;
        }
      }
    }
    if (lastUserIdx === -1) return {};
    if (!isDevRequest(lastUserText)) return {};

    // Find any dispatch tool_use after the last user message. Either the
    // SDK's native `Task` tool or one of our `dispatch_*` MCP tools (these
    // collapse the multi-step Task protocol into a single named call —
    // see container/agent-runner/src/ipc-mcp-stdio.ts) counts as a valid
    // dispatch. The MCP tool names arrive prefixed (`mcp__nanoclaw__...`).
    const isDispatchToolName = (name: string): boolean =>
      name === 'Task' ||
      name === 'mcp__nanoclaw__dispatch_cypher' ||
      name === 'mcp__nanoclaw__dispatch_vector' ||
      name === 'mcp__nanoclaw__dispatch_prism' ||
      name === 'mcp__nanoclaw__dispatch_sentinel' ||
      name === 'mcp__nanoclaw__dispatch_triage';
    const dispatched = entries.slice(lastUserIdx + 1).some((e) => {
      const entry = e as {
        type?: string;
        message?: { content?: unknown };
      };
      if (entry.type !== 'assistant') return false;
      if (!Array.isArray(entry.message?.content)) return false;
      return entry.message.content.some(
        (b: unknown) =>
          !!b &&
          typeof b === 'object' &&
          'type' in b &&
          (b as { type: string }).type === 'tool_use' &&
          'name' in b &&
          isDispatchToolName((b as { name: string }).name),
      );
    });
    if (dispatched) return {};

    log(
      `Stop hook: dev-shaped request with no dispatch — blocking turn end`,
    );
    return {
      decision: 'block' as const,
      reason:
        'You wrote a response without dispatching a subagent. This request looks like dev work (create a skill, add a feature, fix a bug, refactor, build, implement, promote, port, etc.) and per OPERATIONS.md "Capability Requests" your first action MUST be a dispatch. Call dispatch_cypher (or dispatch_vector / dispatch_prism / dispatch_sentinel / dispatch_triage as appropriate) NOW with the user request verbatim. The legacy Task tool also counts. Do not end this turn until a dispatch tool has been called.',
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Load image attachments and send as multimodal content blocks
  if (containerInput.imageAttachments?.length) {
    log(
      `Loading ${containerInput.imageAttachments.length} image attachment(s) for multimodal turn`,
    );
    const blocks: UserContentBlock[] = [];
    for (const img of containerInput.imageAttachments) {
      const imgPath = path.join('/workspace/group', img.relativePath);
      try {
        const data = fs.readFileSync(imgPath).toString('base64');
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as ImageMediaType,
            data,
          },
        });
        log(`Loaded image ${img.relativePath} (${data.length} base64 chars)`);
      } catch (err) {
        log(`Failed to load image: ${imgPath}`);
      }
    }
    if (blocks.length > 0) {
      stream.pushMultimodal(blocks);
      log(`Pushed ${blocks.length} image block(s) as multimodal user message`);
    }
  }

  // Single-shot mode for dispatched subagents — they receive one prompt
  // and exit. End the stream immediately after the prompt is queued so the
  // SDK iterator terminates after processing the initial turn rather than
  // looping forever waiting for follow-up IPC messages. Without this, the
  // subagent container hangs after emitting its OUTPUT marker; the host
  // has to SIGKILL it, which produces exit code 137 and used to surface
  // to the user as "subagent failed". The host has a fallback that
  // honours a parsed success result over a non-zero exit, but this is
  // the proper fix.
  const subagentSingleShot = !!process.env.NANOCLAW_SUBAGENT_NAME;
  let ipcPolling = !subagentSingleShot;
  let closedDuringQuery = false;
  if (subagentSingleShot) {
    log(
      `Subagent single-shot mode (NANOCLAW_SUBAGENT_NAME=${process.env.NANOCLAW_SUBAGENT_NAME}) — ending stream after initial prompt`,
    );
    stream.end();
  } else {
    // Multi-turn mode (orchestrator + sub-channel groups) — poll IPC for
    // follow-up messages and the _close sentinel during the query.
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
    };
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  }

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  // Loop-break guard. See src/config.ts MAX_TOOL_CALLS_PER_TURN for rationale.
  // Counter is per-turn (per runQuery) and does NOT reset on compaction —
  // the 2026-04-23 incident looped past compaction, so resetting would defeat
  // the guard.
  const maxToolUses = Math.max(
    1,
    parseInt(process.env.NANOCLAW_MAX_TOOL_CALLS_PER_TURN || '40', 10) || 40,
  );
  let toolUseCount = 0;
  const recentToolCalls: Array<{ name: string; input: string }> = [];
  // Per-turn skill-context scope: reset on every runQuery entry. If the
  // model invokes Skill(X) then does unrelated work later in the same turn,
  // X's deniedCommands still apply; next turn starts fresh.
  let activeSkillName: string | null = null;
  const skillConstraints = loadSkillConstraints(undefined, log);
  if (skillConstraints.size > 0) {
    log(
      `Skill constraints loaded: ${Array.from(skillConstraints.keys()).join(', ')}`,
    );
  }
  // Safety-net text buffer — see extractAssistantText's docstring for the
  // scope / constraints. Only used when the SDK's own result.result is empty.
  let assistantTextFallback = '';
  // Capture latest assistant turn metadata for empty-response diagnostics.
  let lastAssistantContent: ContentBlock[] | undefined;
  let lastAssistantModel: string | undefined;
  let lastAssistantInputTokens: number | undefined;
  const logRawLlm = process.env.LOG_RAW_LLM_RESPONSES === '1';

  // System-prompt append. Two mutually-exclusive sources:
  //   - Main agent: brain/standards/ARTEMIS.md persona (orchestrator voice).
  //     Deliberately excludes brain/CLAUDE.md — those are hard engineering
  //     standards for sub-agents (Cypher/Vector/etc), not Artemis.
  //   - Non-main agents: groups/global/CLAUDE.md shared context.
  let systemPromptAppend: string | undefined;
  if (containerInput.isMain) {
    const artemisPersonaPath = '/workspace/brain/standards/ARTEMIS.md';
    if (fs.existsSync(artemisPersonaPath)) {
      systemPromptAppend = fs.readFileSync(artemisPersonaPath, 'utf-8');
      log(
        `Loaded Artemis persona from ${artemisPersonaPath} (${systemPromptAppend.length} chars)`,
      );
    } else {
      log(
        `Artemis persona not found at ${artemisPersonaPath} — main agent will use SDK defaults only`,
      );
    }
  } else {
    const brainAgentsDir =
      process.env.BRAIN_AGENTS_DIR || '/workspace/brain/standards/agents';
    const subagentName = process.env.NANOCLAW_SUBAGENT_NAME;

    if (subagentName) {
      // Dispatched subagent (Cypher / Vector / Prism / Sentinel / Triage):
      // load persona = BASE_SOUL + BASE_AGENTS + <agent>.md (frontmatter
      // stripped). The model alias was already parsed host-side and is
      // present in ANTHROPIC_MODEL — the agent-runner doesn't re-resolve it.
      const fileMap: Record<string, string> = {
        cypher: 'developer.md',
        vector: 'tester.md',
        prism: 'ui-tester.md',
        sentinel: 'reviewer.md',
        triage: 'triage.md',
      };
      const file = fileMap[subagentName];
      if (!file) {
        log(
          `Unknown NANOCLAW_SUBAGENT_NAME=${subagentName} — falling through to operations path`,
        );
      } else {
        const personaPath = path.join(brainAgentsDir, file);
        const baseAgentsPath = path.join(brainAgentsDir, 'BASE_AGENTS.md');
        const baseSoulPath = path.join(brainAgentsDir, 'BASE_SOUL.md');
        const parts: string[] = [];
        if (fs.existsSync(baseSoulPath)) {
          parts.push(fs.readFileSync(baseSoulPath, 'utf-8'));
        }
        if (fs.existsSync(baseAgentsPath)) {
          parts.push(fs.readFileSync(baseAgentsPath, 'utf-8'));
        }
        if (fs.existsSync(personaPath)) {
          const raw = fs.readFileSync(personaPath, 'utf-8');
          // Strip leading YAML frontmatter (--- ... ---) — the host already
          // parsed model from it, the body is what the SDK needs.
          const stripped = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
          parts.push(stripped);
        } else {
          log(
            `Subagent persona missing at ${personaPath} — proceeding with BASE files only`,
          );
        }
        if (parts.length > 0) {
          systemPromptAppend = parts.join('\n\n---\n\n');
          log(
            `Loaded subagent persona for "${subagentName}" (${systemPromptAppend.length} chars)`,
          );
        }
      }
    }

    if (!systemPromptAppend) {
      // Default sub-channel agents (WhatsApp/Slack/Discord groups not
      // dispatched as named subagents) get the operational rules — dispatch
      // protocol, memory hygiene, channel formatting. Canonical home is the
      // brain repo at $BRAIN_AGENTS_DIR/OPERATIONS.md. Falls back to the
      // pre-migration nanoclaw path during rollout; remove the fallback
      // once Phase 1.5 deletes originals from nanoclaw.
      const operationsPath = path.join(brainAgentsDir, 'OPERATIONS.md');
      const legacyOperationsPath = '/workspace/global/CLAUDE.md';
      if (fs.existsSync(operationsPath)) {
        systemPromptAppend = fs.readFileSync(operationsPath, 'utf-8');
        log(
          `Loaded operations from ${operationsPath} (${systemPromptAppend.length} chars)`,
        );
      } else if (fs.existsSync(legacyOperationsPath)) {
        systemPromptAppend = fs.readFileSync(legacyOperationsPath, 'utf-8');
        log(
          `Loaded operations from ${legacyOperationsPath} (legacy path) (${systemPromptAppend.length} chars)`,
        );
      } else {
        log(
          `Operations file not found at ${operationsPath} or legacy path — sub-agent will use SDK defaults only`,
        );
      }
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: systemPromptAppend
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: systemPromptAppend,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__memory__*',
        'mcp__qmd__*',
      ],
      // Block session-only / unreachable SDK built-ins so they never reach
      // the model's tool list. The SDK injects them by default; without an
      // explicit deny they show up in the system prompt and the model can
      // pick them — see the Gemma/CronCreate incident where TPP's
      // schedule_task was substituted with the in-session-only CronCreate
      // and the follow-up check silently never fired.
      //
      // Cron*: SDK's session-scoped scheduler. Doesn't survive container
      //   exit and isn't backed by NanoClaw's task scheduler. Use
      //   mcp__nanoclaw__schedule_task instead.
      // EnterWorktree / ExitWorktree: SDK feature for opening parallel git
      //   worktrees in the host's terminal — meaningless inside a single
      //   short-lived container.
      // RemoteTrigger: calls the claude.ai CCR API and requires a
      //   claude.ai OAuth token, which containers don't have (auth runs
      //   through OneCLI → LiteLLM with placeholder ANTHROPIC_API_KEY).
      //   Unreachable from this environment.
      // EnterPlanMode / ExitPlanMode kept allowed — legitimate
      //   orchestration capability.
      disallowedTools: [
        'CronCreate',
        'CronList',
        'CronDelete',
        'EnterWorktree',
        'ExitWorktree',
        'RemoteTrigger',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(process.env.MCP_MEMORY_URL ? {
          memory: {
            type: 'http' as const,
            url: process.env.MCP_MEMORY_URL,
          },
        } : {}),
        qmd: {
          type: 'http',
          url: 'http://host.docker.internal:8182/mcp',
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
        PreToolUse: [
          {
            hooks: [
              createPreToolUseHook(skillConstraints, () => activeSkillName),
            ],
          },
        ],
        Stop: [
          { hooks: [createStopHook(containerInput.isMain)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      const betaMessage = (message as { message?: unknown }).message;
      const content = (betaMessage as { content?: unknown })?.content as
        | ContentBlock[]
        | undefined;
      assistantTextFallback += extractAssistantText(content);
      lastAssistantContent = content;
      const model = (betaMessage as { model?: string }).model;
      if (typeof model === 'string' && model.length > 0) {
        lastAssistantModel = model;
      }
      const usage = (betaMessage as { usage?: { input_tokens?: number } })
        .usage;
      if (typeof usage?.input_tokens === 'number') {
        lastAssistantInputTokens = usage.input_tokens;
      }
      const summary = summariseContent(content);
      log(
        `Assistant content: blocks=${summary.count} types=[${summary.types.join(',')}] textChars=${summary.textLength}`,
      );
      if (logRawLlm) {
        try {
          log(`Assistant raw: ${JSON.stringify(betaMessage)}`);
        } catch {
          /* ignore serialise failure */
        }
      }

      // Loop-break guard: count tool_use blocks, throw at threshold.
      // Eager skill-context scan: if any block is a Skill-tool invocation,
      // update activeSkillName synchronously so the PreToolUse hook for any
      // sibling tool in this same message (or subsequent messages in this
      // turn) sees the current skill context.
      const toolUses: ToolUseBlock[] = extractToolUses(content);
      for (const call of toolUses) {
        toolUseCount++;
        let inputPreview = '';
        try {
          inputPreview = JSON.stringify(call.input).slice(0, 200);
        } catch {
          inputPreview = String(call.input).slice(0, 200);
        }
        recentToolCalls.push({ name: call.name, input: inputPreview });
        if (recentToolCalls.length > 10) recentToolCalls.shift();
        if (call.name === 'Skill') {
          const skillName = extractSkillName(call.input);
          if (skillName) {
            activeSkillName = skillName;
            log(`Active skill set to "${skillName}"`);
          }
        }
      }
      if (toolUseCount >= maxToolUses) {
        log(
          `LOOP GUARD TRIPPED: ${toolUseCount} tool calls in one turn (max=${maxToolUses}). Last ${recentToolCalls.length}:`,
        );
        for (const [i, c] of recentToolCalls.entries()) {
          log(`  [${i + 1}] ${c.name}: ${c.input}`);
        }
        stream.end();
        ipcPolling = false;
        throw new Error(
          `Agent got stuck in a loop after ${toolUseCount} tool calls. Retry with more specific direction or break the task into smaller steps.`,
        );
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      const finalText = textResult || assistantTextFallback || null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${finalText ? ` text=${finalText.slice(0, 200)}` : ''}${!textResult && assistantTextFallback ? ' (from assistant fallback)' : ''}`,
      );

      // Empty-response guard: local models (qwen3 via LiteLLM) occasionally
      // emit a thinking block with text:"" and no tool_use, which produces
      // complete silence for the user. Detect and surface a sentinel so
      // the host can notify the user instead of failing silently.
      if (!finalText && isEmptyAssistantResponse(lastAssistantContent)) {
        const thinking = extractThinkingText(lastAssistantContent);
        const summary = summariseContent(lastAssistantContent);
        log(
          `EMPTY RESPONSE detected: model=${lastAssistantModel || 'unknown'} inputTokens=${lastAssistantInputTokens ?? 'unknown'} thinkingChars=${thinking.length} types=[${summary.types.join(',')}]`,
        );
        if (thinking) {
          log(`Empty-response thinking content: ${thinking}`);
        }
        writeOutput({
          status: 'success',
          result: null,
          newSessionId,
          emptyResponse: {
            model: lastAssistantModel,
            inputTokens: lastAssistantInputTokens,
            thinkingPreview: thinking ? thinking.slice(0, 500) : undefined,
            contentTypes: summary.types,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        writeOutput({
          status: 'success',
          result: finalText,
          newSessionId,
        });
      }
      assistantTextFallback = '';
      lastAssistantContent = undefined;
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );

  // Subagent single-shot fallback: when the SDK iterator ends without
  // emitting a `result` event (observed for stream.end()-immediately
  // queries — the SDK skips the result wrap-up in single-user-turn
  // mode), the OUTPUT marker is never written and runSubagentContainer
  // can't parse a result. The user then sees the
  // "<agent> completed without final text" placeholder even though
  // the assistant did emit a real reply.
  //
  // Emit a synthetic OUTPUT block here using the accumulated assistant
  // text fallback. Only fires when (a) we're a subagent in single-shot
  // mode AND (b) no result event was processed during the loop.
  if (subagentSingleShot && resultCount === 0) {
    log(
      `Subagent single-shot: no SDK result event — emitting fallback OUTPUT (${assistantTextFallback.length} chars)`,
    );
    writeOutput({
      status: 'success',
      result: assistantTextFallback || null,
      newSessionId,
    });
  }

  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW fallback. Normal deployments receive
  // this from the orchestrator via NANOCLAW_AUTO_COMPACT_WINDOW env var
  // (see src/config.ts AUTO_COMPACT_WINDOW). The inline default exists
  // as a safety net for direct container invocations that bypass the
  // orchestrator.
  const sdkEnv: Record<string, string | undefined> = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '60000',
    ...process.env,
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
