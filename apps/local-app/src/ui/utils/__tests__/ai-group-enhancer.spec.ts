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
      expect(
        items.some((item) => item.type !== 'tool-group' && item.step.id === 'output-last'),
      ).toBe(false);
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

  describe('buildDisplayItems – same-type grouping', () => {
    it('groups 3 consecutive Read calls into a single tool-group', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'src/a.ts' } },
          estimatedTokens: 100,
          durationMs: 10,
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'content-a', isError: false },
          estimatedTokens: 200,
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Read', toolInput: { file_path: 'src/b.ts' } },
          estimatedTokens: 150,
          durationMs: 20,
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'content-b', isError: false },
          estimatedTokens: 250,
        }),
        makeStep({
          id: 'read-3',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Read', toolInput: { file_path: 'src/c.ts' } },
          estimatedTokens: 120,
          durationMs: 15,
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'content-c', isError: false },
          estimatedTokens: 180,
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool-group');
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].count).toBe(3);
      expect(items[0].toolName).toBe('Read');
      expect(items[0].totalTokens).toBe(100 + 200 + 150 + 250 + 120 + 180);
      expect(items[0].commonPathPrefix).toBe('src');
      expect(items[0].errorCount).toBe(0);
      expect(items[0].items).toHaveLength(3);
    });

    it('does not group [Read, Bash, Read] – separated by non-Read', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'content', isError: false },
        }),
        makeStep({
          id: 'bash-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Bash', toolInput: { command: 'ls' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'output', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'content', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(3);
      expect(items.map((i) => i.type)).toEqual(['tool', 'tool', 'tool']);
    });

    it('does not group a single Read – renders as plain tool item', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'content', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool');
    });

    it('counts errors within grouped items', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'error', isError: true },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'ok', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].errorCount).toBe(1);
    });

    it('computes common path prefix across grouped reads', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-1',
            toolName: 'Read',
            toolInput: { file_path: 'apps/local-app/src/a.ts' },
          },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'a', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-2',
            toolName: 'Read',
            toolInput: { file_path: 'apps/local-app/src/b.ts' },
          },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'b', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].commonPathPrefix).toBe('apps/local-app/src');
    });

    it('preserves order: [thinking, Read, Read, subagent]', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'thinking-1',
          type: 'thinking',
          content: { thinkingText: 'Planning...' },
        }),
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'a', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'b', isError: false },
        }),
        makeStep({
          id: 'subagent-1',
          type: 'subagent',
          content: { subagentId: 'p1', subagentDescription: 'Explore' },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items.map((i) => i.type)).toEqual(['thinking', 'tool-group', 'subagent']);
    });

    it('groups 4 consecutive Bash calls into a single tool-group', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'bash-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'ls' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'output-1', isError: false },
        }),
        makeStep({
          id: 'bash-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Bash', toolInput: { command: 'pwd' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'output-2', isError: false },
        }),
        makeStep({
          id: 'bash-3',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Bash', toolInput: { command: 'whoami' } },
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'output-3', isError: false },
        }),
        makeStep({
          id: 'bash-4',
          type: 'tool_call',
          content: { toolCallId: 'tc-4', toolName: 'Bash', toolInput: { command: 'date' } },
        }),
        makeStep({
          id: 'result-4',
          type: 'tool_result',
          content: { toolCallId: 'tc-4', toolResultContent: 'output-4', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool-group');
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].toolName).toBe('Bash');
      expect(items[0].count).toBe(4);
    });

    it('groups [Read, Read, Bash, Bash] into 2 separate tool-groups', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'a', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'b', isError: false },
        }),
        makeStep({
          id: 'bash-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Bash', toolInput: { command: 'ls' } },
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'out', isError: false },
        }),
        makeStep({
          id: 'bash-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-4', toolName: 'Bash', toolInput: { command: 'pwd' } },
        }),
        makeStep({
          id: 'result-4',
          type: 'tool_result',
          content: { toolCallId: 'tc-4', toolResultContent: 'out2', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(2);
      expect(items[0].type).toBe('tool-group');
      expect(items[1].type).toBe('tool-group');
      if (items[0].type !== 'tool-group' || items[1].type !== 'tool-group') throw new Error();
      expect(items[0].toolName).toBe('Read');
      expect(items[0].count).toBe(2);
      expect(items[1].toolName).toBe('Bash');
      expect(items[1].count).toBe(2);
    });

    it('does not group [Read, Bash, Read] – no consecutive same-type runs', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'a', isError: false },
        }),
        makeStep({
          id: 'bash-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Bash', toolInput: { command: 'ls' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'out', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'b', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(3);
      expect(items.map((i) => i.type)).toEqual(['tool', 'tool', 'tool']);
    });

    it('groups exactly 2 consecutive Edit calls into a tool-group', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'edit-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Edit', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'ok', isError: false },
        }),
        makeStep({
          id: 'edit-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Edit', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'ok', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool-group');
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].toolName).toBe('Edit');
      expect(items[0].count).toBe(2);
    });

    it('groups 2 consecutive mcp__devchain__devchain_get_epic_by_id calls', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'mcp-1',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-1',
            toolName: 'mcp__devchain__devchain_get_epic_by_id',
            toolInput: { id: 'abc' },
          },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: '{}', isError: false },
        }),
        makeStep({
          id: 'mcp-2',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-2',
            toolName: 'mcp__devchain__devchain_get_epic_by_id',
            toolInput: { id: 'def' },
          },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: '{}', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool-group');
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].toolName).toBe('mcp__devchain__devchain_get_epic_by_id');
      expect(items[0].count).toBe(2);
    });

    it('does not group different MCP tool names', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'mcp-1',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-1',
            toolName: 'mcp__devchain__devchain_get_epic_by_id',
            toolInput: { id: 'abc' },
          },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: '{}', isError: false },
        }),
        makeStep({
          id: 'mcp-2',
          type: 'tool_call',
          content: {
            toolCallId: 'tc-2',
            toolName: 'mcp__devchain__devchain_create_epic',
            toolInput: { title: 'test' },
          },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: '{}', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.type)).toEqual(['tool', 'tool']);
    });

    it('does not compute commonPathPrefix for non-Read tool groups', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'bash-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Bash', toolInput: { command: 'ls' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'out', isError: false },
        }),
        makeStep({
          id: 'bash-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Bash', toolInput: { command: 'pwd' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'out2', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);

      expect(items).toHaveLength(1);
      if (items[0].type !== 'tool-group') throw new Error('expected tool-group');
      expect(items[0].commonPathPrefix).toBeUndefined();
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

    it('counts individual tools within a tool-group, not the group itself', () => {
      const steps: UnifiedSemanticStep[] = [
        makeStep({
          id: 'read-1',
          type: 'tool_call',
          content: { toolCallId: 'tc-1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
        }),
        makeStep({
          id: 'result-1',
          type: 'tool_result',
          content: { toolCallId: 'tc-1', toolResultContent: 'a', isError: false },
        }),
        makeStep({
          id: 'read-2',
          type: 'tool_call',
          content: { toolCallId: 'tc-2', toolName: 'Read', toolInput: { file_path: 'b.ts' } },
        }),
        makeStep({
          id: 'result-2',
          type: 'tool_result',
          content: { toolCallId: 'tc-2', toolResultContent: 'b', isError: false },
        }),
        makeStep({
          id: 'read-3',
          type: 'tool_call',
          content: { toolCallId: 'tc-3', toolName: 'Read', toolInput: { file_path: 'c.ts' } },
        }),
        makeStep({
          id: 'result-3',
          type: 'tool_result',
          content: { toolCallId: 'tc-3', toolResultContent: 'c', isError: false },
        }),
      ];

      const items = buildDisplayItems(steps, null);
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('tool-group');
      expect(buildSummary(items)).toBe('3 tool calls');
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
