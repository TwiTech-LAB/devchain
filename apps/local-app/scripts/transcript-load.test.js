'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, validateCanonical, summarize, evaluate } = require('./transcript-load');

// Pure contracts are the cheapest layer for rejecting misleading benchmark evidence.
function validReport() {
  return {
    config: { sessions: 1, fileMiB: 65, drainMs: 5000, acceptanceProfile: true },
    fixtures: [{ id: 'one', appends: 199, expectedFinalMessages: 8000 }],
    lastSummaryCounts: { one: 8000 },
    lastCanonicalCount: 8000,
    safetyAbort: null,
    exit: { code: 0 },
    drainMs: 100,
    pendingRequestsAtExit: 0,
    fixturesRemoved: true,
    sourceUnchanged: true,
    requests: [{ kind: 'canonical' }],
    final: {
      counters: {
        one: {
          peakParses: 1,
          peakHandlers: 1,
          updates: 10,
          completedHandlers: 10,
          activeParses: 0,
          activeHandlers: 0,
        },
      },
      lastWatcherCounts: { one: 8000 },
      errors: [],
      accountingFailures: [],
      cache: { budgetUsedBytes: 0 },
      transcriptReaders: 0,
      watchers: 0,
      queuedRefreshes: 0,
      httpActive: 0,
      cacheFlights: 0,
      readerFlights: 0,
    },
    summary: {
      append: { cpuMean: 30 },
      baselineTail: { samples: 20 },
      recoveryTail: { samples: 20 },
      recoveryCpuDelta: 2,
      canonicalCommitsDuringAppends: 10,
      requests: { canonical: { errors: 0 } },
    },
  };
}

test('acceptance evaluation rejects noncompletion, missing evidence, and changed thresholds', () => {
  assert(Object.values(evaluate(validReport())).every((value) => value === true));
  for (const [change, failedGate] of [
    [
      (r) => {
        r.final = undefined;
      },
      'completed',
    ],
    [
      (r) => {
        r.lastSummaryCounts.one = 7998;
      },
      'exactMessages',
    ],
    [
      (r) => {
        r.lastCanonicalCount = 7998;
      },
      'exactMessages',
    ],
    [
      (r) => {
        r.final.counters.one.peakParses = 2;
      },
      'concurrency',
    ],
    [
      (r) => {
        r.final.queuedRefreshes = 1;
      },
      'teardown',
    ],
    [
      (r) => {
        r.final.transcriptReaders = 1;
      },
      'teardown',
    ],
    [
      (r) => {
        r.pendingRequestsAtExit = 1;
      },
      'teardown',
    ],
    [
      (r) => {
        r.final.accountingFailures.push({ retained: 2, reported: 0 });
      },
      'accounting',
    ],
    [
      (r) => {
        r.summary.append.cpuMean = 50;
      },
      'cpuTarget',
    ],
    [
      (r) => {
        r.summary.recoveryCpuDelta = 10.1;
      },
      'recoveryCpu',
    ],
    [
      (r) => {
        r.summary.recoveryCpuDelta = null;
      },
      'recoveryCpu',
    ],
    [
      (r) => {
        r.summary.canonicalCommitsDuringAppends = 0;
      },
      'coherentLiveClient',
    ],
  ]) {
    const report = validReport();
    change(report);
    assert.equal(evaluate(report)[failedGate], false, failedGate);
  }
});

test('recovery uses the same-poll baseline and final ten seconds, not recovery peaks', () => {
  const report = {
    config: { baselineSec: 15, recoverySec: 20 },
    recoveryStartedAtSec: 45,
    requests: [],
    samples: [
      {
        phase: 'baseline',
        atSec: 4,
        cpuSeconds: 1,
        elapsedSeconds: 1,
        rssMiB: 500,
        transcriptReaders: 1,
      },
      {
        phase: 'baseline',
        atSec: 10,
        cpuSeconds: 0.1,
        elapsedSeconds: 1,
        rssMiB: 200,
        transcriptReaders: 0,
      },
      {
        phase: 'append',
        atSec: 30,
        cpuSeconds: 0.4,
        elapsedSeconds: 1,
        rssMiB: 700,
        transcriptReaders: 1,
      },
      {
        phase: 'recovery',
        atSec: 46,
        cpuSeconds: 1.5,
        elapsedSeconds: 1,
        rssMiB: 600,
        transcriptReaders: 1,
      },
      {
        phase: 'recovery',
        atSec: 60,
        cpuSeconds: 0.12,
        elapsedSeconds: 1,
        rssMiB: 250,
        transcriptReaders: 0,
      },
    ],
  };
  const result = summarize(report);
  assert.equal(result.baselineTail.cpuMean, 10);
  assert.equal(result.recoveryTail.cpuMean, 12);
  assert.equal(result.recoveryCpuDelta, 2);
  assert.equal(result.rssReclaimedFromAppendPeakMiB, 450);
});

test('combined response validation rejects mixed page generations and uncovered retention', () => {
  const index = {
    chunkIds: ['chunk-0', 'chunk-1'],
    totals: { messageCount: 3, chunkCount: 2 },
    cursor: Buffer.from('123:3:2').toString('base64url'),
    pages: [
      {
        cursor: 'chunk-0',
        size: 2,
        response: {
          totalCount: 2,
          nextCursor: null,
          prevCursor: null,
          chunks: [{ id: 'chunk-0' }, { id: 'chunk-1' }],
        },
      },
    ],
  };
  assert.equal(validateCanonical(index).messageCount, 3);
  const mixed = structuredClone(index);
  mixed.pages[0].response.chunks[1].id = 'chunk-new';
  assert.throws(() => validateCanonical(mixed));
  assert.throws(() => validateCanonical({ ...index, pages: [] }));
  assert.throws(() =>
    validateCanonical({ ...index, cursor: Buffer.from('123:4:2').toString('base64url') }),
  );
});

test('limits and shortened smoke runs cannot masquerade as acceptance scenarios', () => {
  const single = parseArgs(['--file-mib', '200', '--report', '/tmp/single.json']);
  assert.equal(single.childHeapMiB, 768);
  assert.equal(single.acceptanceProfile, true);
  const multiple = parseArgs(['--sessions', '4', '--report', '/tmp/multi.json']);
  assert.equal(multiple.childHeapMiB, 1536);
  assert.equal(multiple.rssCutoffMiB, 2048);
  assert.equal(
    parseArgs(['--append-sec', '1', '--report', '/tmp/smoke.json']).acceptanceProfile,
    false,
  );
  assert.throws(() => parseArgs(['--sessions', '5', '--report', '/tmp/too-many.json']));
});
