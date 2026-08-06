/**
 * Unit + regression tests for the unified assistant-turn coalescer (Phase:1 Task:1).
 *
 * Part 1 (pure unit): the merge rule + every boundary + metric recompute + purity +
 * idempotency, over hand-built `UnifiedMessage[]`.
 * Part 2 (regression): a REAL Claude and a REAL Codex tool turn, parsed by their own
 * parsers, must be UNCHANGED by the coalescer (the parsers already coalesce → proven no-op).
 */
import { coalesceAssistantTurns, sumTokenUsage } from './coalesce-turns';
import type { UnifiedMessage, UnifiedMetrics, TokenUsage } from '../../dtos/unified-session.types';

// Parsers are required AFTER a logger mock (mirrors the per-parser specs).
const mockLoggerWarn = jest.fn();
jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));
/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { parseClaudeJsonl } =
  require('../../parsers/claude-jsonl.parser') as typeof import('../../parsers/claude-jsonl.parser');
const { parseCodexJsonl } =
  require('../../parsers/codex-jsonl.parser') as typeof import('../../parsers/codex-jsonl.parser');
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let seq = 0;
function msg(role: UnifiedMessage['role'], over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    parentId: null,
    role,
    timestamp: new Date(1_706_000_000_000 + seq * 1000),
    content: [{ type: 'text', text: `c${seq}` }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...over,
  };
}

/** An assistant with an EXPLICIT open-turn continuation signal. */
const open = (over: Partial<UnifiedMessage> = {}) =>
  msg('assistant', { stopReason: 'tool_use', ...over });
/** An assistant that completed its turn. */
const done = (over: Partial<UnifiedMessage> = {}) =>
  msg('assistant', { stopReason: 'end_turn', ...over });

function metrics(over: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    totalTokens: 165,
    totalContextConsumption: 100,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 777,
    contextWindowTokens: 200_000,
    costUsd: 0.01,
    primaryModel: 'claude-opus-4-6',
    durationMs: 5000,
    messageCount: 99, // deliberately wrong → recompute must correct it on a merge
    isOngoing: false,
    ...over,
  };
}

const run = (messages: UnifiedMessage[], m: Partial<UnifiedMetrics> = {}) =>
  coalesceAssistantTurns({ messages, metrics: metrics(m) });

beforeEach(() => {
  seq = 0;
});

// ---------------------------------------------------------------------------
// Part 1: merge rule
// ---------------------------------------------------------------------------

describe('coalesceAssistantTurns — merge rule', () => {
  it('merges a continuation assistant onto an OPEN (tool_use) preceding turn', () => {
    const u = msg('user');
    const a1 = open({ toolCalls: [{ id: 't1', name: 'read', input: {}, isTask: false }] });
    const a2 = done({ content: [{ type: 'text', text: 'final' }] });

    const { messages } = run([u, a1, a2]);

    expect(messages.map((x) => x.role)).toEqual(['user', 'assistant']);
    // content + toolCalls concatenated in order onto the merged turn.
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'c2' },
      { type: 'text', text: 'final' },
    ]);
    expect(messages[1].toolCalls.map((c) => c.id)).toEqual(['t1']);
    // the merged turn adopts the LAST step's completion signal.
    expect(messages[1].stopReason).toBe('end_turn');
  });

  it('collapses an N-round turn (multiple tool_use steps) into one assistant', () => {
    const { messages } = run([msg('user'), open(), open(), open(), done()]);
    expect(messages).toHaveLength(2);
    expect(messages.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(messages[1].stopReason).toBe('end_turn');
  });

  it('keeps the turn OPEN across steps and stays open if it never completes (ongoing)', () => {
    const { messages } = run([msg('user'), open(), open()]);
    expect(messages).toHaveLength(2);
    expect(messages[1].stopReason).toBe('tool_use'); // still open
  });

  it('sums usage across the merged steps', () => {
    const usage = (n: number): TokenUsage => ({
      input: n,
      output: n,
      cacheRead: n,
      cacheCreation: n,
    });
    const { messages } = run([msg('user'), open({ usage: usage(10) }), done({ usage: usage(5) })]);
    expect(messages[1].usage).toEqual({ input: 15, output: 15, cacheRead: 15, cacheCreation: 15 });
  });
});

// ---------------------------------------------------------------------------
// Part 1: boundaries (fail-safe)
// ---------------------------------------------------------------------------

