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
    it('estimates text blocks', () => {
      expect(estimateMessageTokens([{ type: 'text', text: 'hello world' }])).toBe(3);
    });

    it('estimates thinking blocks', () => {
      expect(
        estimateMessageTokens([{ type: 'thinking', thinking: 'internal reasoning here' }]),
      ).toBe(Math.ceil('internal reasoning here'.length / 4));
    });

    it('estimates tool_result blocks for string content', () => {
      expect(
        estimateMessageTokens([
          { type: 'tool_result', toolCallId: 'tc1', content: 'tool output', isError: false },
        ]),
      ).toBe(Math.ceil('tool output'.length / 4));
    });

    it('estimates tool_result blocks for array/object payloads', () => {
      const payload = [{ a: 1 }, { b: 'x' }];
      expect(
        estimateMessageTokens([
          { type: 'tool_result', toolCallId: 'tc1', content: payload, isError: false },
        ]),
      ).toBe(Math.ceil(JSON.stringify(payload).length / 4));
    });

    it('estimates tool_call blocks from JSON input', () => {
      const input = { file: '/tmp/a.ts', recursive: true };
      expect(
        estimateMessageTokens([
          {
            type: 'tool_call',
            toolCallId: 'tc2',
            toolName: 'Read',
            input,
          },
        ]),
      ).toBe(Math.ceil(JSON.stringify(input).length / 4));
    });

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
    it('estimates thinking step tokens from thinkingText', () => {
      const thinkingText = 'reasoning trace';
      expect(estimateStepTokens('thinking', { thinkingText })).toBe(
        Math.ceil(thinkingText.length / 4),
      );
    });

    it('estimates tool_call step tokens from JSON input', () => {
      const toolInput = { file: '/tmp/x.ts', recursive: true };
      expect(estimateStepTokens('tool_call', { toolInput })).toBe(
        Math.ceil(JSON.stringify(toolInput).length / 4),
      );
    });

    it('estimates tool_result step tokens for string content', () => {
      const toolResultContent = 'result payload';
      expect(estimateStepTokens('tool_result', { toolResultContent })).toBe(
        Math.ceil(toolResultContent.length / 4),
      );
    });

    it('estimates tool_result step tokens for array/object content', () => {
      const toolResultContent = [{ ok: true }, { count: 2 }];
      expect(estimateStepTokens('tool_result', { toolResultContent })).toBe(
        Math.ceil(JSON.stringify(toolResultContent).length / 4),
      );
    });

    it('estimates output step tokens from outputText', () => {
      const outputText = 'final answer';
      expect(estimateStepTokens('output', { outputText })).toBe(Math.ceil(outputText.length / 4));
    });

    it('returns 0 for unknown step types', () => {
      expect(estimateStepTokens('unknown', { outputText: 'abc' })).toBe(0);
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
    it('sums from the start when there is no compaction marker', () => {
      const messages = [
        makeMessage('m1', [{ type: 'text', text: '1234' }]),
        makeMessage('m2', [{ type: 'text', text: '12345' }]),
      ];

      expect(estimateVisibleFromMessages(messages)).toBe(1 + 2);
    });

    it('uses only messages after last compaction summary marker', () => {
      const messages = [
        makeMessage('m1', [{ type: 'text', text: 'ignore me' }]),
        makeMessage('m2', [{ type: 'text', text: 'compaction marker' }], {
          isCompactSummary: true,
        }),
        makeMessage('m3', [{ type: 'text', text: 'abcd' }]),
        makeMessage('m4', [{ type: 'text', text: 'abcdefgh' }]),
      ];

      expect(estimateVisibleFromMessages(messages)).toBe(1 + 2);
    });

    it('excludes sidechain messages from visible context estimation', () => {
      const messages = [
        makeMessage('m1', [{ type: 'text', text: 'abcd' }]),
        makeMessage('m2', [{ type: 'text', text: 'abcdefghijkl' }], { isSidechain: true }),
        makeMessage('m3', [{ type: 'text', text: 'abcdefgh' }]),
      ];

      expect(estimateVisibleFromMessages(messages)).toBe(1 + 2);
    });
  });
});
