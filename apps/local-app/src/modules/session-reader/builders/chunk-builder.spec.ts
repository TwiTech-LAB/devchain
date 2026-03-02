import * as path from 'node:path';
import { buildChunks, classifyMessage, computeChunkMetrics } from './chunk-builder';
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import type { UnifiedMessage, TokenUsage } from '../dtos/unified-session.types';
import type { MessageCategory } from '../dtos/unified-chunk.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function textBlock(text: string) {
  return { type: 'text' as const, text };
}

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenUsage {
  return { input, output, cacheRead, cacheCreation };
}

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  it('should classify real user message as "user"', () => {
    const msg = makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] });
    expect(classifyMessage(msg)).toBe<MessageCategory>('user');
  });

  it('should classify assistant message as "ai"', () => {
    const msg = makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Hi')] });
    expect(classifyMessage(msg)).toBe<MessageCategory>('ai');
  });

  it('should classify system+isMeta message as "hardNoise"', () => {
    const msg = makeMsg({ id: 's1', role: 'system', isMeta: true });
    expect(classifyMessage(msg)).toBe<MessageCategory>('hardNoise');
  });

  it('should classify user isMeta with system-reminder as "hardNoise"', () => {
    const msg = makeMsg({
      id: 'u2',
      role: 'user',
      isMeta: true,
      content: [textBlock('<system-reminder>some reminder</system-reminder>')],
    });
    expect(classifyMessage(msg)).toBe<MessageCategory>('hardNoise');
  });

  it('should classify user isMeta with local-command-caveat as "hardNoise"', () => {
    const msg = makeMsg({
      id: 'u3',
      role: 'user',
      isMeta: true,
      content: [textBlock('<local-command-caveat>caveat text</local-command-caveat>')],
    });
    expect(classifyMessage(msg)).toBe<MessageCategory>('hardNoise');
  });

  it('should classify compact summary as "compact"', () => {
    const msg = makeMsg({
      id: 'c1',
      role: 'assistant',
      isCompactSummary: true,
      content: [textBlock('Summary...')],
    });
    expect(classifyMessage(msg)).toBe<MessageCategory>('compact');
  });

  it('should classify user message with <local-command-stdout> as "system"', () => {
    const msg = makeMsg({
      id: 'sys1',
      role: 'user',
      content: [textBlock('<local-command-stdout>output</local-command-stdout>')],
    });
    expect(classifyMessage(msg)).toBe<MessageCategory>('system');
  });

  it('should classify user tool-result message with isMeta absent as "ai"', () => {
    const msg = makeMsg({
      id: 'u-tool-1',
      role: 'user',
      content: [],
      toolResults: [{ toolCallId: 'tc-1', content: 'result content', isError: false }],
    });
    delete (msg as unknown as { isMeta?: boolean }).isMeta;
    expect(classifyMessage(msg)).toBe<MessageCategory>('ai');
  });

  it('should classify user tool-result message with isMeta=true as "ai"', () => {
    const msg = makeMsg({
      id: 'u-tool-2',
      role: 'user',
      isMeta: true,
      content: [],
      toolResults: [{ toolCallId: 'tc-2', content: 'result content', isError: false }],
    });
    expect(classifyMessage(msg)).toBe<MessageCategory>('ai');
  });

  it('should classify user isMeta without noise tags as "ai" (meta user not matching noise)', () => {
    const msg = makeMsg({
      id: 'u4',
      role: 'user',
      isMeta: true,
      content: [textBlock('some tool result')],
    });
    // isMeta user without hard noise tags → not hardNoise, not compact, not system, isMeta blocks user → falls to ai
    expect(classifyMessage(msg)).toBe<MessageCategory>('ai');
  });
});

// ---------------------------------------------------------------------------
// buildChunks
// ---------------------------------------------------------------------------

