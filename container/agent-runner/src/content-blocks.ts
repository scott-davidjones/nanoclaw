/**
 * Extract user-visible text from an assistant message's content array.
 *
 * Used as a safety-net when the SDK's pre-extracted `result.result` comes
 * through empty — some upstreams (notably reasoning models behind LiteLLM
 * aliases like `triage`/`haiku`) emit content arrays where a `thinking`
 * block precedes the `text` block, and if the SDK assumes `content[0]`
 * is the user-facing text, the result string lands empty.
 *
 * SCOPE: this function returns *user-facing text only*. Never call it on
 * content you plan to replay into the SDK as a subsequent-turn prompt —
 * that path must preserve `tool_use` / `tool_result` / `thinking` blocks
 * intact so the model can continue its tool chain. For that case, use an
 * exclusion-based filter (e.g. `block.type !== 'thinking'`) instead.
 */
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

export function extractAssistantText(
  content: ContentBlock[] | undefined | null,
): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

/**
 * Detect whether an assistant content array is a "dead" response — one
 * the user cannot see. Some local models (e.g. qwen3 behind LiteLLM) emit
 * a thinking block followed by `text: ""` with no tool_use, producing
 * complete silence for the user.
 *
 * Empty = no tool_use AND no text block with non-whitespace content.
 * Thinking blocks alone don't count — the user can't see those.
 *
 * Returns false for non-arrays and empty arrays so callers don't spuriously
 * flag "no assistant turn yet" as a failure.
 */
export function isEmptyAssistantResponse(
  content: ContentBlock[] | undefined | null,
): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  for (const block of content) {
    if (!block || typeof block.type !== 'string') continue;
    if (block.type === 'tool_use') return false;
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Extract concatenated thinking-block content for diagnostic logging when
 * a response is detected as empty. Different upstreams store the reasoning
 * text under `thinking` or `text`; try both.
 */
export function extractThinkingText(
  content: ContentBlock[] | undefined | null,
): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block.type !== 'string') continue;
    if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
      continue;
    }
    if (typeof block.thinking === 'string') {
      out += block.thinking;
    } else if (typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

/** Summary of a content array for diagnostic logging (no secret content). */
export function summariseContent(content: ContentBlock[] | undefined | null): {
  count: number;
  types: string[];
  textLength: number;
} {
  if (!Array.isArray(content)) {
    return { count: 0, types: [], textLength: 0 };
  }
  const types: string[] = [];
  let textLength = 0;
  for (const block of content) {
    if (!block || typeof block.type !== 'string') continue;
    types.push(block.type);
    if (block.type === 'text' && typeof block.text === 'string') {
      textLength += block.text.length;
    }
  }
  return { count: content.length, types, textLength };
}
