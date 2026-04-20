import { describe, expect, it } from 'vitest';

import {
  extractAssistantText,
  extractThinkingText,
  isEmptyAssistantResponse,
  summariseContent,
} from '../container/agent-runner/src/content-blocks.js';

describe('extractAssistantText', () => {
  it('returns empty string for non-array input', () => {
    expect(extractAssistantText(undefined)).toBe('');
    expect(extractAssistantText(null)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractAssistantText([])).toBe('');
  });

  it('concatenates only type=text blocks in order', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('Hello world');
  });

  it('skips thinking blocks preceding text (LiteLLM triage/haiku case)', () => {
    expect(
      extractAssistantText([
        { type: 'thinking', text: undefined },
        { type: 'text', text: 'Hey there, great to see!' },
      ]),
    ).toBe('Hey there, great to see!');
  });

  it('skips tool_use blocks without dropping the turn', () => {
    // IMPORTANT: this helper builds *user-visible text*, not a replay prompt.
    // Silently skipping tool_use is correct for display; the SDK handles
    // tool execution in its own pipeline, independent of this buffer.
    expect(
      extractAssistantText([
        { type: 'text', text: 'Calling tool: ' },
        {
          type: 'tool_use',
          // Shape hint: id/name/input present on the real block; irrelevant here
          text: undefined,
        },
        { type: 'text', text: 'done.' },
      ]),
    ).toBe('Calling tool: done.');
  });

  it('skips unknown/future block types', () => {
    expect(
      extractAssistantText([
        { type: 'redacted_thinking', text: undefined },
        { type: 'server_tool_use', text: undefined },
        { type: 'text', text: 'ok' },
        { type: 'some_future_type', text: undefined },
      ]),
    ).toBe('ok');
  });

  it('ignores text blocks with non-string text', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: undefined },
        { type: 'text', text: 'real' },
      ]),
    ).toBe('real');
  });
});

describe('isEmptyAssistantResponse', () => {
  it('returns false for non-array / empty array (no assistant turn yet)', () => {
    expect(isEmptyAssistantResponse(undefined)).toBe(false);
    expect(isEmptyAssistantResponse(null)).toBe(false);
    expect(isEmptyAssistantResponse([])).toBe(false);
  });

  it('flags the qwen3-via-LiteLLM [thinking, text:""] failure shape', () => {
    // Exact shape observed in production litellm logs: 1335 tokens of
    // reasoning followed by an empty text block with stop_reason=end_turn
    // and no tool_use. User sees nothing.
    expect(
      isEmptyAssistantResponse([
        {
          type: 'thinking',
          thinking: '[1335 tokens of reasoning about what to do]',
        },
        { type: 'text', text: '' },
      ]),
    ).toBe(true);
  });

  it('flags thinking-only responses with no text block at all', () => {
    expect(
      isEmptyAssistantResponse([
        { type: 'thinking', thinking: 'hmm, what should I do' },
      ]),
    ).toBe(true);
  });

  it('flags text blocks containing only whitespace', () => {
    expect(
      isEmptyAssistantResponse([
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: '   \n\t  ' },
      ]),
    ).toBe(true);
  });

  it('does NOT flag responses containing tool_use (agent is acting)', () => {
    expect(
      isEmptyAssistantResponse([
        { type: 'thinking', thinking: 'I should call the tool' },
        { type: 'tool_use' },
      ]),
    ).toBe(false);
  });

  it('does NOT flag responses with non-empty text content', () => {
    expect(
      isEmptyAssistantResponse([
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'Here is your answer.' },
      ]),
    ).toBe(false);
  });
});

describe('extractThinkingText', () => {
  it('returns empty string for non-array / empty input', () => {
    expect(extractThinkingText(undefined)).toBe('');
    expect(extractThinkingText(null)).toBe('');
    expect(extractThinkingText([])).toBe('');
  });

  it('extracts from the `thinking` field (primary shape)', () => {
    expect(
      extractThinkingText([
        { type: 'thinking', thinking: 'step one. ' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: 'step two.' },
      ]),
    ).toBe('step one. step two.');
  });

  it('falls back to `text` field when `thinking` is absent', () => {
    expect(
      extractThinkingText([{ type: 'thinking', text: 'legacy shape' }]),
    ).toBe('legacy shape');
  });

  it('includes redacted_thinking blocks', () => {
    expect(
      extractThinkingText([
        { type: 'redacted_thinking', thinking: 'sensitive' },
      ]),
    ).toBe('sensitive');
  });

  it('ignores non-thinking blocks', () => {
    expect(
      extractThinkingText([
        { type: 'text', text: 'visible output' },
        { type: 'tool_use' },
      ]),
    ).toBe('');
  });
});

describe('summariseContent', () => {
  it('returns zero counts for non-array input', () => {
    expect(summariseContent(undefined)).toEqual({
      count: 0,
      types: [],
      textLength: 0,
    });
  });

  it('records type order and text length', () => {
    expect(
      summariseContent([
        { type: 'thinking', text: undefined },
        { type: 'text', text: 'five ' },
        { type: 'tool_use', text: undefined },
        { type: 'text', text: 'chars' },
      ]),
    ).toEqual({
      count: 4,
      types: ['thinking', 'text', 'tool_use', 'text'],
      textLength: 10,
    });
  });
});