describe('buildChunks', () => {
  it('should create user and ai chunks from alternating messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Hi')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('user');
    expect(chunks[0].messages).toHaveLength(1);
    expect(chunks[1].type).toBe('ai');
    expect(chunks[1].messages).toHaveLength(1);
  });

  it('should group consecutive AI messages into a single AI chunk', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Let me think...')] }),
      makeMsg({
        id: 'tr1',
        role: 'user',
        isMeta: true,
        content: [textBlock('tool result')],
        toolResults: [{ toolCallId: 'tc1', content: 'result', isError: false }],
      }),
      makeMsg({ id: 'a2', role: 'assistant', content: [textBlock('Done!')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('user');
    // All 3 AI-classified messages grouped together
    expect(chunks[1].type).toBe('ai');
    expect(chunks[1].messages).toHaveLength(3);
  });

  it('should filter out hard noise messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'noise', role: 'system', isMeta: true }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Hi')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(2);
    // No system chunk — hard noise was filtered
    expect(chunks.map((c) => c.type)).toEqual(['user', 'ai']);
  });

  it('should filter out sidechain messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({
        id: 'side1',
        role: 'assistant',
        isSidechain: true,
        content: [textBlock('subagent')],
      }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Done')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(2);
    expect(chunks[1].type).toBe('ai');
    expect(chunks[1].messages).toHaveLength(1);
    expect(chunks[1].messages[0].id).toBe('a1');
  });

  it('should create system chunks for command output', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Running command')] }),
      makeMsg({
        id: 'sys1',
        role: 'user',
        content: [textBlock('<local-command-stdout>output</local-command-stdout>')],
      }),
      makeMsg({ id: 'a2', role: 'assistant', content: [textBlock('Command done')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(4);
    expect(chunks[0].type).toBe('user');
    expect(chunks[1].type).toBe('ai');
    expect(chunks[1].messages).toHaveLength(1); // a1 flushed before system
    expect(chunks[2].type).toBe('system');
    expect(chunks[3].type).toBe('ai');
    expect(chunks[3].messages).toHaveLength(1); // a2
  });

  it('should create compact chunks', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Response')] }),
      makeMsg({
        id: 'compact1',
        role: 'assistant',
        isCompactSummary: true,
        content: [textBlock('Summary of conversation...')],
      }),
      makeMsg({ id: 'u2', role: 'user', content: [textBlock('Continue')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(4);
    expect(chunks[0].type).toBe('user');
    expect(chunks[1].type).toBe('ai');
    expect(chunks[2].type).toBe('compact');
    expect(chunks[3].type).toBe('user');
  });

  it('should assign sequential chunk IDs', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Hello')] }),
      makeMsg({ id: 'a1', role: 'assistant', content: [textBlock('Hi')] }),
      makeMsg({ id: 'u2', role: 'user', content: [textBlock('Bye')] }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks.map((c) => c.id)).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
  });

  it('should handle empty message list', () => {
    expect(buildChunks([])).toEqual([]);
  });

  it('should populate semantic steps on AI chunks', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig' },
          textBlock('Here is my answer'),
        ],
      }),
    ];

    const chunks = buildChunks(messages);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('ai');
    if (chunks[0].type === 'ai') {
      expect(chunks[0].semanticSteps).toHaveLength(2);
      expect(chunks[0].semanticSteps[0].type).toBe('thinking');
      expect(chunks[0].semanticSteps[1].type).toBe('output');
      expect(chunks[0].turns).toHaveLength(1);
      expect(chunks[0].turns[0].id).toBe('turn-a1');
      expect(chunks[0].turns[0].steps.map((step) => step.type)).toEqual(['thinking', 'output']);
    }
  });

  it('should keep fixture tool_result user messages inside AI chunks', async () => {
    const fixturePath = path.join(__dirname, '..', '__fixtures__', 'session-with-tools.jsonl');
    const parsed = await parseClaudeJsonl(fixturePath);

    const chunks = buildChunks(parsed.messages);
    expect(chunks.map((c) => c.type)).toEqual(['user', 'ai', 'user', 'ai']);

    const firstAiChunk = chunks[1];
    expect(firstAiChunk.type).toBe('ai');
    expect(firstAiChunk.messages.map((m) => m.id)).toEqual(['a-101', 'u-102', 'a-102']);
    expect(firstAiChunk.messages[1].toolResults).toHaveLength(1);

    const secondAiChunk = chunks[3];
    expect(secondAiChunk.type).toBe('ai');
    expect(secondAiChunk.messages.map((m) => m.id)).toEqual(['a-103', 'u-104', 'a-104']);
    expect(secondAiChunk.messages[1].toolResults).toHaveLength(1);
  });

  it('should link fixture semantic tool_call and tool_result steps by toolCallId', async () => {
    const fixturePath = path.join(__dirname, '..', '__fixtures__', 'session-with-tools.jsonl');
    const parsed = await parseClaudeJsonl(fixturePath);

    const chunks = buildChunks(parsed.messages);
    const aiSteps = chunks
      .filter(
        (chunk): chunk is Extract<(typeof chunks)[number], { type: 'ai' }> => chunk.type === 'ai',
      )
      .flatMap((chunk) => chunk.semanticSteps);

    const toolCallStep = aiSteps.find(
      (step) => step.type === 'tool_call' && step.content.toolCallId === 'tool-001',
    );
    const toolResultStep = aiSteps.find(
      (step) => step.type === 'tool_result' && step.content.toolCallId === 'tool-001',
    );

    expect(toolCallStep).toBeDefined();
    expect(toolResultStep).toBeDefined();
    expect(toolCallStep?.content.toolCallId).toBe(toolResultStep?.content.toolCallId);

    // Task tool uses are represented as subagent steps and should still link by toolCallId.
    const subagentStep = aiSteps.find(
      (step) => step.type === 'subagent' && step.content.toolCallId === 'tool-002',
    );
    const subagentResultStep = aiSteps.find(
      (step) => step.type === 'tool_result' && step.content.toolCallId === 'tool-002',
    );
    expect(subagentStep).toBeDefined();
    expect(subagentResultStep).toBeDefined();
  });

  it('should assign fixture tool_result steps to the turn containing the matching call', async () => {
    const fixturePath = path.join(__dirname, '..', '__fixtures__', 'session-with-tools.jsonl');
    const parsed = await parseClaudeJsonl(fixturePath);
    const chunks = buildChunks(parsed.messages);

    const firstAiChunk = chunks[1];
    expect(firstAiChunk.type).toBe('ai');
    const firstToolResultTurn = firstAiChunk.turns.find((turn) =>
      turn.steps.some(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tool-001',
      ),
    );
    expect(firstToolResultTurn?.assistantMessageId).toBe('a-101');

    const secondAiChunk = chunks[3];
    expect(secondAiChunk.type).toBe('ai');
    const secondToolResultTurn = secondAiChunk.turns.find((turn) =>
      turn.steps.some(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tool-002',
      ),
    );
    expect(secondToolResultTurn?.assistantMessageId).toBe('a-103');
  });
});

