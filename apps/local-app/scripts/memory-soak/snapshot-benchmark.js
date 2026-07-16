'use strict';

/**
 * Full-snapshot benchmark: exercises the real MetricsService.getMetrics() path
 * with ALL providers registered (parsed/chunks/DTO with retainedRoots + frame buffers).
 *
 * Fixture generation is deterministic (fixed message count, content size, chunk count).
 * The DTO result objects share references with parsed sessions (matching the real
 * serializer's spread semantics) so the aggregate shared-WeakSet walk is exercised
 * correctly — cross-cache shared objects are counted once.
 *
 * Cold snapshots model the 60-second periodic cadence by advancing a controlled
 * clock past the 10-second cache TTL before every measured call. Warm snapshots
 * reuse one precomputed provider snapshot within the TTL. Only cold p99 is judged
 * against the 25ms decision threshold.
 */

const assert = require('node:assert/strict');
const { monitorEventLoopDelay } = require('node:perf_hooks');

// Use compiled output from dist/
const { MetricsService } = require('../../dist/modules/metrics/services/metrics.service');
const {
  estimateObjectBytes,
} = require('../../dist/modules/metrics/helpers/byte-accounting.helper');

const SNAPSHOTS = 100;
const PERIODIC_CADENCE_MS = 60_000;
const COLD_P99_THRESHOLD_MS = 25;

// Deterministic fixture constants
const CACHE_ENTRIES = 20;
const MSGS_REALISTIC = 100;
const MSGS_WORST = 200;
const CONTENT_CHARS = 500;
const CONTENT_CHARS_WORST = 2000;
const CHUNKS_PER_SESSION = 12;
const DTO_ENTRIES = 20;
const FRAME_SESSIONS = 3;
const FRAMES_PER_SESSION = 100;

function makeMessage(id, role, contentChars) {
  return {
    id,
    parentId: null,
    role,
    timestamp: new Date('2026-07-11T10:00:00Z'),
    content: [{ type: 'text', text: `${role} ${id}: ${'x'.repeat(contentChars)}` }],
    toolCalls:
      role === 'assistant' && id.endsWith('-0')
        ? [
            {
              id: `call-${id}`,
              type: 'tool_use',
              name: 'Read',
              input: { file_path: `/f/${id}.ts` },
            },
          ]
        : [],
    toolResults:
      role === 'user' && id.endsWith('-1')
        ? [
            {
              toolCallId: `call-${id}`,
              content: [{ type: 'tool_result', content: 'y'.repeat(contentChars * 2) }],
              isError: false,
            },
          ]
        : [],
    stopReason: role === 'assistant' ? 'end_turn' : null,
    isSidechain: false,
    isCompactSummary: false,
  };
}

function makeSession(index, msgCount, contentChars) {
  const messages = [];
  for (let i = 0; i < msgCount; i++) {
    messages.push(makeMessage(`s${index}-m${i}`, i % 2 === 0 ? 'user' : 'assistant', contentChars));
  }
  const metrics = {
    inputTokens: 50000 + index * 1000,
    outputTokens: 25000,
    cacheReadTokens: 100000,
    cacheCreationTokens: 50000,
    totalTokens: 225000,
    costUsd: 0.45,
    primaryModel: 'claude-sonnet-4-20250514',
    isOngoing: index < 5,
    visibleContextTokens: 80000,
    totalContextTokens: 200000,
    contextWindowTokens: 200000,
    messageCount: msgCount,
    durationMs: 60000,
  };
  return {
    id: `session-${index}`,
    providerName: 'claude',
    filePath: `/home/user/.claude/sessions/session-${index}.jsonl`,
    messages,
    metrics,
    isOngoing: index < 5,
  };
}

