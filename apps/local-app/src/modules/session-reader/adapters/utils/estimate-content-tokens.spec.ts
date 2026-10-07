import type { UnifiedMessage, UnifiedContentBlock } from '../../dtos/unified-session.types';
import {
  estimateTokens,
  estimateStepTokens,
  estimateMessageTokens,
  estimateVisibleFromMessages,
} from './estimate-content-tokens';

function makeMessage(
  id: string,
  content: UnifiedContentBlock[],
  overrides: Partial<UnifiedMessage> = {},
): UnifiedMessage {
  return {
    id,
    parentId: null,
    role: 'assistant',
    timestamp: new Date('2026-02-26T00:00:00.000Z'),
    content,
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

describe('estimate-content-tokens', () => {
  describe('estimateTokens', () => {
    it('uses a 4-chars-per-token heuristic', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
    });
  });

  describe('estimateMessageTokens', () => {
    it.each([
      { name: 'text', blocks: [{ type: 'text', text: 'hello world' }], expected: 3 },
      {
        name: 'thinking',
        blocks: [{ type: 'thinking', thinking: 'internal reasoning here' }],
        expected: Math.ceil('internal reasoning here'.length / 4),
      },
      {
        name: 'string tool result',
        blocks: [
          { type: 'tool_result', toolCallId: 'tc1', content: 'tool output', isError: false },
        ],
        expected: Math.ceil('tool output'.length / 4),
      },
      {
        name: 'structured tool result',
        blocks: [
          {
            type: 'tool_result',
            toolCallId: 'tc1',
            content: [{ a: 1 }, { b: 'x' }],
            isError: false,
          },
        ],
        expected: Math.ceil(JSON.stringify([{ a: 1 }, { b: 'x' }]).length / 4),
      },
      {
        name: 'tool call',
        blocks: [
          {
            type: 'tool_call',
            toolCallId: 'tc2',
            toolName: 'Read',
            input: { file: '/tmp/a.ts', recursive: true },
          },
        ],
        expected: Math.ceil(JSON.stringify({ file: '/tmp/a.ts', recursive: true }).length / 4),
      },
    ] satisfies { name: string; blocks: UnifiedContentBlock[]; expected: number }[])(
      'estimates $name blocks',
      ({ blocks, expected }) => {
        expect(estimateMessageTokens(blocks)).toBe(expected);
      },
    );

    it('handles mixed block content and skips image blocks', () => {
      const input = { x: 1 };
      const expected =
        Math.ceil('alpha'.length / 4) +
        Math.ceil('beta beta'.length / 4) +
        Math.ceil('result text'.length / 4) +
        Math.ceil(JSON.stringify(input).length / 4);

      expect(
        estimateMessageTokens([
          { type: 'text', text: 'alpha' },
          { type: 'thinking', thinking: 'beta beta' },
          { type: 'tool_result', toolCallId: 'tc3', content: 'result text', isError: false },
          { type: 'tool_call', toolCallId: 'tc4', toolName: 'Write', input },
          { type: 'image', mediaType: 'image/png', data: 'base64-data' },
        ]),
      ).toBe(expected);
    });

    it('returns 0 for empty content', () => {
      expect(estimateMessageTokens([])).toBe(0);
    });
  });

  describe('estimateStepTokens', () => {
    it.each([
      {
        type: 'thinking',
        content: { thinkingText: 'reasoning trace' },
        expected: Math.ceil('reasoning trace'.length / 4),
      },
      {
        type: 'tool_call',
        content: { toolInput: { file: '/tmp/x.ts', recursive: true } },
        expected: Math.ceil(JSON.stringify({ file: '/tmp/x.ts', recursive: true }).length / 4),
      },
      {
        type: 'tool_result',
        content: { toolResultContent: 'result payload' },
        expected: Math.ceil('result payload'.length / 4),
      },
      {
        type: 'tool_result',
        content: { toolResultContent: [{ ok: true }, { count: 2 }] },
        expected: Math.ceil(JSON.stringify([{ ok: true }, { count: 2 }]).length / 4),
      },
      {
        type: 'output',
        content: { outputText: 'final answer' },
        expected: Math.ceil('final answer'.length / 4),
      },
      { type: 'unknown', content: { outputText: 'abc' }, expected: 0 },
    ])('estimates $type steps with $content', ({ type, content, expected }) => {
      expect(estimateStepTokens(type, content)).toBe(expected);
    });

    it('returns 0 for empty/undefined content', () => {
      expect(estimateStepTokens('thinking', {})).toBe(0);
      expect(estimateStepTokens('tool_result', {})).toBe(0);
      expect(estimateStepTokens('output', {})).toBe(0);
      expect(estimateStepTokens('tool_call', {})).toBe(0);
      expect(estimateStepTokens('unknown', {})).toBe(0);
    });
  });

  describe('estimateVisibleFromMessages', () => {
    it.each([
      {
        name: 'sums from the start when there is no compaction marker',
        messages: [
          makeMessage('m1', [{ type: 'text', text: '1234' }]),
          makeMessage('m2', [{ type: 'text', text: '12345' }]),
        ],
      },
      {
        name: 'uses only messages after last compaction summary marker',
        messages: [
          makeMessage('m1', [{ type: 'text', text: 'ignore me' }]),
          makeMessage('m2', [{ type: 'text', text: 'compaction marker' }], {
            isCompactSummary: true,
          }),
          makeMessage('m3', [{ type: 'text', text: 'abcd' }]),
          makeMessage('m4', [{ type: 'text', text: 'abcdefgh' }]),
        ],
      },
      {
        name: 'excludes sidechain messages from visible context estimation',
        messages: [
          makeMessage('m1', [{ type: 'text', text: 'abcd' }]),
          makeMessage('m2', [{ type: 'text', text: 'abcdefghijkl' }], { isSidechain: true }),
          makeMessage('m3', [{ type: 'text', text: 'abcdefgh' }]),
        ],
      },
    ])('$name', ({ messages }) => {
      expect(estimateVisibleFromMessages(messages)).toBe(3);
    });
  });
});
