import { buildTurns } from './turn-builder';
import { extractSemanticSteps } from './semantic-step-extractor';
import type { UnifiedMessage, TokenUsage } from '../dtos/unified-session.types';

function makeMsg(
  overrides: Partial<UnifiedMessage> & { id: string; role: UnifiedMessage['role'] },
): UnifiedMessage {
  return {
    parentId: null,
    timestamp: new Date('2026-01-01T10:00:00.000Z'),
    content: [],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenUsage {
  return { input, output, cacheRead, cacheCreation };
}

describe('buildTurns', () => {
  it('should build a single turn for one assistant message and include all linked steps', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: usage(120, 40),
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [
          { type: 'thinking', thinking: 'Analyzing...', signature: 'sig' },
          { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read', input: { path: 'a.ts' } },
          { type: 'text', text: 'I read the file.' },
        ],
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: 'a.ts' }, isTask: false }],
      }),
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        timestamp: new Date('2026-01-01T10:00:01.000Z'),
        toolResults: [{ toolCallId: 'tc-1', content: 'export const x = 1;', isError: false }],
      }),
    ];

    const steps = extractSemanticSteps(messages);
    const turns = buildTurns(steps, messages);

    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe('turn-a1');
    expect(turns[0].assistantMessageId).toBe('a1');
    expect(turns[0].model).toBe('claude-sonnet-4-6');
    expect(turns[0].steps.map((step) => step.type)).toEqual([
      'thinking',
      'tool_call',
      'output',
      'tool_result',
    ]);
    expect(turns[0].summary).toEqual({
      thinkingCount: 1,
      toolCallCount: 1,
      subagentCount: 0,
      outputCount: 1,
    });
    // Token usage is counted once per source message (not once per semantic step).
    expect(turns[0].tokens).toEqual({ input: 120, output: 40 });
    expect(turns[0].durationMs).toBe(1000);
  });

  it('should build multiple turns for multi-assistant AI chunks', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [{ type: 'text', text: 'First response' }],
      }),
      makeMsg({
        id: 'a2',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:10.000Z'),
        content: [{ type: 'text', text: 'Second response' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);
    const turns = buildTurns(steps, messages);

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.id)).toEqual(['turn-a1', 'turn-a2']);
    expect(turns[0].steps.map((step) => step.content.outputText)).toEqual(['First response']);
    expect(turns[1].steps.map((step) => step.content.outputText)).toEqual(['Second response']);
    expect(turns[0].durationMs).toBe(10000);
    expect(turns[1].durationMs).toBe(0);
  });

  it('should assign tool_result steps to the turn owning the matching tool_call', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [
          { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read', input: { path: 'a.ts' } },
          { type: 'text', text: 'Reading file...' },
        ],
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: 'a.ts' }, isTask: false }],
      }),
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        timestamp: new Date('2026-01-01T10:00:01.000Z'),
        toolResults: [{ toolCallId: 'tc-1', content: 'result', isError: false }],
      }),
      makeMsg({
        id: 'a2',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:02.000Z'),
        content: [{ type: 'text', text: 'Done.' }],
      }),
    ];

    const turns = buildTurns(extractSemanticSteps(messages), messages);
    const turnWithToolResult = turns.find((turn) =>
      turn.steps.some((step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1'),
    );

    expect(turnWithToolResult?.assistantMessageId).toBe('a1');
    expect(turns.find((turn) => turn.assistantMessageId === 'a2')?.steps).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ type: 'tool_result' })]),
    );
  });

  it('should keep subagent steps and matching tool_result in the same turn', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-task',
            toolName: 'Task',
            input: { prompt: 'Investigate issue' },
          },
        ],
        toolCalls: [
          {
            id: 'tc-task',
            name: 'Task',
            input: { prompt: 'Investigate issue' },
            isTask: true,
            taskDescription: 'Investigate issue',
          },
        ],
      }),
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        timestamp: new Date('2026-01-01T10:00:01.000Z'),
        toolResults: [{ toolCallId: 'tc-task', content: 'done', isError: false }],
      }),
      makeMsg({
        id: 'a2',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:02.000Z'),
        content: [{ type: 'text', text: 'Follow up.' }],
      }),
    ];

    const turns = buildTurns(extractSemanticSteps(messages), messages);
    const firstTurn = turns[0];

    expect(firstTurn.steps.map((step) => step.type)).toEqual(['subagent', 'tool_result']);
    expect(firstTurn.summary.subagentCount).toBe(1);
    expect(firstTurn.summary.toolCallCount).toBe(0);
  });

  it('should handle empty steps by still creating assistant turns', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        content: [],
      }),
    ];

    const turns = buildTurns([], messages);

    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe('turn-a1');
    expect(turns[0].steps).toEqual([]);
    expect(turns[0].summary).toEqual({
      thinkingCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
      outputCount: 0,
    });
    expect(turns[0].durationMs).toBe(0);
  });
});