function makeChunks(session) {
  const chunkSize = Math.max(1, Math.floor(session.messages.length / CHUNKS_PER_SESSION));
  const chunks = [];
  for (let i = 0; i < CHUNKS_PER_SESSION; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, session.messages.length);
    if (start >= session.messages.length) break;
    const msgs = session.messages.slice(start, end);
    const isAI = msgs.some((m) => m.role === 'assistant');
    chunks.push({
      id: `chunk-${i}`,
      type: isAI ? 'ai' : 'user',
      startTime: new Date('2026-07-11T10:00:00Z'),
      endTime: new Date('2026-07-11T10:00:05Z'),
      messages: msgs,
      metrics: {
        inputTokens: 5000,
        outputTokens: 2500,
        totalTokens: 7500,
        messageCount: msgs.length,
        durationMs: 5000,
        costUsd: 0.05,
      },
      ...(isAI
        ? {
            semanticSteps: msgs.map((m) => ({
              id: `step-${m.id}`,
              type: 'output',
              content: { outputText: m.content[0]?.text?.slice(0, 200) || '' },
            })),
          }
        : {}),
    });
  }
  return chunks;
}

/** DTO result shaped like serializeTranscript: spread session, mapped messages, shared metrics */
function makeDtoResult(session) {
  return {
    ...session,
    messages: session.messages.map((m) => ({ ...m, content: m.content.map((c) => ({ ...c })) })),
    chunks: undefined,
    metrics: session.metrics, // shared reference — matches real serializer
  };
}

function makeFrames() {
  const buffers = [];
  for (let s = 0; s < FRAME_SESSIONS; s++) {
    const frames = [];
    for (let f = 0; f < FRAMES_PER_SESSION; f++) {
      frames.push({
        topic: `terminal/session-${s}`,
        type: 'data',
        payload: { data: `\x1b[32m${'x'.repeat(1024)}\x1b[0m`, sequence: f },
        ts: '2026-07-11T10:00:00.000Z',
      });
    }
    buffers.push({ frames, maxSize: 100 });
  }
  return buffers;
}

