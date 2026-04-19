import { describe, expect, it } from 'vitest';

import {
  extractAssistantText,
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
