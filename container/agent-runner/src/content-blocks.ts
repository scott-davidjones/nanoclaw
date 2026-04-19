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
