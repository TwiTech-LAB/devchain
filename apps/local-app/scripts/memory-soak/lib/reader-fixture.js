'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const METRICS_SNAPSHOT_TTL_MS = 10_000;
const READER_CACHE_BUDGET_BYTES = 768 * 1024;
const TRANSCRIPT_SESSION_COUNT = 3;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readerProfile(profile) {
  if (profile === 'soak') return { samplesPerCycle: 30, intervalMs: 1_000 };
  if (profile === 'baseline') return { samplesPerCycle: 5, intervalMs: 1_200 };
  return { samplesPerCycle: 3, intervalMs: 1_800 };
}

function seededUuid(seed, index) {
  const bytes = crypto
    .createHash('sha256')
    .update(`memory-soak-reader:${seed}:${index}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generationMarker(seed, sessionIndex, generation) {
  return `GEN:${seed}:${sessionIndex}:${generation}`;
}

function buildTranscriptGeneration({ seed, sessionIndex, generation }) {
  const marker = generationMarker(seed, sessionIndex, generation);
  const pairCount = 34 + (generation % 5);
  const filler = `${String(seed + sessionIndex).padStart(8, '0')}-`.repeat(520);
  const lines = [];
  let parentUuid = null;

  for (let pair = 0; pair < pairCount; pair += 1) {
    const userUuid = `user-${sessionIndex}-${generation}-${pair}`;
    const assistantUuid = `assistant-${sessionIndex}-${generation}-${pair}`;
    const timestamp = new Date(
      Date.UTC(2026, 0, 1, 0, sessionIndex, generation * 2 + pair),
    ).toISOString();
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: userUuid,
        parentUuid,
        isSidechain: false,
        timestamp,
        message: { role: 'user', content: `${marker} user=${pair}` },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: false,
        timestamp: new Date(Date.parse(timestamp) + 500).toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: `${marker} assistant=${pair} ${filler}` }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100 + pair,
            output_tokens: 40,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      }),
    );
    parentUuid = assistantUuid;
  }

  return {
    content: `${lines.join('\n')}\n`,
    marker,
    messageCount: pairCount * 2,
    chunkCount: pairCount * 2,
  };
}

function writeTranscriptGeneration(transcript, generation) {
  const built = buildTranscriptGeneration({
    seed: transcript.seed,
    sessionIndex: transcript.sessionIndex,
    generation,
  });
  const temporaryPath = `${transcript.filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, built.content, 'utf8');
  fs.renameSync(temporaryPath, transcript.filePath);
  transcript.generation = generation;
  transcript.marker = built.marker;
  transcript.messageCount = built.messageCount;
  transcript.chunkCount = built.chunkCount;
  transcript.sizeBytes = Buffer.byteLength(built.content, 'utf8');
  return transcript;
}

function createTranscriptSessions(fixture, seed, sessionCount = TRANSCRIPT_SESSION_COUNT) {
  if (!fixture.agentId) throw new Error('Reader fixture requires a UUID-backed scratch agent');
  const transcriptRoot = path.join(fixture.homeDir, '.claude', 'projects', 'memory-soak');
  fs.mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
  const transcripts = Array.from({ length: sessionCount }, (_, sessionIndex) => {
    const sessionId = seededUuid(seed, sessionIndex);
    const transcript = {
      seed,
      sessionIndex,
      sessionId,
      filePath: path.join(transcriptRoot, `${sessionId}.jsonl`),
    };
    return writeTranscriptGeneration(transcript, 0);
  });

  const database = new Database(path.join(fixture.storageDir, 'devchain.db'));
  try {
    database.pragma('busy_timeout = 5000');
    const insert = database.prepare(
      `INSERT INTO sessions
         (id, agent_id, status, started_at, ended_at, transcript_path,
          provider_session_id, provider_name_at_launch, created_at, updated_at)
       VALUES (?, ?, 'stopped', ?, ?, ?, ?, 'claude', ?, ?)`,
    );
    const insertAll = database.transaction(() => {
      for (const transcript of transcripts) {
        const now = new Date().toISOString();
        insert.run(
          transcript.sessionId,
          fixture.agentId,
          now,
          now,
          transcript.filePath,
          transcript.sessionId,
          now,
          now,
        );
      }
    });
    insertAll();
  } finally {
    database.close();
  }

  return transcripts;
}

async function requestJson(fixture, route) {
  const response = await fetch(`http://127.0.0.1:${fixture.port}${route}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Reader fixture request ${route} failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return response.json();
}

function markersFromChunks(chunks) {
  const matches = JSON.stringify(chunks).match(/GEN:\d+:\d+:\d+/g) || [];
  return [...new Set(matches)];
}

async function readTranscriptRound(fixture, transcripts, roundIndex) {
  const hotIndex = roundIndex % transcripts.length;
  const hot = writeTranscriptGeneration(transcripts[hotIndex], roundIndex + 1);
  const evictors = [1, 2].map((offset) => transcripts[(hotIndex + offset) % transcripts.length]);
  const baseRoute = `/api/sessions/${hot.sessionId}/transcript`;

  await requestJson(fixture, `${baseRoute}/index`);
  await requestJson(fixture, `${baseRoute}/chunks?limit=100`);

  const [summary, index, chunks] = await Promise.all([
    requestJson(fixture, `${baseRoute}/summary`),
    requestJson(fixture, `${baseRoute}/index`),
    requestJson(fixture, `${baseRoute}/chunks?limit=100`),
    ...evictors.flatMap((transcript) => {
      const route = `/api/sessions/${transcript.sessionId}/transcript`;
      return [
        requestJson(fixture, `${route}/index`),
        requestJson(fixture, `${route}/chunks?limit=100`),
      ];
    }),
  ]);

  const observedMarkers = markersFromChunks(chunks.chunks);
  const latestPreviewMarker = index.latestOutputPreview?.match(/GEN:\d+:\d+:\d+/)?.[0] ?? null;
  const consistent =
    summary.sessionId === hot.sessionId &&
    summary.providerName === 'claude' &&
    summary.messageCount === hot.messageCount &&
    summary.metrics?.messageCount === hot.messageCount &&
    index.providerName === 'claude' &&
    index.totals?.messageCount === hot.messageCount &&
    index.totals?.chunkCount === hot.chunkCount &&
    index.chunkIds?.length === hot.chunkCount &&
    chunks.totalCount === hot.chunkCount &&
    chunks.chunks?.length === hot.chunkCount &&
    chunks.chunks.every((chunk, chunkIndex) => chunk.id === index.chunkIds[chunkIndex]) &&
    observedMarkers.length === 1 &&
    observedMarkers[0] === hot.marker &&
    latestPreviewMarker === hot.marker;

  return {
    roundIndex,
    hotSessionIndex: hotIndex,
    generation: hot.generation,
    expectedMarker: hot.marker,
    expectedMessageCount: hot.messageCount,
    expectedChunkCount: hot.chunkCount,
    sourceSizeBytes: hot.sizeBytes,
    evictorSessionIndexes: evictors.map((transcript) => transcript.sessionIndex),
    summaryMessageCount: summary.messageCount,
    summaryMetricsMessageCount: summary.metrics?.messageCount ?? null,
    indexMessageCount: index.totals?.messageCount ?? null,
    indexChunkCount: index.totals?.chunkCount ?? null,
    responseChunkCount: chunks.totalCount,
    returnedChunkCount: chunks.chunks?.length ?? 0,
    observedMarkers,
    latestPreviewMarker,
    consistent,
  };
}

async function runReaderWorkload(fixture, transcripts, profile) {
  const { samplesPerCycle, intervalMs } = readerProfile(profile);
  const rounds = [];
  const startedAtMs = Date.now();
  for (const phase of ['cache-churn-1', 'cache-churn-2']) {
    for (let index = 0; index < samplesPerCycle; index += 1) {
      const round = await readTranscriptRound(fixture, transcripts, rounds.length);
      round.phase = phase;
      rounds.push(round);
      const sample = fixture.sample(phase);
      sample.reader = {
        roundIndex: round.roundIndex,
        hotSessionIndex: round.hotSessionIndex,
        generation: round.generation,
        consistent: round.consistent,
      };
      await sleep(intervalMs);
    }
  }
  return {
    rounds,
    sampleWindowMs: Date.now() - startedAtMs,
    samplesPerCycle,
    intervalMs,
  };
}

function cacheSnapshot(metrics) {
  const select = (name) => {
    const cache = metrics.caches?.[name] || {};
    return {
      entries: cache.entries ?? 0,
      bytesEstimated: cache.bytesEstimated ?? 0,
      hits: cache.hits ?? 0,
      misses: cache.misses ?? 0,
      hitRate: cache.hitRate ?? 0,
      ...(cache.providersFailed !== undefined ? { providersFailed: cache.providersFailed } : {}),
      ...(cache.budgetUsedBytes !== undefined ? { budgetUsedBytes: cache.budgetUsedBytes } : {}),
      ...(cache.budgetBytes !== undefined ? { budgetBytes: cache.budgetBytes } : {}),
      ...(cache.evictions !== undefined ? { evictions: cache.evictions } : {}),
    };
  };
  return {
    capturedAt: metrics.timestamp,
    parsed: select('parsed'),
    chunks: select('chunks'),
    dto: select('dto'),
    aggregate: select('aggregate'),
  };
}

function buildReaderCorrectness(reader) {
  const final = reader.cacheSnapshots.final;
  const sourceSizes = reader.transcripts.map((transcript) => transcript.sizeBytes);
  const minimumEntryWeightBytes = Math.min(...sourceSizes) * 3;
  const maximumEntryWeightBytes = Math.max(...sourceSizes) * 3;
  const minimumTwoEntryWeightBytes = Math.min(...sourceSizes) * 6;
  const pressure = {
    cacheBudgetBytes: reader.cacheBudgetBytes,
    minimumEntryWeightBytes,
    maximumEntryWeightBytes,
    minimumTwoEntryWeightBytes,
    eachEntryFits: maximumEntryWeightBytes <= reader.cacheBudgetBytes,
    twoEntriesExceedBudget: minimumTwoEntryWeightBytes > reader.cacheBudgetBytes,
  };
  const checks = [
    {
      id: 'reader-seed-controlled-eviction-pressure',
      actual: pressure,
      expected: { eachEntryFits: true, twoEntriesExceedBudget: true },
      pass: pressure.eachEntryFits && pressure.twoEntriesExceedBudget,
    },
    {
      id: 'reader-no-mixed-generations',
      actual: {
        rounds: reader.rounds.length,
        inconsistentRounds: reader.rounds
          .filter((round) => !round.consistent)
          .map((round) => round.roundIndex),
      },
      expected: { rounds: '> 0', inconsistentRounds: [] },
      pass: reader.rounds.length > 0 && reader.rounds.every((round) => round.consistent),
    },
    {
      id: 'reader-composite-retention-bounded',
      actual: final.aggregate,
      expected: {
        providersFailed: 0,
        entries: '> 0',
        budgetUsedBytes: `<= ${reader.cacheBudgetBytes}`,
        bytesEstimated: `<= ${reader.cacheBudgetBytes}`,
      },
      pass:
        final.aggregate.providersFailed === 0 &&
        final.aggregate.entries > 0 &&
        final.aggregate.budgetBytes === reader.cacheBudgetBytes &&
        final.aggregate.budgetUsedBytes > 0 &&
        final.aggregate.budgetUsedBytes <= reader.cacheBudgetBytes &&
        final.aggregate.bytesEstimated > 0 &&
        final.aggregate.bytesEstimated <= reader.cacheBudgetBytes,
    },
    {
      id: 'reader-cache-counters-observed',
      actual: {
        parsed: final.parsed,
        chunks: final.chunks,
        aggregate: final.aggregate,
      },
      expected: { parsedHitsAndMisses: '> 0', chunkHitsAndMisses: '> 0', evictions: '> 0' },
      pass:
        final.parsed.hits > 0 &&
        final.parsed.misses > 0 &&
        final.chunks.hits > 0 &&
        final.chunks.misses > 0 &&
        final.aggregate.hits > 0 &&
        final.aggregate.misses > 0 &&
        final.aggregate.evictions > 0,
    },
    {
      id: 'reader-metrics-snapshot-window-exercised',
      actual: {
        sampleWindowMs: reader.sampleWindowMs,
        metricsSnapshotTtlMs: reader.metricsSnapshotTtlMs,
        initialAggregate: reader.cacheSnapshots.initial.aggregate,
        finalAggregate: final.aggregate,
      },
      expected: { sampleWindowMs: `> ${reader.metricsSnapshotTtlMs}`, countersAdvanced: true },
      pass:
        reader.sampleWindowMs > reader.metricsSnapshotTtlMs &&
        final.aggregate.misses > reader.cacheSnapshots.initial.aggregate.misses &&
        final.aggregate.evictions > reader.cacheSnapshots.initial.aggregate.evictions,
    },
  ];
  return { pass: checks.every((check) => check.pass), checks };
}

module.exports = {
  METRICS_SNAPSHOT_TTL_MS,
  READER_CACHE_BUDGET_BYTES,
  TRANSCRIPT_SESSION_COUNT,
  buildReaderCorrectness,
  buildTranscriptGeneration,
  cacheSnapshot,
  createTranscriptSessions,
  generationMarker,
  markersFromChunks,
  readerProfile,
  runReaderWorkload,
  seededUuid,
  writeTranscriptGeneration,
};
