import type {
  AIChunk,
  UnifiedSemanticStep,
} from '@/modules/session-reader/dtos/unified-chunk.types';
import type { UnifiedMessage } from '@/modules/session-reader/dtos/unified-session.types';
import {
  buildDisplayItems,
  buildSummary,
  findLastOutput,
  getHeaderTokens,
} from '../ai-group-enhancer';

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: 'm1',
    parentId: null,
    role: 'assistant',
    timestamp: new Date('2026-01-01T10:00:00.000Z'),
    content: [{ type: 'text', text: 'message' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<AIChunk> = {}): AIChunk {
  const startTime = new Date('2026-01-01T10:00:00.000Z');
  const endTime = new Date('2026-01-01T10:00:30.000Z');

  return {
    id: 'chunk-ai',
    type: 'ai',
    startTime,
    endTime,
    messages: [
      makeMessage({
        id: 'a1',
        role: 'assistant',
      }),
    ],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      totalTokens: 165,
      messageCount: 1,
      durationMs: 30_000,
      costUsd: 0,
    },
    semanticSteps: [],
    turns: [],
    ...overrides,
  };
}

function makeStep(
  overrides: Partial<UnifiedSemanticStep> & Pick<UnifiedSemanticStep, 'id' | 'type'>,
): UnifiedSemanticStep {
  return {
    id: overrides.id,
    type: overrides.type,
    startTime: new Date('2026-01-01T10:00:00.000Z'),
    durationMs: 0,
    content: {},
    context: 'main',
    ...overrides,
  };
}

