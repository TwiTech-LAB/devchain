'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  METRICS_SNAPSHOT_TTL_MS,
  READER_CACHE_BUDGET_BYTES,
  buildReaderCorrectness,
  buildTranscriptGeneration,
  generationMarker,
  markersFromChunks,
  readerProfile,
  seededUuid,
} = require('./lib/reader-fixture');
const { EXECUTION_RUNNERS } = require('./lib/runner');
const { getScenario } = require('./lib/scenarios');

function cacheStats(overrides = {}) {
  return {
    entries: 1,
    bytesEstimated: 128 * 1024,
    hits: 4,
    misses: 6,
    hitRate: 0.4,
    ...overrides,
  };
}

function readerEvidence() {
  const initialAggregate = cacheStats({
    entries: 0,
    bytesEstimated: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
    providersFailed: 0,
    budgetUsedBytes: 0,
    budgetBytes: READER_CACHE_BUDGET_BYTES,
    evictions: 0,
  });
  const finalAggregate = cacheStats({
    entries: 2,
    bytesEstimated: 420 * 1024,
    providersFailed: 0,
    budgetUsedBytes: 560 * 1024,
    budgetBytes: READER_CACHE_BUDGET_BYTES,
    evictions: 8,
  });
  return {
    cacheBudgetBytes: READER_CACHE_BUDGET_BYTES,
    metricsSnapshotTtlMs: METRICS_SNAPSHOT_TTL_MS,
    sampleWindowMs: METRICS_SNAPSHOT_TTL_MS + 1,
    transcripts: [178_000, 183_000, 189_000].map((sizeBytes, sessionIndex) => ({
      sessionIndex,
      sizeBytes,
    })),
    rounds: [{ roundIndex: 0, consistent: true }],
    cacheSnapshots: {
      initial: {
        parsed: cacheStats({ entries: 0, hits: 0, misses: 0 }),
        chunks: cacheStats({ entries: 0, hits: 0, misses: 0 }),
        aggregate: initialAggregate,
      },
      final: {
        parsed: cacheStats(),
        chunks: cacheStats(),
        aggregate: finalAggregate,
      },
    },
  };
}

test('reader fixture catalog entry is active and dispatchable', () => {
  const scenario = getScenario('eviction-concurrent-transcript-reads');
  assert.equal(scenario.state, 'active');
  assert.equal(scenario.execution, 'reader-fixture');
  assert.equal(typeof EXECUTION_RUNNERS['reader-fixture'], 'function');
});

test('reader profiles always cross the metrics snapshot TTL', () => {
  for (const profileName of ['smoke', 'baseline', 'soak']) {
    const profile = readerProfile(profileName);
    assert.ok(profile.samplesPerCycle * 2 * profile.intervalMs > METRICS_SNAPSHOT_TTL_MS);
  }
});

test('seeded transcript generations are stable, distinct, and fully marked', () => {
  const input = { seed: 7331, sessionIndex: 2, generation: 4 };
  const first = buildTranscriptGeneration(input);
  const second = buildTranscriptGeneration(input);
  const next = buildTranscriptGeneration({ ...input, generation: 5 });

  assert.deepEqual(first, second);
  assert.notEqual(first.content, next.content);
  assert.equal(first.marker, generationMarker(7331, 2, 4));
  assert.ok(Buffer.byteLength(first.content, 'utf8') > 150 * 1024);
  assert.equal((first.content.match(/GEN:7331:2:4/g) || []).length, first.messageCount);
  assert.match(
    seededUuid(7331, 2),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(markersFromChunks([{ messages: [{ content: first.marker }] }]), [first.marker]);
});

test('reader correctness accepts generation parity, bounded retention, and live counters', () => {
  const result = buildReaderCorrectness(readerEvidence());
  assert.equal(result.pass, true);
  assert.equal(result.checks.length, 5);
});

test('reader correctness rejects a mixed generation', () => {
  const evidence = readerEvidence();
  evidence.rounds.push({ roundIndex: 1, consistent: false });
  const result = buildReaderCorrectness(evidence);
  assert.equal(result.pass, false);
  assert.equal(
    result.checks.find((check) => check.id === 'reader-no-mixed-generations').pass,
    false,
  );
});

test('reader correctness rejects retained bytes or budget usage above the configured cap', () => {
  for (const field of ['bytesEstimated', 'budgetUsedBytes']) {
    const evidence = readerEvidence();
    evidence.cacheSnapshots.final.aggregate[field] = READER_CACHE_BUDGET_BYTES + 1;
    const result = buildReaderCorrectness(evidence);
    assert.equal(result.pass, false, field);
    assert.equal(
      result.checks.find((check) => check.id === 'reader-composite-retention-bounded').pass,
      false,
    );
  }
});

test('reader correctness rejects zero counters and a sub-TTL sample window', () => {
  const counters = readerEvidence();
  counters.cacheSnapshots.final.parsed.hits = 0;
  counters.cacheSnapshots.final.aggregate.evictions = 0;
  let result = buildReaderCorrectness(counters);
  assert.equal(result.pass, false);
  assert.equal(
    result.checks.find((check) => check.id === 'reader-cache-counters-observed').pass,
    false,
  );

  const window = readerEvidence();
  window.sampleWindowMs = METRICS_SNAPSHOT_TTL_MS;
  result = buildReaderCorrectness(window);
  assert.equal(result.pass, false);
  assert.equal(
    result.checks.find((check) => check.id === 'reader-metrics-snapshot-window-exercised').pass,
    false,
  );
});
