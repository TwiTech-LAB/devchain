import * as path from 'node:path';
import { buildChunks, classifyMessage, computeChunkMetrics } from './chunk-builder';
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import { coalesceAssistantTurns } from '../adapters/utils/coalesce-turns';
import type {
  UnifiedMessage,
  UnifiedMetrics,
  UnifiedToolCall,
  UnifiedToolResult,
  TokenUsage,
} from '../dtos/unified-session.types';
import type { AIChunk, MessageCategory, UnifiedChunk } from '../dtos/unified-chunk.types';

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

const ZERO_METRICS: UnifiedMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  totalContextConsumption: 0,
  compactionCount: 0,
  phaseBreakdowns: [],
  visibleContextTokens: 0,
  totalContextTokens: 0,
  contextWindowTokens: 0,
  costUsd: 0,
  primaryModel: '',
  durationMs: 0,
  messageCount: 0,
  isOngoing: false,
};

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

function expectAiChunk(chunk: UnifiedChunk | undefined): AIChunk {
  if (chunk?.type !== 'ai') {
    throw new Error(`expected an ai chunk, got ${chunk?.type ?? 'undefined'}`);
  }
  return chunk;
}

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

  it('should classify a meta tool-result user message (no text) as "ai" via the default', () => {
    // After the parser fold + continuation coalesce, standalone tool_result user messages no
    // longer reach the chunk builder; a leftover meta tool-result (no text) still falls to the
    // default 'ai' classification (isMeta blocks the 'user' branch), keeping it inside the turn.
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

  it('renders a BIG coalesced assistant (many tool steps) as ONE ai chunk with all steps in order (no chunk-budget regression)', () => {
    // After the cross-provider coalesce, a single assistant turn can carry MANY tool
    // rounds (calls + results + intermediate texts) on one message. This locks two
    // things: (1) rendering is preserved — every step still appears, in order, inside
    // the one AI chunk; (2) the turn stays a SINGLE message, so it can never blow the
    // pagination chunk budget (`session-reader.service.ts` MAX_CHUNK_SIZE=100 caps
    // MESSAGES per page, and a coalesced turn is exactly 1 message — strictly safer
    // than the pre-coalesce N+1 inflation). N=5 rounds is well past any realistic turn.
    const ROUNDS = 5;
    const content: UnifiedMessage['content'] = [textBlock('Starting.')];
    const toolCalls: UnifiedToolCall[] = [];
    const toolResults: UnifiedToolResult[] = [];
    for (let i = 1; i <= ROUNDS; i++) {
      const id = `tc-${i}`;
      content.push({
        type: 'tool_call',
        toolCallId: id,
        toolName: 'read',
        input: { path: `/f${i}` },
      });
      content.push({ type: 'tool_result', toolCallId: id, content: `out-${i}`, isError: false });
      content.push(textBlock(`After round ${i}.`));
      toolCalls.push({ id, name: 'read', input: { path: `/f${i}` }, isTask: false });
      toolResults.push({ toolCallId: id, content: `out-${i}`, isError: false });
    }
    content.push(textBlock('All done.'));
    const messages: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Do the work')] }),
      makeMsg({
        id: 'a-coalesced',
        role: 'assistant',
        content,
        toolCalls,
        toolResults,
        usage: usage(1000, 500, 50, 20),
      }),
    ];

    const chunks = buildChunks(messages);

    // ONE user chunk + ONE ai chunk (the coalesced assistant is not split).
    expect(chunks.map((c) => c.type)).toEqual(['user', 'ai']);
    const aiChunk = chunks[1];
    expect(aiChunk.type).toBe('ai');
    if (aiChunk.type === 'ai') {
      // The turn is a SINGLE message — the chunk-budget invariant (no inflation).
      expect(aiChunk.messages).toHaveLength(1);
      expect(aiChunk.messages[0].id).toBe('a-coalesced');

      // Rendering preserved: every content block still appears, in original order.
      const kinds = aiChunk.messages[0].content.map((b) => b.type);
      expect(kinds).toEqual(content.map((b) => b.type));
      expect(kinds.filter((k) => k === 'tool_call')).toHaveLength(ROUNDS);
      expect(kinds.filter((k) => k === 'tool_result')).toHaveLength(ROUNDS);
      // Final block is the assistant's closing text.
      expect(kinds[kinds.length - 1]).toBe('text');

      // Every tool call + its result is linked by toolCallId (no data loss).
      expect(aiChunk.messages[0].toolCalls).toHaveLength(ROUNDS);
      expect(aiChunk.messages[0].toolResults).toHaveLength(ROUNDS);

      // Semantic extraction surfaces every round (5 calls + 5 results).
      expect(aiChunk.semanticSteps.filter((s) => s.type === 'tool_call')).toHaveLength(ROUNDS);
      expect(aiChunk.semanticSteps.filter((s) => s.type === 'tool_result')).toHaveLength(ROUNDS);

      // Chunk metrics: usage summed onto the single message, messageCount = 1 (no budget blow).
      expect(aiChunk.metrics.inputTokens).toBe(1000);
      expect(aiChunk.metrics.outputTokens).toBe(500);
      expect(aiChunk.metrics.messageCount).toBe(1);
    }
  });

  it('preserves semantic-step ORDER when coalescing a multi-row turn (tool-calls → tool-calls → stop)', () => {
    // A real multi-step turn arrives as SEPARATE assistant messages (one per model
    // invocation), each with a continuation signal (stopReason='tool_use') except
    // the last (stopReason='end_turn'). The coalescer folds them into ONE assistant;
    // this test proves the fold preserves content-block order — no steps are lost,
    // reordered, or duplicated — so rendering is unchanged after coalescing.
    const step1 = makeMsg({
      id: 'a1',
      role: 'assistant',
      stopReason: 'tool_use',
      content: [
        textBlock('Let me check.'),
        { type: 'tool_call', toolCallId: 'tc-1', toolName: 'read', input: { path: '/f1' } },
      ],
      toolCalls: [{ id: 'tc-1', name: 'read', input: { path: '/f1' }, isTask: false }],
      toolResults: [{ toolCallId: 'tc-1', content: 'out-1', isError: false }],
    });
    const step2 = makeMsg({
      id: 'a2',
      role: 'assistant',
      stopReason: 'tool_use',
      content: [
        textBlock('Applying the fix.'),
        { type: 'tool_call', toolCallId: 'tc-2', toolName: 'write', input: { path: '/f1' } },
      ],
      toolCalls: [{ id: 'tc-2', name: 'write', input: { path: '/f1' }, isTask: false }],
      toolResults: [{ toolCallId: 'tc-2', content: 'ok', isError: false }],
    });
    const step3 = makeMsg({
      id: 'a3',
      role: 'assistant',
      stopReason: 'end_turn',
      content: [textBlock('All done.')],
    });

    const preCoalesce: UnifiedMessage[] = [
      makeMsg({ id: 'u1', role: 'user', content: [textBlock('Do the work')] }),
      step1,
      step2,
      step3,
    ];

    // Expected content order = concatenation of all 3 rows' content blocks.
    const expectedContentKinds = [
      ...step1.content.map((b) => b.type),
      ...step2.content.map((b) => b.type),
      ...step3.content.map((b) => b.type),
    ];

    // Coalesce (the shared central pass in getOrParse).
    const coalesced = coalesceAssistantTurns({
      messages: preCoalesce,
      metrics: { ...ZERO_METRICS, messageCount: preCoalesce.length },
    });

    // The 3 assistant rows folded into ONE → 2 messages total.
    expect(coalesced.messages).toHaveLength(2);
    expect(coalesced.metrics.messageCount).toBe(2);

    // Build chunks from the coalesced session.
    const chunks = buildChunks(coalesced.messages);
    expect(chunks.map((c) => c.type)).toEqual(['user', 'ai']);

    const aiChunk = chunks[1];
    expect(aiChunk.type).toBe('ai');
    if (aiChunk.type === 'ai') {
      // The folded assistant is a SINGLE message.
      expect(aiChunk.messages).toHaveLength(1);
      // Content-block order preserved across the folded rows (rendering invariant).
      const kinds = aiChunk.messages[0].content.map((b) => b.type);
      expect(kinds).toEqual(expectedContentKinds);
      // Semantic extraction surfaces every round in order.
      expect(aiChunk.semanticSteps.filter((s) => s.type === 'tool_call')).toHaveLength(2);
      // Both tool calls + results linked (no data loss).
      expect(aiChunk.messages[0].toolCalls).toHaveLength(2);
      expect(aiChunk.messages[0].toolResults).toHaveLength(2);
      // Final content block is the assistant's closing text.
      expect(kinds[kinds.length - 1]).toBe('text');
    }
  });

  it('folds fixture tool_result entries onto the assistant turn inside AI chunks', async () => {
    const fixturePath = path.join(__dirname, '..', '__fixtures__', 'session-with-tools.jsonl');
    const parsed = await parseClaudeJsonl(fixturePath);

    const chunks = buildChunks(parsed.messages);
    expect(chunks.map((c) => c.type)).toEqual(['user', 'ai', 'user', 'ai']);

    // u-102/u-104 fold onto a-101/a-103 AND the continuation assistants a-102/a-104 coalesce
    // onto a-101/a-103 — each tool turn is a single assistant message in the AI chunk.
    const firstAiChunk = expectAiChunk(chunks[1]);
    expect(firstAiChunk.messages.map((m) => m.id)).toEqual(['a-101']);
    expect(firstAiChunk.messages[0].toolResults).toHaveLength(1);

    const secondAiChunk = expectAiChunk(chunks[3]);
    expect(secondAiChunk.messages.map((m) => m.id)).toEqual(['a-103']);
    expect(secondAiChunk.messages[0].toolResults).toHaveLength(1);
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

    const firstAiChunk = expectAiChunk(chunks[1]);
    const firstToolResultTurn = firstAiChunk.turns.find((turn) =>
      turn.steps.some(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tool-001',
      ),
    );
    expect(firstToolResultTurn?.assistantMessageId).toBe('a-101');

    const secondAiChunk = expectAiChunk(chunks[3]);
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

// The builder unit layer can compare every derived field and force a yield inside one AI run.
describe('cooperative chunk building', () => {
  it('matches synchronous chunks while yielding within a large single AI chunk', async () => {
    const { buildChunksCooperatively } = await import('./chunk-builder');
    const messages = [
      makeMsg({ id: 'user', role: 'user', content: [textBlock('question')] }),
      ...Array.from({ length: 20000 }, (_, i) =>
        makeMsg({
          id: `assistant-${i}`,
          role: 'assistant',
          content: [textBlock(`answer ${i}`)],
          usage: usage(10, 20),
        }),
      ),
      makeMsg({ id: 'side', role: 'assistant', isSidechain: true }),
      makeMsg({ id: 'compact', role: 'user', isCompactSummary: true }),
    ];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let result;
    try {
      result = await buildChunksCooperatively(messages);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(result).toEqual(buildChunks(messages));
  });
});
