/**
 * Layer: unit. The projection is a pure function of chunk data, so the cheapest reliable
 * check is a fixture shaped like the measured live chunk plus focused shape assertions.
 */
import {
  MOBILE_THINKING_CAP_CHARS,
  projectMobileChunk,
  projectMobileTail,
} from './mobile-transcript-projection';
import {
  serializeChunk,
  serializeRpcChunk,
  serializeRpcTranscriptTail,
} from '../../session-reader/services/transcript-serialization';
import type {
  AIChunk,
  UnifiedChunk,
  UnifiedSemanticStep,
} from '../../session-reader/dtos/unified-chunk.types';
import type { UnifiedMessage } from '../../session-reader/dtos/unified-message.types';
import type { TranscriptTailResponse } from '../../session-reader/services/session-reader.service';

const T0 = new Date('2026-10-02T10:00:00.000Z');
const metrics = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 2,
  messageCount: 1,
  durationMs: 1,
  costUsd: 0,
};

function step(
  id: string,
  type: UnifiedSemanticStep['type'],
  content: UnifiedSemanticStep['content'],
): UnifiedSemanticStep {
  return { id, type, startTime: T0, durationMs: 1, content, context: 'main', estimatedTokens: 3 };
}

function assistantMessage(id: string, blocks: UnifiedMessage['content']): UnifiedMessage {
  return {
    id,
    parentId: null,
    role: 'assistant',
    timestamp: T0,
    content: blocks,
    toolCalls: blocks
      .filter((b) => b.type === 'tool_call')
      .map((b) => ({
        id: (b as { toolCallId: string }).toolCallId,
        name: (b as { toolName: string }).toolName,
        input: (b as { input: Record<string, unknown> }).input,
        isTask: false,
      })),
    toolResults: blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({
        toolCallId: (b as { toolCallId: string }).toolCallId,
        content: (b as { content: string }).content,
        isError: false,
      })),
    isMeta: false,
    isSidechain: false,
    stopReason: 'tool_use',
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
  };
}

