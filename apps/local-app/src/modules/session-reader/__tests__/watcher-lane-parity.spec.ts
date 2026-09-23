/**
 * Metrics-only lane ↔ body-path parity.
 *
 * For a Claude transcript exercising the fold/merge edge cases (tool-result folds, a
 * continuation assistant, an `end_turn` tail that must NOT over-merge, a sidechain, and a
 * compact summary both before and inside a slice), the watcher's metrics-only lane must report
 * the SAME summary as the cached body path when the file is cut at each line boundary and the
 * remainder appended. Both paths share the parser, the boundary fold, and mergeMetrics; this
 * pins the lane-specific derivation (running visible sum, tail descriptor, timestamps).
 *
 * It also asserts the lane never populates the parsed cache (zero entries, zero budget).
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionCacheService } from '../services/session-cache.service';
import { TranscriptWatcherService } from '../services/transcript-watcher.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import { CodexSessionReaderAdapter } from '../adapters/codex-session-reader.adapter';
import type { EventsService } from '../../events/services/events.service';
import type { PricingServiceInterface } from '../services/pricing.interface';
import type { UnifiedMetrics } from '../dtos/unified-session.types';

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.002),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

const mockEvents = { publish: jest.fn().mockResolvedValue('event-id') } as unknown as EventsService;

// --- Claude JSONL builders -------------------------------------------------

interface AssistantOpts {
  stopReason?: string | null;
  model?: string;
  sidechain?: boolean;
  toolUse?: boolean;
  tokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
}

function userLine(uuid: string, parent: string | null, ts: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    isSidechain: false,
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}

function toolResultLine(uuid: string, parent: string, ts: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    isSidechain: false,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok, 3 files' }],
    },
  });
}

function compactSummaryLine(uuid: string, parent: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: parent,
    isSidechain: false,
    isCompactSummary: true,
    timestamp: ts,
    message: { role: 'user', content: 'Summary of the conversation so far.' },
  });
}

function assistantLine(
  uuid: string,
  parent: string,
  ts: string,
  text: string,
  opts: AssistantOpts = {},
): string {
  const content: unknown[] = [{ type: 'text', text }];
  if (opts.toolUse) {
    content.push({ type: 'tool_use', id: `tool-${uuid}`, name: 'listFiles', input: { path: '.' } });
  }
  const t = opts.tokens ?? { input: 120, output: 60 };
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    isSidechain: opts.sidechain ?? false,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-6',
      content,
      stop_reason: opts.stopReason === undefined ? 'end_turn' : opts.stopReason,
      usage: {
        input_tokens: t.input,
        output_tokens: t.output,
        cache_read_input_tokens: t.cacheRead ?? 0,
        cache_creation_input_tokens: t.cacheCreation ?? 0,
      },
    },
  });
}

// A transcript whose line boundaries cover every fold/merge edge case.
const LINES: string[] = [
  userLine('u1', null, '2026-01-15T10:00:00.000Z', 'List files'), // 0
  assistantLine('a1', 'u1', '2026-01-15T10:00:05.000Z', 'Calling tool', {
    stopReason: 'tool_use',
    toolUse: true,
  }), // 1
  toolResultLine('tr1', 'a1', '2026-01-15T10:00:06.000Z', 'tool-a1'), // 2 (folds onto a1)
  assistantLine('a2', 'tr1', '2026-01-15T10:00:07.000Z', 'Here are the files'), // 3 (continues a1)
  userLine('u2', 'a2', '2026-01-15T10:00:30.000Z', 'Explain more'), // 4
  assistantLine('a3', 'u2', '2026-01-15T10:00:35.000Z', 'Part one', {
    stopReason: null,
    model: 'claude-opus-4-6',
  }), // 5 (ongoing, second model)
  assistantLine('a4', 'a3', '2026-01-15T10:00:40.000Z', 'Part two', {
    model: 'claude-opus-4-6',
  }), // 6 (continuation of a3)
  userLine('u3', 'a4', '2026-01-15T10:01:00.000Z', 'Again'), // 7
  assistantLine('a5', 'u3', '2026-01-15T10:01:05.000Z', 'Done once'), // 8 (end_turn)
  assistantLine('a6', 'a5', '2026-01-15T10:01:10.000Z', 'Separate turn'), // 9 (must NOT fold onto a5)
  assistantLine('side1', 'a6', '2026-01-15T10:01:12.000Z', 'sidechain note', {
    sidechain: true,
  }), // 10 (sidechain transition)
  compactSummaryLine('c1', 'a6', '2026-01-15T10:02:00.000Z'), // 11 (compaction boundary)
  userLine('u4', 'c1', '2026-01-15T10:02:10.000Z', 'After compaction'), // 12
  assistantLine('a7', 'u4', '2026-01-15T10:02:15.000Z', 'Fresh context', {
    tokens: { input: 200, output: 90, cacheRead: 50 },
  }), // 13
];

const PARITY_FIELDS: (keyof UnifiedMetrics)[] = [
  'messageCount',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'totalTokens',
  'costUsd',
  'primaryModel',
  'contextWindowTokens',
  'totalContextTokens',
  'visibleContextTokens',
  'durationMs',
  'isOngoing',
];

function pick(metrics: UnifiedMetrics): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PARITY_FIELDS) out[field] = metrics[field];
  out.modelsUsed = metrics.modelsUsed ? [...metrics.modelsUsed].sort() : undefined;
  return out;
}

function newCache(): SessionCacheService {
  return new SessionCacheService({
    registerCacheStatsProvider: jest.fn(),
    registerStatsProvider: jest.fn(),
  } as never);
}

function newWatcher(cache: SessionCacheService): TranscriptWatcherService {
  const factory = new SessionReaderAdapterFactory();
  factory.registerAdapter(new ClaudeSessionReaderAdapter(mockPricing));
  return new TranscriptWatcherService(cache, factory, mockEvents);
}

const realSetTimeout = globalThis.setTimeout;
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => realSetTimeout(r, 5));
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}
async function advancePollCycle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    jest.advanceTimersByTime(3000);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();
  }
}

describe('metrics-only lane ↔ body-path parity (Claude)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lane-parity-'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function bodyMetrics(cut: number, file: string): Promise<UnifiedMetrics> {
    const cache = newCache();
    try {
      const factory = new SessionReaderAdapterFactory();
      const adapter = new ClaudeSessionReaderAdapter(mockPricing);
      factory.registerAdapter(adapter);
      await fsp.writeFile(file, LINES.slice(0, cut).join('\n') + '\n', 'utf8');
      await cache.getOrParseWithMeta('body', file, adapter); // seed an entry at the prefix
      await flush();
      await fsp.writeFile(file, LINES.join('\n') + '\n', 'utf8'); // append the remainder
      const result = await cache.getOrParseWithMeta('body', file, adapter); // incremental merge
      await flush();
      return result.session.metrics;
    } finally {
      cache.onModuleDestroy();
    }
  }

  async function laneMetrics(
    cut: number,
    file: string,
  ): Promise<{ metrics: UnifiedMetrics; cacheEntries: number; budgetUsedBytes: number }> {
    const cache = newCache();
    const watcher = newWatcher(cache);
    try {
      await fsp.writeFile(file, LINES.slice(0, cut).join('\n') + '\n', 'utf8');
      await watcher.startWatching('lane', file, 'claude'); // seeds the lane, no entry
      await flush();
      await fsp.writeFile(file, LINES.join('\n') + '\n', 'utf8');
      await advancePollCycle();
      const metrics = watcher.getLastKnownSummaryMetrics('lane');
      if (!metrics) throw new Error('lane produced no summary metrics');
      return {
        metrics,
        cacheEntries: cache.size,
        budgetUsedBytes: cache.getCacheStats().budgetUsedBytes ?? 0,
      };
    } finally {
      watcher.onModuleDestroy();
      cache.onModuleDestroy();
    }
  }

  // Every interior line boundary: each cut lands the appended slice on a different edge case.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])(
    'lane summary equals the body-path summary when cut at line %i',
    async (cut) => {
      const body = await bodyMetrics(cut, path.join(tmpDir, `body-${cut}.jsonl`));
      const lane = await laneMetrics(cut, path.join(tmpDir, `lane-${cut}.jsonl`));

      expect(pick(lane.metrics)).toEqual(pick(body));
      // The lane never touches the parsed cache.
      expect(lane.cacheEntries).toBe(0);
      expect(lane.budgetUsedBytes).toBe(0);
    },
    20_000,
  );

  it('reports a non-trivial, ongoing-consistent summary (sanity anchor for parity)', async () => {
    const body = await bodyMetrics(4, path.join(tmpDir, 'body-anchor.jsonl'));
    expect(body.messageCount).toBeGreaterThan(3);
    expect(body.totalTokens).toBeGreaterThan(0);
    // The final assistant (a7) ends with end_turn → the session is not ongoing.
    expect(body.isOngoing).toBe(false);
  });

  it('lane seed of a compacted transcript reports the full-parse visibleContextTokens (before any append)', async () => {
    const file = path.join(tmpDir, 'seed-compacted.jsonl');
    await fsp.writeFile(file, LINES.join('\n') + '\n', 'utf8');

    // Body-path full parse (what a viewer sees at open): its visibleContextTokens counts the
    // compact-summary message, which the lane's MERGE-term accumulator deliberately does not.
    const bodyCache = newCache();
    const bodyFactory = new SessionReaderAdapterFactory();
    const bodyAdapter = new ClaudeSessionReaderAdapter(mockPricing);
    bodyFactory.registerAdapter(bodyAdapter);
    const body = (await bodyCache.getOrParseWithMeta('body', file, bodyAdapter)).session.metrics;
    bodyCache.onModuleDestroy();
    expect(body.visibleContextTokens).toBeGreaterThan(0);

    const cache = newCache();
    const watcher = newWatcher(cache);
    try {
      await watcher.startWatching('seed', file, 'claude');
      await flush();
      const seeded = watcher.getLastKnownSummaryMetrics('seed');
      expect(seeded).not.toBeNull();
      expect(seeded!.visibleContextTokens).toBe(body.visibleContextTokens);
      expect(cache.size).toBe(0);
    } finally {
      watcher.onModuleDestroy();
      cache.onModuleDestroy();
    }
  });
});

// --- Codex parity ----------------------------------------------------------

function codexMeta(): object {
  return {
    timestamp: '2026-02-24T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'codex-x' },
  };
}
function turnContext(model: string, ts: string): object {
  return { timestamp: ts, type: 'turn_context', payload: { model } };
}
function taskStarted(turnId: string, ts: string): object {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } };
}
function taskComplete(turnId: string, ts: string): object {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } };
}
function codexUser(text: string, ts: string): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}
function codexAssistant(text: string, ts: string): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}
function codexFnCall(callId: string, ts: string): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name: 'exec', arguments: '{"cmd":"ls"}' },
  };
}
function codexFnOutput(callId: string, ts: string): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: 'file-a\nfile-b' },
  };
}
function codexTokenCount(input: number, cached: number, output: number, ts: string): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
        model_context_window: 128000,
      },
    },
  };
}
function codexCompacted(ts: string): object {
  return { timestamp: ts, type: 'compacted', payload: { message: 'Compacted summary' } };
}

const CODEX_LINES: object[] = [
  codexMeta(), // 0
  turnContext('o3', '2026-02-24T10:00:01.000Z'), // 1
  taskStarted('t1', '2026-02-24T10:00:02.000Z'), // 2
  codexUser('Question one', '2026-02-24T10:00:03.000Z'), // 3
  codexAssistant('Answer one', '2026-02-24T10:00:05.000Z'), // 4
  codexFnCall('c1', '2026-02-24T10:00:06.000Z'), // 5
  codexFnOutput('c1', '2026-02-24T10:00:07.000Z'), // 6 (tool result folds)
  codexAssistant('Answer one continued', '2026-02-24T10:00:08.000Z'), // 7
  codexTokenCount(1000, 200, 500, '2026-02-24T10:00:09.000Z'), // 8
  taskComplete('t1', '2026-02-24T10:00:10.000Z'), // 9
  turnContext('gpt-5-codex', '2026-02-24T10:00:11.000Z'), // 10 (model change)
  taskStarted('t2', '2026-02-24T10:00:12.000Z'), // 11
  codexUser('Question two', '2026-02-24T10:01:00.000Z'), // 12
  codexAssistant('Answer two', '2026-02-24T10:01:02.000Z'), // 13
  codexTokenCount(1600, 400, 800, '2026-02-24T10:01:03.000Z'), // 14
  taskComplete('t2', '2026-02-24T10:01:04.000Z'), // 15
  codexCompacted('2026-02-24T10:02:00.000Z'), // 16 (compaction with summary)
  taskStarted('t3', '2026-02-24T10:02:01.000Z'), // 17
  codexUser('Question three', '2026-02-24T10:02:05.000Z'), // 18
  codexAssistant('Answer three', '2026-02-24T10:02:08.000Z'), // 19
  codexTokenCount(2100, 600, 1100, '2026-02-24T10:02:09.000Z'), // 20
  taskComplete('t3', '2026-02-24T10:02:10.000Z'), // 21
];

describe('metrics-only lane ↔ body-path parity (Codex)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lane-parity-codex-'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const serialize = (lines: object[]): string =>
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  async function bodyMetrics(cut: number, file: string): Promise<UnifiedMetrics> {
    const cache = newCache();
    try {
      const factory = new SessionReaderAdapterFactory();
      const adapter = new CodexSessionReaderAdapter(mockPricing);
      factory.registerAdapter(adapter);
      await fsp.writeFile(file, serialize(CODEX_LINES.slice(0, cut)), 'utf8');
      await cache.getOrParseWithMeta('body', file, adapter);
      await flush();
      await fsp.writeFile(file, serialize(CODEX_LINES), 'utf8');
      const result = await cache.getOrParseWithMeta('body', file, adapter);
      await flush();
      return result.session.metrics;
    } finally {
      cache.onModuleDestroy();
    }
  }

  async function laneMetrics(
    cut: number,
    file: string,
  ): Promise<{ metrics: UnifiedMetrics; cacheEntries: number }> {
    const cache = newCache();
    const factory = new SessionReaderAdapterFactory();
    factory.registerAdapter(new CodexSessionReaderAdapter(mockPricing));
    const watcher = new TranscriptWatcherService(cache, factory, mockEvents);
    try {
      await fsp.writeFile(file, serialize(CODEX_LINES.slice(0, cut)), 'utf8');
      await watcher.startWatching('lane', file, 'codex');
      await flush();
      await fsp.writeFile(file, serialize(CODEX_LINES), 'utf8');
      await advancePollCycle();
      const metrics = watcher.getLastKnownSummaryMetrics('lane');
      if (!metrics) throw new Error('lane produced no summary metrics');
      return { metrics, cacheEntries: cache.size };
    } finally {
      watcher.onModuleDestroy();
      cache.onModuleDestroy();
    }
  }

  it.each([4, 7, 9, 13, 15, 16, 19])(
    'lane summary equals the body-path summary when cut at line %i',
    async (cut) => {
      const body = await bodyMetrics(cut, path.join(tmpDir, `body-${cut}.jsonl`));
      const lane = await laneMetrics(cut, path.join(tmpDir, `lane-${cut}.jsonl`));
      expect(pick(lane.metrics)).toEqual(pick(body));
      expect(lane.cacheEntries).toBe(0);
    },
    20_000,
  );

  it('lane seed of a compacted transcript reports the full-parse visibleContextTokens (before any append)', async () => {
    const file = path.join(tmpDir, 'seed-compacted.jsonl');
    await fsp.writeFile(file, serialize(CODEX_LINES), 'utf8');

    const bodyCache = newCache();
    const bodyFactory = new SessionReaderAdapterFactory();
    const bodyAdapter = new CodexSessionReaderAdapter(mockPricing);
    bodyFactory.registerAdapter(bodyAdapter);
    const body = (await bodyCache.getOrParseWithMeta('body', file, bodyAdapter)).session.metrics;
    bodyCache.onModuleDestroy();
    expect(body.visibleContextTokens).toBeGreaterThan(0);

    const cache = newCache();
    const factory = new SessionReaderAdapterFactory();
    factory.registerAdapter(new CodexSessionReaderAdapter(mockPricing));
    const watcher = new TranscriptWatcherService(cache, factory, mockEvents);
    try {
      await watcher.startWatching('seed', file, 'codex');
      await flush();
      const seeded = watcher.getLastKnownSummaryMetrics('seed');
      expect(seeded).not.toBeNull();
      expect(seeded!.visibleContextTokens).toBe(body.visibleContextTokens);
      expect(cache.size).toBe(0);
    } finally {
      watcher.onModuleDestroy();
      cache.onModuleDestroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Unterminated last line.
//
// A full parse that caught the file mid-write — its final JSON line still being
// written — stores lastOffset = size but must store NO append proof, so the next
// change re-parses in full and the completed line is read exactly once. Real
// Claude and Codex parsers skip an incomplete final line, so without the rule the
// incremental would resume inside that line and drop the message.
// ---------------------------------------------------------------------------

const codexSerialize = (lines: object[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

async function fullMessageCount(
  adapter: ClaudeSessionReaderAdapter | CodexSessionReaderAdapter,
  file: string,
): Promise<number> {
  const cache = newCache();
  try {
    const result = await cache.getOrParseWithMeta('fresh', file, adapter);
    return result.session.messages.length;
  } finally {
    cache.onModuleDestroy();
  }
}

function hasUniqueIds(messages: { id: string }[]): boolean {
  const ids = messages.map((m) => m.id);
  return new Set(ids).size === ids.length;
}

describe('unterminated last line: full parse stores no append proof', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.useRealTimers();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unterminated-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('Claude: a full parse caught mid-line re-parses in full and loses no message', async () => {
    const cache = newCache();
    const adapter = new ClaudeSessionReaderAdapter(mockPricing);
    const file = path.join(tmpDir, 'claude-partial.jsonl');
    try {
      const k = 4; // LINES[4] is a fresh user message that must survive the round trip
      const head = LINES.slice(0, k).join('\n') + '\n';
      // Truncate the k-th line mid-JSON, with no trailing newline: the snapshot ends inside it.
      await fsp.writeFile(file, head + LINES[k].slice(0, 20), 'utf8');
      const first = await cache.getOrParseWithMeta('s', file, adapter);
      await fsp.writeFile(file, LINES.slice(0, k + 1).join('\n') + '\n', 'utf8');
      const second = await cache.getOrParseWithMeta('s', file, adapter);

      expect(second.sourceChangeKind).not.toBe('same-file-append'); // no mid-line incremental append
      expect(second.session.messages.length).toBe(
        await fullMessageCount(new ClaudeSessionReaderAdapter(mockPricing), file),
      );
      expect(second.session.messages.length).toBeGreaterThan(first.session.messages.length);
      expect(hasUniqueIds(second.session.messages)).toBe(true);
    } finally {
      cache.onModuleDestroy();
    }
  });

  it('Claude: a complete final line without a trailing newline is never lost or duplicated', async () => {
    const cache = newCache();
    const adapter = new ClaudeSessionReaderAdapter(mockPricing);
    const file = path.join(tmpDir, 'claude-nonewline.jsonl');
    try {
      const k = 4;
      // The final line is complete JSON but has no trailing newline (snapshot ends off a boundary).
      await fsp.writeFile(file, LINES.slice(0, k + 1).join('\n'), 'utf8');
      await cache.getOrParseWithMeta('s', file, adapter);
      await fsp.appendFile(file, '\n', 'utf8'); // the newline arrives
      const second = await cache.getOrParseWithMeta('s', file, adapter);

      expect(second.session.messages.length).toBe(
        await fullMessageCount(new ClaudeSessionReaderAdapter(mockPricing), file),
      );
      expect(hasUniqueIds(second.session.messages)).toBe(true);
    } finally {
      cache.onModuleDestroy();
    }
  });

  it('Claude: a newline-terminated snapshot keeps the incremental append path', async () => {
    const cache = newCache();
    const adapter = new ClaudeSessionReaderAdapter(mockPricing);
    const file = path.join(tmpDir, 'claude-terminated.jsonl');
    try {
      await fsp.writeFile(file, LINES.slice(0, 4).join('\n') + '\n', 'utf8'); // ends on a line boundary
      await cache.getOrParseWithMeta('s', file, adapter);
      await fsp.writeFile(file, LINES.slice(0, 6).join('\n') + '\n', 'utf8'); // grew, still terminated
      const second = await cache.getOrParseWithMeta('s', file, adapter);
      expect(second.sourceChangeKind).toBe('same-file-append'); // anchors stored → incremental
    } finally {
      cache.onModuleDestroy();
    }
  });

  it('Codex: a full parse caught mid-line re-parses in full and loses no message', async () => {
    const cache = newCache();
    const adapter = new CodexSessionReaderAdapter(mockPricing);
    const file = path.join(tmpDir, 'codex-partial.jsonl');
    try {
      const k = 4; // CODEX_LINES[4] is an assistant message
      const head = codexSerialize(CODEX_LINES.slice(0, k));
      await fsp.writeFile(file, head + JSON.stringify(CODEX_LINES[k]).slice(0, 25), 'utf8');
      await cache.getOrParseWithMeta('s', file, adapter);
      await fsp.writeFile(file, codexSerialize(CODEX_LINES.slice(0, k + 1)), 'utf8');
      const second = await cache.getOrParseWithMeta('s', file, adapter);

      expect(second.sourceChangeKind).not.toBe('same-file-append');
      expect(second.session.messages.length).toBe(
        await fullMessageCount(new CodexSessionReaderAdapter(mockPricing), file),
      );
      expect(hasUniqueIds(second.session.messages)).toBe(true);
    } finally {
      cache.onModuleDestroy();
    }
  });
});

describe('unterminated last line: metrics-only lane', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['setImmediate'] });
    jest.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lane-unterminated-'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('Claude lane: a seed off a line boundary matches a full parse after the line completes', async () => {
    const cache = newCache();
    const factory = new SessionReaderAdapterFactory();
    factory.registerAdapter(new ClaudeSessionReaderAdapter(mockPricing));
    const watcher = new TranscriptWatcherService(cache, factory, mockEvents);
    const file = path.join(tmpDir, 'lane-partial.jsonl');
    try {
      const k = 4;
      // Seed the lane from a file whose final line is complete JSON but unterminated: the parser's
      // unbounded bytesRead can land past EOF, so the seed must store no anchors and reseed.
      await fsp.writeFile(file, LINES.slice(0, k + 1).join('\n'), 'utf8');
      await watcher.startWatching('lane', file, 'claude');
      await flush();
      await fsp.writeFile(file, LINES.slice(0, k + 2).join('\n') + '\n', 'utf8'); // complete + one more
      await advancePollCycle();

      const laneMetrics = watcher.getLastKnownSummaryMetrics('lane');
      if (!laneMetrics) throw new Error('lane produced no summary metrics');

      const bodyCache = newCache();
      try {
        const body = await bodyCache.getOrParseWithMeta(
          'body',
          file,
          new ClaudeSessionReaderAdapter(mockPricing),
        );
        expect(laneMetrics.messageCount).toBe(body.session.metrics.messageCount);
      } finally {
        bodyCache.onModuleDestroy();
      }
      expect(cache.size).toBe(0); // the lane never populated the parsed cache
    } finally {
      watcher.onModuleDestroy();
      cache.onModuleDestroy();
    }
  });
});