describe('coalesceAssistantTurns — boundaries', () => {
  it('undefined stopReason on the preceding turn is a BOUNDARY (fail-safe, never merges)', () => {
    const a1 = msg('assistant', { stopReason: undefined });
    const a2 = msg('assistant', { stopReason: undefined });
    const { messages } = run([msg('user'), a1, a2]);
    expect(messages).toHaveLength(3); // no merge
  });

  it("'end_turn' on the preceding turn is a BOUNDARY", () => {
    const { messages } = run([msg('user'), done(), done()]);
    expect(messages).toHaveLength(3);
  });

  it('a real USER message between two assistants is a BOUNDARY', () => {
    const { messages } = run([msg('user'), open(), msg('user'), done()]);
    expect(messages.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('an isCompactSummary entry neither merges nor opens a turn', () => {
    const { messages } = run([open(), open({ isCompactSummary: true }), open()]);
    // first opens; compact-summary is a boundary (no merge, no open); third opens but nothing follows.
    expect(messages).toHaveLength(3);
  });

  it('an isSidechain mismatch is a BOUNDARY', () => {
    const { messages } = run([open({ isSidechain: false }), done({ isSidechain: true })]);
    expect(messages).toHaveLength(2); // different sidechain context → not merged
  });

  it('merges WITHIN a sidechain (matching isSidechain) on the open signal', () => {
    const { messages } = run([open({ isSidechain: true }), done({ isSidechain: true })]);
    expect(messages).toHaveLength(1);
    expect(messages[0].isSidechain).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 1: metrics, purity, no-op, idempotency
// ---------------------------------------------------------------------------

describe('coalesceAssistantTurns — metrics + invariants', () => {
  it('recomputes messageCount = messages.length and preserves totalContextTokens (no sum)', () => {
    const { messages, metrics: m } = run([msg('user'), open(), done()], {
      totalContextTokens: 777,
    });
    expect(messages).toHaveLength(2);
    expect(m.messageCount).toBe(2); // recomputed from 99
    expect(m.messageCount).toBe(messages.length);
    expect(m.totalContextTokens).toBe(777); // last-step snapshot, NOT summed
    expect(m.costUsd).toBe(0.01); // untouched passthrough
  });

  it('does NOT mutate the input messages (purity)', () => {
    const a1 = open({ content: [{ type: 'text', text: 'first' }] });
    const before = a1.content.length;
    run([msg('user'), a1, done()]);
    expect(a1.content).toHaveLength(before); // the original turn object is never folded into
  });

  it('returns the ORIGINAL messages array reference on a true no-op', () => {
    const input = [msg('user'), done(), msg('user'), done()];
    const result = coalesceAssistantTurns({ messages: input, metrics: metrics() });
    expect(result.messages).toBe(input); // reference-identical → caller can skip rebuilds
  });

  it('is idempotent: coalesce(coalesce(x)) deep-equals coalesce(x)', () => {
    const input = [msg('user'), open(), open(), done(), msg('user'), open(), done()];
    const once = coalesceAssistantTurns({ messages: input, metrics: metrics() });
    const twice = coalesceAssistantTurns({ messages: once.messages, metrics: once.metrics });
    expect(twice.messages).toEqual(once.messages);
    expect(twice.metrics).toEqual(once.metrics);
    expect(twice.messages).toBe(once.messages); // second pass is a no-op → same reference
  });

  it('an empty session is a no-op', () => {
    const result = coalesceAssistantTurns({ messages: [], metrics: metrics({ messageCount: 0 }) });
    expect(result.messages).toEqual([]);
  });
});

describe('sumTokenUsage', () => {
  it('is undefined-safe in both directions and additive', () => {
    const a: TokenUsage = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 };
    expect(sumTokenUsage(undefined, a)).toEqual(a);
    expect(sumTokenUsage(a, undefined)).toBe(a);
    expect(sumTokenUsage(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheCreation: 8 });
  });
});

// ---------------------------------------------------------------------------
// Part 2: real-parser no-op regression (Claude sets stopReason; Codex does not)
// ---------------------------------------------------------------------------

function writeJsonl(prefix: string, lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return filePath;
}

describe('coalesceAssistantTurns — Claude full-parse output UNCHANGED (no-op regression)', () => {
  it('leaves a parsed Claude tool turn reference-identical', async () => {
    const file = writeJsonl('claude-coalesce-', [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { role: 'user', content: 'fix the bug' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', id: 'tc1', name: 'read', input: { path: '/x' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        isSidechain: false,
        isMeta: true,
        timestamp: '2026-01-01T10:00:06.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'data', is_error: false }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:20.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 40 },
        },
      },
    ]);
    const session = await parseClaudeJsonl(file);
    expect(session.metrics.messageCount).toBe(2); // sanity: parser already coalesced

    const result = coalesceAssistantTurns(session);
    expect(result.messages).toBe(session.messages); // no-op: reference-identical
    expect(result.metrics.messageCount).toBe(session.metrics.messageCount);
  });
});

describe('coalesceAssistantTurns — Codex full-parse output UNCHANGED (no-op regression)', () => {
  it('leaves a parsed Codex tool turn reference-identical (no stopReason → fail-safe boundary)', async () => {
    const line = (timestamp: string, type: string, payload: object) => ({
      timestamp,
      type,
      payload,
    });
    const item = (timestamp: string, payload: object) => line(timestamp, 'response_item', payload);
    const file = writeJsonl('codex-coalesce-', [
      line('2026-02-24T10:00:00.000Z', 'session_meta', {
        id: 'codex-1',
        cwd: '/p',
        cli_version: '0.77.0',
        source: 'Cli',
        model_provider: 'openai',
      }),
      line('2026-02-24T10:00:01.000Z', 'turn_context', {
        model: 'o3',
        approval_policy: 'on-request',
      }),
      line('2026-02-24T10:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn_001' }),
      item('2026-02-24T10:00:03.000Z', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'fix the bug' }],
      }),
      item('2026-02-24T10:00:05.000Z', {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: JSON.stringify({ path: '/x' }),
      }),
      item('2026-02-24T10:00:06.000Z', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'data',
      }),
      item('2026-02-24T10:00:08.000Z', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      }),
      line('2026-02-24T10:00:09.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn_001' }),
    ]);
    const session = await parseCodexJsonl(file);
    const before = session.metrics.messageCount;

    const result = coalesceAssistantTurns(session);
    expect(result.messages).toBe(session.messages); // no-op: reference-identical
    expect(result.metrics.messageCount).toBe(before);
    // Codex assistants carry no stopReason → the pass can never merge them.
    expect(session.messages.every((m) => m.stopReason === undefined || m.stopReason === null)).toBe(
      true,
    );
  });
});