function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function formatMs(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function buildProviders(sessions, chunksArrays, dtoEntries, frameBuffers) {
  let parsedHits = 80,
    parsedMisses = 20;
  let chunksHits = 60,
    chunksMisses = 15;
  let dtoHits = 40,
    dtoMisses = 10;

  return {
    parsed: {
      stats: () => ({
        entries: sessions.length,
        bytesEstimated: 0,
        hits: parsedHits,
        misses: parsedMisses,
        hitRate: parsedHits / (parsedHits + parsedMisses),
        bytesMethod: 'deferred-to-aggregate',
      }),
      retainedRoots: () => sessions.map((s) => s),
    },
    chunks: {
      stats: () => ({
        entries: chunksArrays.length,
        bytesEstimated: 0,
        hits: chunksHits,
        misses: chunksMisses,
        hitRate: chunksHits / (chunksHits + chunksMisses),
        bytesMethod: 'deferred-to-aggregate',
      }),
      retainedRoots: () => chunksArrays,
    },
    dto: {
      stats: () => {
        let bytes = 0;
        for (const entry of dtoEntries) bytes += entry.responseBytes;
        return {
          entries: dtoEntries.length,
          bytesEstimated: bytes,
          hits: dtoHits,
          misses: dtoMisses,
          hitRate: dtoHits / (dtoHits + dtoMisses),
          bytesMethod: 'json-stringify-length',
        };
      },
      retainedRoots: () => dtoEntries.map((entry) => entry.result),
    },
    frameBuffers: () => {
      let totalFrames = 0;
      let bytes = 0;
      for (const buf of frameBuffers) {
        totalFrames += buf.frames.length;
        bytes += estimateObjectBytes(buf.frames);
      }
      return {
        sessions: frameBuffers.length,
        totalFrames,
        bytesEstimated: bytes,
        maxBufferCapacity: 100,
      };
    },
  };
}

function assertProductionProviderMethods(providers) {
  assert.equal(providers.parsed.stats().bytesMethod, 'deferred-to-aggregate');
  assert.equal(providers.parsed.stats().bytesEstimated, 0);
  assert.equal(providers.chunks.stats().bytesMethod, 'deferred-to-aggregate');
  assert.equal(providers.chunks.stats().bytesEstimated, 0);
  assert.equal(providers.dto.stats().bytesMethod, 'json-stringify-length');
  assert.ok(providers.dto.stats().bytesEstimated > 0);
  console.log(
    'Provider methods asserted: parsed/chunks=deferred-to-aggregate, dto=json-stringify-length',
  );
}

async function measureDistribution(label, service, beforeEach) {
  console.log(`\n${label}: ${SNAPSHOTS} getMetrics() iterations (yielding between each)...`);
  const durations = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const eld = monitorEventLoopDelay();
  eld.enable();

  for (let i = 0; i < SNAPSHOTS; i++) {
    beforeEach();
    const t0 = performance.now();
    service.getMetrics();
    const t1 = performance.now();
    durations.push(t1 - t0);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const heapAfter = process.memoryUsage().heapUsed;
  eld.disable();
  durations.sort((a, b) => a - b);
  const result = {
    min: durations[0],
    max: durations[durations.length - 1],
    mean: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    heapDelta: heapAfter - heapBefore,
    eldMean: Number.isFinite(eld.mean) ? eld.mean / 1e6 : null,
    eldP99: Number.isFinite(eld.percentile(99)) ? eld.percentile(99) / 1e6 : null,
  };

  console.log(`  min:    ${formatMs(result.min)}`);
  console.log(`  mean:   ${formatMs(result.mean)}`);
  console.log(`  p50:    ${formatMs(result.p50)}`);
  console.log(`  p95:    ${formatMs(result.p95)}`);
  console.log(`  p99:    ${formatMs(result.p99)}`);
  console.log(`  max:    ${formatMs(result.max)}`);
  console.log(
    `  heap:   ${(result.heapDelta / 1024).toFixed(0)}KB total, ${(result.heapDelta / SNAPSHOTS / 1024).toFixed(2)}KB/snapshot`,
  );
  console.log(
    `  event-loop delay: mean ${result.eldMean !== null ? result.eldMean.toFixed(2) + 'ms' : 'N/A'}, p99 ${result.eldP99 !== null ? result.eldP99.toFixed(2) + 'ms' : 'N/A'}`,
  );
  return result;
}

async function runScale(label, msgCount, contentChars) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(
    `Scale: ${label} — ${CACHE_ENTRIES} sessions × ${msgCount} msgs × ${contentChars} char content`,
  );
  console.log('='.repeat(60));

  // Build deterministic fixtures
  const sessions = [];
  const chunksArrays = [];
  const dtoEntries = [];
  for (let i = 0; i < CACHE_ENTRIES; i++) {
    const session = makeSession(i, msgCount, contentChars);
    sessions.push(session);
    chunksArrays.push(makeChunks(session));
  }
  for (let i = 0; i < DTO_ENTRIES; i++) {
    const result = makeDtoResult(sessions[i % CACHE_ENTRIES]);
    dtoEntries.push({
      result,
      responseBytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
    });
  }
  const frameBuffers = makeFrames();

  // Verify fixture sizes
  const sessionBytes = sessions.reduce((s, ses) => s + estimateObjectBytes(ses), 0);
  const chunksBytes = chunksArrays.reduce((s, c) => s + estimateObjectBytes(c), 0);
  const dtoBytes = dtoEntries.reduce((sum, entry) => sum + entry.responseBytes, 0);
  console.log(
    `Fixture sizes: sessions ${(sessionBytes / 1024 / 1024).toFixed(1)}MB, chunks ${(chunksBytes / 1024 / 1024).toFixed(1)}MB, dto ${(dtoBytes / 1024 / 1024).toFixed(1)}MB`,
  );

  // Instantiate MetricsService and register all providers
  const service = new MetricsService();
  const providers = buildProviders(sessions, chunksArrays, dtoEntries, frameBuffers);
  assertProductionProviderMethods(providers);
  service.registerCacheStatsProvider(
    'parsed',
    providers.parsed.stats,
    providers.parsed.retainedRoots,
  );
  service.registerCacheStatsProvider(
    'chunks',
    providers.chunks.stats,
    providers.chunks.retainedRoots,
  );
  service.registerCacheStatsProvider('dto', providers.dto.stats, providers.dto.retainedRoots);
  service.registerStatsProvider('frameBuffers', providers.frameBuffers);

  const originalDateNow = Date.now;
  let benchmarkNow = originalDateNow();
  Date.now = () => benchmarkNow;
  try {
    const verifySnapshot = service.getMetrics();
    assert.equal(verifySnapshot.caches.aggregate.entries, CACHE_ENTRIES * 2 + DTO_ENTRIES);
    assert.equal(verifySnapshot.caches.aggregate.providersFailed, 0);
    assert.equal(verifySnapshot.caches.parsed.bytesMethod, 'object-graph-walk');
    assert.equal(verifySnapshot.caches.chunks.bytesMethod, 'object-graph-walk');
    assert.equal(verifySnapshot.caches.dto.bytesMethod, 'json-stringify-length');
    assert.equal(verifySnapshot.frameBuffers.sessions, FRAME_SESSIONS);
    assert.equal(verifySnapshot.frameBuffers.totalFrames, FRAME_SESSIONS * FRAMES_PER_SESSION);
    console.log(
      `Verification: aggregate.bytesEstimated=${(verifySnapshot.caches.aggregate.bytesEstimated / 1024 / 1024).toFixed(1)}MB, providersFailed=${verifySnapshot.caches.aggregate.providersFailed}, frames=${verifySnapshot.frameBuffers.totalFrames}`,
    );

    const cold = await measureDistribution(
      'COLD / expired periodic path (clock advances 60s before every call)',
      service,
      () => {
        benchmarkNow += PERIODIC_CADENCE_MS;
      },
    );

    benchmarkNow += PERIODIC_CADENCE_MS;
    service.getMetrics();
    const warm = await measureDistribution(
      'WARM / within-TTL endpoint path (one untimed prewarm, fixed clock)',
      service,
      () => {},
    );

    const verdict = cold.p99 <= COLD_P99_THRESHOLD_MS ? 'NEGLIGIBLE' : 'EXCEEDS THRESHOLD';
    console.log(
      `\nCOLD verdict (p99 threshold ${COLD_P99_THRESHOLD_MS}ms): ${formatMs(cold.p99)} ${cold.p99 <= COLD_P99_THRESHOLD_MS ? '≤' : '>'} ${COLD_P99_THRESHOLD_MS}ms → ${verdict}`,
    );
    console.log(`WARM observation (reported separately; no threshold): p99 ${formatMs(warm.p99)}`);
    return { cold, warm, verdict };
  } finally {
    Date.now = originalDateNow;
    service.onModuleDestroy();
  }
}

async function main() {
  console.log('=== FULL-SNAPSHOT BENCHMARK: COLD periodic vs WARM endpoint paths ===\n');

  const realistic = await runScale('Realistic', MSGS_REALISTIC, CONTENT_CHARS);
  const worstCase = await runScale('Worst-case', MSGS_WORST, CONTENT_CHARS_WORST);

  console.log('\n=== SUMMARY ===');
  console.log(`Realistic COLD p99:  ${formatMs(realistic.cold.p99)} → ${realistic.verdict}`);
  console.log(`Realistic WARM p99:  ${formatMs(realistic.warm.p99)} (reported only)`);
  console.log(`Worst-case COLD p99: ${formatMs(worstCase.cold.p99)} → ${worstCase.verdict}`);
  console.log(`Worst-case WARM p99: ${formatMs(worstCase.warm.p99)} (reported only)`);
  const overallVerdict =
    realistic.verdict === 'NEGLIGIBLE' && worstCase.verdict === 'NEGLIGIBLE'
      ? 'NEGLIGIBLE'
      : 'EXCEEDS THRESHOLD';
  console.log(`Overall COLD-path verdict: ${overallVerdict}`);
}

main();