// ---------------------------------------------------------------------------
// computeChunkMetrics
// ---------------------------------------------------------------------------

describe('computeChunkMetrics', () => {
  it('should sum token usage across messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'a1', role: 'assistant', usage: usage(100, 50, 10, 5) }),
      makeMsg({ id: 'a2', role: 'assistant', usage: usage(200, 100, 20, 10) }),
    ];

    const metrics = computeChunkMetrics(messages);

    expect(metrics.inputTokens).toBe(300);
    expect(metrics.outputTokens).toBe(150);
    expect(metrics.cacheReadTokens).toBe(30);
    expect(metrics.cacheCreationTokens).toBe(15);
    expect(metrics.totalTokens).toBe(495);
    expect(metrics.messageCount).toBe(2);
  });

  it('should handle messages without usage', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user' }),
      makeMsg({ id: 'a1', role: 'assistant', usage: usage(100, 50) }),
    ];

    const metrics = computeChunkMetrics(messages);

    expect(metrics.inputTokens).toBe(100);
    expect(metrics.outputTokens).toBe(50);
    expect(metrics.totalTokens).toBe(150);
    expect(metrics.messageCount).toBe(2);
  });

  it('should compute durationMs from first to last timestamp', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
      }),
      makeMsg({
        id: 'a2',
        role: 'assistant',
        timestamp: new Date('2026-01-01T10:00:05.000Z'),
      }),
    ];

    const metrics = computeChunkMetrics(messages);

    expect(metrics.durationMs).toBe(5000);
  });

  it('should return zero metrics for empty messages', () => {
    const metrics = computeChunkMetrics([]);

    expect(metrics.totalTokens).toBe(0);
    expect(metrics.messageCount).toBe(0);
    expect(metrics.durationMs).toBe(0);
  });
});