describe('ai-group-enhancer utilities', () => {
  describe('findLastOutput', () => {
    it('returns the last non-empty output step', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'output-1',
          type: 'output',
          content: { outputText: 'First output' },
          startTime: new Date('2026-01-01T10:00:01.000Z'),
        }),
        makeStep({
          id: 'output-2',
          type: 'output',
          content: { outputText: '   ' },
          startTime: new Date('2026-01-01T10:00:02.000Z'),
        }),
        makeStep({
          id: 'output-3',
          type: 'output',
          content: { outputText: 'Final output' },
          startTime: new Date('2026-01-01T10:00:03.000Z'),
        }),
      ];

      expect(findLastOutput(steps)).toEqual({
        type: 'text',
        text: 'Final output',
        timestamp: new Date('2026-01-01T10:00:03.000Z'),
        stepId: 'output-3',
      });
    });

    it('falls back to last tool_result when no output exists', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'tool-result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'old result', isError: false },
          startTime: new Date('2026-01-01T10:00:01.000Z'),
        }),
        makeStep({
          id: 'tool-result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'latest result', isError: false },
          startTime: new Date('2026-01-01T10:00:02.000Z'),
        }),
      ];

      expect(findLastOutput(steps)).toEqual({
        type: 'tool_result',
        text: 'latest result',
        timestamp: new Date('2026-01-01T10:00:02.000Z'),
        stepId: 'tool-result-2',
      });
    });

    it('returns latest non-empty tool_result for ongoing sessions with no final output', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'tool-result-old',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: '   ', isError: false },
          startTime: new Date('2026-01-01T10:00:01.000Z'),
        }),
        makeStep({
          id: 'tool-result-latest',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'latest live result', isError: false },
          startTime: new Date('2026-01-01T10:00:04.000Z'),
        }),
      ];

      expect(findLastOutput(steps)).toEqual({
        type: 'tool_result',
        text: 'latest live result',
        timestamp: new Date('2026-01-01T10:00:04.000Z'),
        stepId: 'tool-result-latest',
      });
    });

    it('returns null when no output/tool_result content exists', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'thinking-1',
          type: 'thinking',
          content: { thinkingText: 'Planning' },
        }),
      ];

      expect(findLastOutput(steps)).toBeNull();
    });
  });

  describe('buildDisplayItems', () => {
    it('excludes last output and pairs tool_call with matching tool_result', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'thinking-1',
          type: 'thinking',
          content: { thinkingText: 'Think' },
        }),
        makeStep({
          id: 'call-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'file content', isError: false },
        }),
        makeStep({
          id: 'subagent-1',
          type: 'subagent',
          content: { subagentId: 'proc-1', subagentDescription: 'Investigate issue' },
        }),
        makeStep({
          id: 'output-last',
          type: 'output',
          content: { outputText: 'final answer' },
        }),
      ];

      const items = buildDisplayItems(steps, 'output-last');

      expect(items.map((item) => item.type)).toEqual(['thinking', 'tool', 'subagent']);
      const toolItem = items.find((item) => item.type === 'tool' && item.step.id === 'call-1');
      expect(toolItem?.linkedResult?.id).toBe('result-1');
      expect(items.some((item) => item.step.id === 'output-last')).toBe(false);
    });

    it('includes orphan tool_result items when no tool_call matches', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'orphan-result',
          type: 'tool_result',
          content: { toolCallId: 'missing-call', toolResultContent: 'orphan data', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool');
      expect(items[0].step.id).toBe('orphan-result');
      expect(items[0].linkedResult).toBeUndefined();
    });

    it('returns an empty list for empty steps', () => {
      expect(buildDisplayItems([], null)).toEqual([]);
    });
  });

  describe('buildSummary', () => {
    it('uses singular tool call label for a single tool item', () => {
      const items = [
        { type: 'tool', step: makeStep({ id: 'tool-1', type: 'tool_call' }) },
      ] as const;

      expect(buildSummary(items)).toBe('1 tool call');
    });

    it('builds pluralized summary counts', () => {
      const items = [
        { type: 'thinking', step: makeStep({ id: 'thinking-1', type: 'thinking' }) },
        { type: 'tool', step: makeStep({ id: 'tool-1', type: 'tool_call' }) },
        { type: 'tool', step: makeStep({ id: 'tool-2', type: 'tool_result' }) },
        { type: 'output', step: makeStep({ id: 'output-1', type: 'output' }) },
        { type: 'subagent', step: makeStep({ id: 'subagent-1', type: 'subagent' }) },
      ] as const;

      expect(buildSummary(items)).toBe('1 thinking, 2 tool calls, 1 message, 1 subagent');
    });

    it('returns "No items" for empty list', () => {
      expect(buildSummary([])).toBe('No items');
    });
  });

  describe('getHeaderTokens', () => {
    it('uses the last assistant message usage when available', () => {
      const chunk = makeChunk({
        messages: [
          makeMessage({
            id: 'a1',
            role: 'assistant',
            usage: { input: 100, output: 20, cacheRead: 5, cacheCreation: 2 },
          }),
          makeMessage({
            id: 'u1',
            role: 'user',
            usage: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
          }),
          makeMessage({
            id: 'a2',
            role: 'assistant',
            usage: { input: 300, output: 40, cacheRead: 12, cacheCreation: 7 },
          }),
        ],
      });

      expect(getHeaderTokens(chunk)).toEqual({
        input: 300,
        output: 40,
        cacheRead: 12,
        cacheCreation: 7,
      });
    });

    it('falls back to chunk metrics when no assistant usage exists', () => {
      const chunk = makeChunk({
        messages: [
          makeMessage({ id: 'u1', role: 'user' }),
          makeMessage({ id: 'a1', role: 'assistant', usage: undefined }),
        ],
        metrics: {
          inputTokens: 900,
          outputTokens: 300,
          cacheReadTokens: 120,
          cacheCreationTokens: 30,
          totalTokens: 1350,
          messageCount: 2,
          durationMs: 10_000,
          costUsd: 0,
        },
      });

      expect(getHeaderTokens(chunk)).toEqual({
        input: 900,
        output: 300,
        cacheRead: 120,
        cacheCreation: 30,
      });
    });

    it('returns null when neither assistant usage nor metrics exist', () => {
      const chunk = makeChunk({
        messages: [
          makeMessage({ id: 'u1', role: 'user', usage: undefined }),
          makeMessage({ id: 'a1', role: 'assistant', usage: undefined }),
        ],
        metrics: undefined,
      });

      expect(getHeaderTokens(chunk)).toBeNull();
    });
  });
});