function aiChunk(
  steps: UnifiedSemanticStep[],
  messages: UnifiedMessage[],
  id = 'chunk-ai',
): AIChunk {
  return {
    id,
    type: 'ai',
    startTime: T0,
    endTime: T0,
    messages,
    metrics,
    semanticSteps: steps,
    turns: [
      {
        id: `${id}-turn`,
        assistantMessageId: messages[0]?.id ?? 'm',
        timestamp: T0,
        steps,
        summary: { thinkingCount: 0, toolCallCount: 0, subagentCount: 0, outputCount: 0 },
        durationMs: 1,
      },
    ],
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * A tool-heavy live chunk shaped like the measured one (≈740 KB serialized: messages
 * ≈507 KB, steps ≈232 KB with ≈134 KB of tool results, ≈40 KB of tool input, ≈3 KB thinking).
 */
function toolHeavyChunk(): AIChunk {
  const steps: UnifiedSemanticStep[] = [];
  const blocks: UnifiedMessage['content'] = [];
  const messages: UnifiedMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    const result = 'r'.repeat(3_300);
    const input = { command: 'c'.repeat(1_000) };
    steps.push(step(`think-${i}`, 'thinking', { thinkingText: 't'.repeat(75) }));
    steps.push(
      step(`call-${i}`, 'tool_call', { toolName: 'Bash', toolCallId: `tc-${i}`, toolInput: input }),
    );
    steps.push(
      step(`res-${i}`, 'tool_result', {
        toolCallId: `tc-${i}`,
        toolResultContent: result,
        isError: false,
      }),
    );
    steps.push(
      step(`out-${i}`, 'output', {
        outputText: `Step ${i}: ran the command and checked its output.`,
      }),
    );
    blocks.push({ type: 'text', text: `Step ${i}: ran the command and checked its output.` });
    blocks.push({ type: 'tool_call', toolCallId: `tc-${i}`, toolName: 'Bash', input });
    blocks.push({ type: 'tool_result', toolCallId: `tc-${i}`, content: result, isError: false });
    messages.push(assistantMessage(`m-${i}`, blocks.slice(-3)));
  }
  return aiChunk(steps, messages);
}

describe('projectMobileChunk', () => {
  it('keeps a measured tool-heavy live chunk under 100 KB', () => {
    const chunk = toolHeavyChunk();
    const before = bytes(serializeRpcChunk(chunk));
    const after = bytes(serializeRpcChunk(projectMobileChunk(chunk)));
    // This fixture serializes to 779,211 B unprojected and 73,421 B projected.
    expect(before).toBeGreaterThan(700_000);
    expect(after).toBeLessThanOrEqual(100_000);
  });

  it('keeps output text in full and drops tool results, tool input and message content', () => {
    const longOutput = 'o'.repeat(50_000);
    const chunk = aiChunk(
      [
        step('o1', 'output', { outputText: longOutput }),
        step('c1', 'tool_call', { toolName: 'Read', toolCallId: 'tc1', toolInput: { path: '/x' } }),
        step('r1', 'tool_result', {
          toolCallId: 'tc1',
          toolResultContent: 'secret-body',
          isError: true,
          isTruncated: true,
          fullLength: 9,
        }),
      ],
      [assistantMessage('m1', [{ type: 'text', text: longOutput }])],
    );

    const projected = projectMobileChunk(chunk) as AIChunk;

    expect(projected.semanticSteps[0].content).toEqual({ outputText: longOutput });
    expect(projected.semanticSteps[1].content).toEqual({ toolName: 'Read', toolCallId: 'tc1' });
    expect(projected.semanticSteps[2].content).toEqual({ toolCallId: 'tc1', isError: true });
    expect(projected.turns[0].steps[2].content).toEqual({ toolCallId: 'tc1', isError: true });
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]).toMatchObject({
      id: 'm1',
      role: 'assistant',
      content: [],
      toolCalls: [],
      toolResults: [],
      stopReason: 'tool_use',
    });
    expect(JSON.stringify(projected)).not.toContain('secret-body');
  });

  it('keeps toolInput only for AskUserQuestion', () => {
    const questions = { questions: [{ question: 'Pick', header: 'h', options: [] }] };
    const projected = projectMobileChunk(
      aiChunk(
        [
          step('c1', 'tool_call', {
            toolName: 'AskUserQuestion',
            toolCallId: 'tc1',
            toolInput: questions,
          }),
          step('c2', 'tool_call', {
            toolName: 'Bash',
            toolCallId: 'tc2',
            toolInput: { command: 'ls' },
          }),
        ],
        [],
      ),
    ) as AIChunk;

    expect(projected.semanticSteps[0].content.toolInput).toEqual(questions);
    expect(projected.turns[0].steps[0].content.toolInput).toEqual(questions);
    expect(projected.semanticSteps[1].content).not.toHaveProperty('toolInput');
  });

  it('keeps subagent and interruption steps', () => {
    const projected = projectMobileChunk(
      aiChunk(
        [
          step('s1', 'subagent', {
            subagentId: 'a1',
            subagentDescription: 'explore',
            toolResultContent: 'x',
          }),
          step('i1', 'interruption', { interruptionText: '[Request interrupted by user]' }),
        ],
        [],
      ),
    ) as AIChunk;

    expect(projected.semanticSteps[0].content).toEqual({
      subagentId: 'a1',
      subagentDescription: 'explore',
    });
    expect(projected.semanticSteps[1].content).toEqual({
      interruptionText: '[Request interrupted by user]',
    });
  });

  it('caps thinking per chunk and trims from the oldest step so the newest survives', () => {
    const half = MOBILE_THINKING_CAP_CHARS / 2;
    const projected = projectMobileChunk(
      aiChunk(
        [
          step('t-old', 'thinking', { thinkingText: 'a'.repeat(MOBILE_THINKING_CAP_CHARS) }),
          step('t-mid', 'thinking', { thinkingText: 'b'.repeat(half) }),
          step('t-new', 'thinking', { thinkingText: 'c'.repeat(half) }),
        ],
        [],
      ),
    ) as AIChunk;

    const [oldest, middle, newest] = projected.semanticSteps.map((s) => s.content.thinkingText);
    expect(newest).toBe('c'.repeat(half));
    expect(middle).toBe('b'.repeat(half));
    expect(oldest).toBeUndefined();
    const total = projected.semanticSteps.reduce(
      (sum, s) => sum + (s.content.thinkingText?.length ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(MOBILE_THINKING_CAP_CHARS);
  });

  it('trims the step that straddles the cap and marks it', () => {
    const projected = projectMobileChunk(
      aiChunk(
        [
          step('t-old', 'thinking', { thinkingText: 'a'.repeat(10_000) }),
          step('t-new', 'thinking', {
            thinkingText: 'b'.repeat(MOBILE_THINKING_CAP_CHARS - 4_000),
          }),
        ],
        [],
      ),
    ) as AIChunk;

    expect(projected.semanticSteps[1].content.thinkingText).toBe(
      'b'.repeat(MOBILE_THINKING_CAP_CHARS - 4_000),
    );
    expect(projected.semanticSteps[0].content.thinkingText).toBe(`${'a'.repeat(4_000)}…`);
  });

  it('leaves user, system and compact chunks untouched', () => {
    const message: UnifiedMessage = {
      ...assistantMessage('u1', [{ type: 'text', text: 'hello' }]),
      role: 'user',
    };
    for (const type of ['user', 'system', 'compact'] as const) {
      const chunk = {
        id: type,
        type,
        startTime: T0,
        endTime: T0,
        messages: [message],
        metrics,
      } as UnifiedChunk;
      expect(projectMobileChunk(chunk)).toBe(chunk);
    }
  });

  it('does not change the web REST projection of the same chunk', () => {
    const chunk = toolHeavyChunk();
    const before = JSON.stringify(serializeChunk(chunk));
    projectMobileChunk(chunk);
    expect(JSON.stringify(serializeChunk(chunk))).toBe(before);
    expect(before).toContain('rrrr');
    expect(serializeChunk(chunk).messages).toHaveLength(40);
  });
});

describe('projectMobileTail', () => {
  const delta = (chunk: UnifiedChunk): TranscriptTailResponse => ({
    kind: 'delta',
    cursor: 'c2',
    replaceFromChunkId: chunk.id,
    replaceFromChunkIndex: 0,
    deltaChunks: [chunk],
    deltaMessages: [assistantMessage('m-delta', [{ type: 'text', text: 'body' }])],
    metrics: {} as never,
    totalChunkCount: 1,
    totalMessageCount: 2,
  });

  it('sends empty deltaMessages and projected chunks', () => {
    const tail = projectMobileTail(delta(toolHeavyChunk()));
    expect(tail).toMatchObject({
      kind: 'delta',
      cursor: 'c2',
      replaceFromChunkId: 'chunk-ai',
      deltaMessages: [],
    });
    const wire = serializeRpcTranscriptTail(tail as never) as {
      deltaChunks: unknown[];
      deltaMessages: unknown[];
    };
    expect(wire.deltaMessages).toEqual([]);
    expect(bytes(wire.deltaChunks)).toBeLessThanOrEqual(100_000);
  });

  it('passes an expired cursor and a full refetch through', () => {
    expect(projectMobileTail(null)).toBeNull();
    const refetch: TranscriptTailResponse = {
      kind: 'full-refetch-required',
      sourceChangeKind: 'file-replacement',
    };
    expect(projectMobileTail(refetch)).toBe(refetch);
  });
});
