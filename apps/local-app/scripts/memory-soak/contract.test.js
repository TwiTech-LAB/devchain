'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CURRENT_SCHEMA_VERSION,
  evaluateGeneratorLiveness,
  evaluateIsolation,
  evaluateMetricsFreshness,
  evaluatePlateau,
  evaluateReport,
  evaluateRun,
  median,
  validateReportSchema,
  validateSchemaVersion,
} = require('./lib/evaluate');
const { parseKeyValueBytes, parsePressure, summarizeProcessTree } = require('./lib/procfs');
const { scenarios, DEFAULT_THRESHOLDS } = require('./lib/scenarios');
const {
  buildLifecycleCorrectness,
  dispatchScenario,
  numericLeaves,
  parsePanePids,
  pausesOutputDuringSocketPlateau,
  phaseDuration,
  redactUrl,
  runFixtureProbeScenario,
  safeSignal,
  signalWorkloads,
  socketFixtureHistoryLimit,
  socketPlateauOutputMode,
} = require('./lib/runner');
const { parseArgs } = require('./index');
const { acknowledgeApplicationHeartbeat, DisposableAppFixture } = require('./lib/app-fixture');
const { HeadlessTerminalConsumer } = require('./lib/headless-terminal');
const {
  compareProviderMetrics,
  createProviderFixturePlan,
  loadProviderManifest,
} = require('./lib/provider-parity-fixture');
const { instrumentFactory } = require('./fixtures/provider-registry-capture');

const NOW_MS = new Date('2026-07-11T20:00:00.000Z').getTime();
const AUTHORITATIVE_PHASE1_BASELINE = 'phase1-instrumented-e31e970a0d41-fe11d4d4474c.json';
const HISTORICAL_PHASE1_BASELINES = ['phase1-instrumented-e31e970a0d41-01411f3b5635.json'];
const PHASE2_MEMORY_RELIEF_BASELINE = 'phase2-memory-relief-8b55bb10e650-a8fd4ec41689.json';
const PHASE6_FINAL_SOAK = 'phase6-final-206435f3ff2e-4ea5d7ff205d.json';
const PHASE6_SCENARIO_CATALOG = 'phase6-scenario-catalog-206435f3ff2e.json';
const PHASE6_XTERM_RETENTION = 'phase6-xterm-retention-5.5.0-vs-6.0.0.json';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function sample(phase, targetRss, workloadRss, overrides = {}) {
  return {
    index: overrides.index ?? 0,
    phase,
    system: {
      capturedAt: overrides.capturedAt || new Date(NOW_MS).toISOString(),
      target: {
        rootPid: 10,
        processCount: 1,
        rssBytes: targetRss,
        swapBytes: overrides.targetSwap || 0,
        processes: overrides.targetProcesses || [
          { pid: 10, ppid: 1, rssBytes: targetRss, swapBytes: overrides.targetSwap || 0 },
        ],
      },
      workload: {
        rootPid: 20,
        processCount: 1,
        rssBytes: workloadRss,
        swapBytes: 0,
        processes: overrides.workloadProcesses || [
          { pid: 20, ppid: 1, rssBytes: workloadRss, swapBytes: 0 },
        ],
      },
      cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
      host: { pressureAvailable: true, pressure: { full: { avg10: overrides.psi || 0 } } },
      sampler: { pid: 999, platform: 'linux' },
    },
    generators: overrides.generators || { expectedPids: [20], alivePids: [20] },
  };
}

test('pure unit: parses procfs memory and pressure counters into numeric units', () => {
  assert.deepEqual(parseKeyValueBytes('MemTotal:       1000 kB\nSwapFree: 12 kB\n'), {
    MemTotal: 1_024_000,
    SwapFree: 12_288,
  });
  assert.deepEqual(
    parsePressure('some avg10=0.10 avg60=0.20 avg300=0.30 total=42\nfull avg10=0.01 total=7\n'),
    {
      some: { avg10: 0.1, avg60: 0.2, avg300: 0.3, total: 42 },
      full: { avg10: 0.01, total: 7 },
    },
  );
});

test('pure unit: process-tree accounting includes descendants once', () => {
  const result = summarizeProcessTree(10, [
    { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 10 },
    { pid: 11, ppid: 10, rssBytes: 50, swapBytes: 5 },
    { pid: 12, ppid: 11, rssBytes: 25, swapBytes: 0 },
    { pid: 99, ppid: 1, rssBytes: 999, swapBytes: 999 },
  ]);
  assert.equal(result.processCount, 3);
  assert.equal(result.rssBytes, 175);
  assert.equal(result.swapBytes, 15);
});

test('pure unit: plateau uses cycle-tail medians and accepts either quantitative bound', () => {
  const samples = [
    sample('cache-churn-1', 100, 100),
    sample('cache-churn-1', 110, 100),
    sample('cache-churn-1', 120, 100),
    sample('cache-churn-2', 125, 100),
    sample('cache-churn-2', 130, 100),
    sample('cache-churn-2', 135, 100),
  ];
  const plateau = evaluatePlateau(samples, {
    maximumPlateauGrowthBytes: 25,
    maximumPlateauGrowthRatio: 0.05,
  });
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(plateau.firstCycleTailMedianBytes, 210);
  assert.equal(plateau.secondCycleTailMedianBytes, 230);
  assert.equal(plateau.growthBytes, 20);
  assert.equal(plateau.pass, true);
});

test('pure unit: evaluation fails specific observable limits', () => {
  const samples = [];
  for (let index = 0; index < 3; index += 1) samples.push(sample('cache-churn-1', 100, 100));
  for (let index = 0; index < 3; index += 1)
    samples.push(sample('cache-churn-2', 500, 500, { psi: 7 }));
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    minimumSamples: 1,
    minimumOutputBytesPerSession: 1,
    maximumTargetPeakRssBytes: 200,
    maximumWorkloadPeakRssBytes: 700,
    maximumMemoryPsiFullAvg10: 5,
    maximumPlateauGrowthBytes: 10,
    maximumPlateauGrowthRatio: 0.01,
  };
  const result = evaluateRun(
    samples,
    [
      {
        sessionName: 'soak-0',
        outputBytes: 10,
        forcedGcCount: 2,
        capturedAt: new Date(NOW_MS).toISOString(),
      },
    ],
    thresholds,
    {
      attempted: true,
      serverAliveAfterCleanup: false,
    },
  );
  assert.equal(result.pass, false);
  assert.equal(result.checks.find((check) => check.id === 'target-peak-rss').pass, false);
  assert.equal(result.checks.find((check) => check.id === 'memory-psi-full-avg10').pass, false);
  assert.equal(result.checks.find((check) => check.id === 'two-cycle-rss-plateau').pass, false);
});

test('pure unit: missing PSI is unavailable rather than a false zero-pressure pass', () => {
  const samples = [sample('cache-churn-1', 100, 100), sample('cache-churn-2', 100, 100)];
  for (const item of samples) {
    item.system.host = { pressureAvailable: false, pressure: null };
  }
  const result = evaluateRun(
    samples,
    [
      {
        sessionName: 'soak-0',
        outputBytes: 10,
        forcedGcCount: 2,
        capturedAt: new Date(NOW_MS).toISOString(),
      },
    ],
    { ...DEFAULT_THRESHOLDS, minimumSamples: 1, minimumOutputBytesPerSession: 1 },
    { attempted: true, serverAliveAfterCleanup: false },
  );
  const pressure = result.checks.find((check) => check.id === 'memory-psi-full-avg10');
  assert.equal(pressure.actual, null);
  assert.equal(pressure.pass, false);
});

test('pure unit: catalog covers every validated scenario with pending activation notes', () => {
  const expected = [
    'many-subscribers-one-session',
    'reconnect-replay-available',
    'reconnect-older-than-ring',
    'zero-web-mobile-activity',
    'stalled-and-current-socket',
    'oversized-unicode-ansi-chunking',
    'seed-during-burst',
    'lifecycle-cleanup-parity',
    'summary-full-provider-parity',
    'eviction-concurrent-transcript-reads',
    'engine-write-buffer-bounded',
  ];
  assert.deepEqual(
    scenarios
      .filter((scenario) => scenario.id !== 'host-burst-plateau')
      .map((scenario) => scenario.id),
    expected,
  );
  for (const scenario of scenarios.filter((item) => item.state === 'pending')) {
    assert.ok(scenario.activation.length > 20, `${scenario.id} needs an activation note`);
    assert.ok(scenario.expected.length > 0, `${scenario.id} needs expected outcomes`);
  }
  for (const id of [
    'many-subscribers-one-session',
    'reconnect-replay-available',
    'reconnect-older-than-ring',
    'stalled-and-current-socket',
    'engine-write-buffer-bounded',
  ]) {
    const scenario = scenarios.find((item) => item.id === id);
    assert.equal(scenario.state, 'active');
    assert.equal(scenario.execution, 'socket-fixture');
    assert.ok(scenario.expected.length >= 2);
  }
  for (const id of ['oversized-unicode-ansi-chunking', 'seed-during-burst']) {
    const scenario = scenarios.find((item) => item.id === id);
    assert.equal(scenario.state, 'active');
    assert.equal(scenario.execution, 'socket-xterm-fixture');
    assert.ok(scenario.expected.length >= 2);
  }
  const mobileScenario = scenarios.find((item) => item.id === 'zero-web-mobile-activity');
  assert.equal(mobileScenario.state, 'active');
  assert.equal(mobileScenario.execution, 'mobile-fixture');
  assert.deepEqual(mobileScenario.expected, [
    'viewport advances',
    'session activity advances',
    'no web socket required',
  ]);
  const lifecycleScenario = scenarios.find((item) => item.id === 'lifecycle-cleanup-parity');
  assert.equal(lifecycleScenario.state, 'active');
  assert.equal(lifecycleScenario.execution, 'lifecycle-fixture');
  assert.deepEqual(lifecycleScenario.expected, [
    'PTY cleanup parity',
    'listener cleanup parity',
    'frame-buffer cleanup parity',
  ]);
  const providerScenario = scenarios.find((item) => item.id === 'summary-full-provider-parity');
  assert.equal(providerScenario.state, 'active');
  assert.equal(providerScenario.execution, 'provider-fixture');
  assert.deepEqual(providerScenario.expected, [
    'summary metrics equal full metrics',
    'provider coverage matches adapter registry',
  ]);
});

test('pure unit: selected socket scenarios freeze output before retained-state plateau sampling', () => {
  for (const scenarioId of [
    'many-subscribers-one-session',
    'reconnect-replay-available',
    'stalled-and-current-socket',
    'engine-write-buffer-bounded',
    'oversized-unicode-ansi-chunking',
    'seed-during-burst',
  ]) {
    assert.equal(pausesOutputDuringSocketPlateau(scenarioId), true, scenarioId);
    assert.equal(socketPlateauOutputMode(scenarioId), 'paused-after-correctness', scenarioId);
  }
  assert.equal(socketFixtureHistoryLimit('many-subscribers-one-session'), 256);
  assert.equal(socketFixtureHistoryLimit('reconnect-replay-available'), 256);
  for (const scenarioId of ['reconnect-older-than-ring']) {
    assert.equal(pausesOutputDuringSocketPlateau(scenarioId), false, scenarioId);
    assert.equal(socketPlateauOutputMode(scenarioId), 'streaming', scenarioId);
    assert.equal(socketFixtureHistoryLimit(scenarioId), undefined, scenarioId);
  }
});

test('pure unit: lifecycle correctness requires identical zero-resource terminal states', () => {
  const released = (path) => ({
    path,
    post: {
      status: path === 'stopped' ? 'stopped' : 'failed',
      ptyFdCount: 0,
      registryEntry: false,
      frameListener: false,
      ptySession: false,
      frameBuffer: false,
      globalCounts: {
        registryEntries: 0,
        frameListeners: 0,
        ptySessions: 0,
        frameBuffers: 0,
      },
      metricCounts: {
        ptySessions: 0,
        frameBuffers: 0,
        frameBufferFrames: 0,
        frameBufferBytes: 0,
      },
    },
  });
  const passing = buildLifecycleCorrectness([
    released('stopped'),
    released('crashed'),
    released('dead'),
  ]);
  assert.equal(passing.pass, true);
  assert.ok(passing.checks.every((check) => check.pass));

  const leaked = released('crashed');
  leaked.post.frameListener = true;
  leaked.post.globalCounts.frameListeners = 1;
  const failing = buildLifecycleCorrectness([released('stopped'), leaked, released('dead')]);
  assert.equal(failing.pass, false);
  assert.equal(
    failing.checks.find((check) => check.id === 'lifecycle-crashed-resources-released').pass,
    false,
  );
});

test('pure unit: provider fixture planning is registry-driven and fails closed on new providers', () => {
  const manifest = loadProviderManifest();
  const knownProvider = Object.keys(manifest.fixtures)[0];
  const plan = createProviderFixturePlan([knownProvider, 'future-provider'], manifest);

  assert.deepEqual(plan.registryProviders, [knownProvider, 'future-provider']);
  assert.deepEqual(plan.loadedProviders, [knownProvider]);
  assert.deepEqual(plan.missingProviders, ['future-provider']);
  assert.equal(plan.coverageRatio, 0.5);
});

test('pure unit: provider parity compares exact fields and documents adapter tolerances', () => {
  const contract = {
    exactFields: ['inputTokens', 'messageCount'],
    approximateFields: ['visibleContextTokens'],
  };
  const tolerated = compareProviderMetrics(
    { inputTokens: 10, messageCount: 2, visibleContextTokens: 0 },
    { inputTokens: 10, messageCount: 2, visibleContextTokens: 7 },
    contract,
  );
  assert.equal(tolerated.metricsEqual, true);
  assert.deepEqual(tolerated.exactMismatches, []);
  assert.deepEqual(tolerated.toleratedDifferences, [
    {
      field: 'visibleContextTokens',
      summary: 0,
      full: 7,
      reason: 'adapter-declared approximate summary field',
    },
  ]);

  const mismatch = compareProviderMetrics(
    { inputTokens: 9, messageCount: 2, visibleContextTokens: 0 },
    { inputTokens: 10, messageCount: 2, visibleContextTokens: 7 },
    contract,
  );
  assert.equal(mismatch.metricsEqual, false);
  assert.deepEqual(
    mismatch.exactMismatches.map((entry) => entry.field),
    ['inputTokens'],
  );
});

test('contract unit: provider registry preload captures runtime membership and summary contracts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'provider-capture-'));
  const capturePath = path.join(tempRoot, 'registry.json');
  class FakeFactory {
    constructor() {
      this.adapters = new Map();
    }
    registerAdapter(adapter) {
      this.adapters.set(adapter.providerName, adapter);
    }
    getSupportedProviders() {
      return [...this.adapters.keys()];
    }
  }
  try {
    instrumentFactory(FakeFactory, capturePath);
    const factory = new FakeFactory();
    const adapter = {
      providerName: 'runtime-provider',
      async getSummary() {
        return {
          metrics: { inputTokens: 1 },
          exactFields: ['inputTokens'],
          approximateFields: ['messageCount'],
        };
      },
    };
    factory.registerAdapter(adapter);
    await adapter.getSummary({ filePath: '/fixture' });

    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.providers, ['runtime-provider']);
    assert.deepEqual(capture.summaryContracts['runtime-provider'], {
      available: true,
      exactFields: ['inputTokens'],
      approximateFields: ['messageCount'],
      warnings: [],
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('contract unit: headless terminal applies chunked seeds, live data, and recovery resets', async () => {
  const terminal = new HeadlessTerminalConsumer({ cols: 20, rows: 4 });
  try {
    const state = await terminal.replay([
      {
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 2, data: '\u001b[31mstale-' },
      },
      {
        type: 'seed_ansi',
        payload: { chunk: 1, totalChunks: 2, data: '界\u001b[0m' },
      },
      { type: 'data', payload: { data: '\r\nold-tail' } },
      {
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 1, data: '\u001b[32mfresh-界\u001b[0m' },
      },
      { type: 'data', payload: { data: '\r\n🧠' } },
    ]);

    assert.equal(state.seedResets, 2);
    assert.match(state.text, /fresh-界/);
    assert.match(state.text, /🧠/u);
    assert.doesNotMatch(state.text, /stale|old-tail/);
    assert.ok(state.styledCells.some((cell) => cell[0] === '界'));
    assert.ok(state.styledCells.some((cell) => cell[0] === '🧠'));

    await assert.rejects(
      terminal.replay([
        { type: 'seed_ansi', payload: { chunk: 0, totalChunks: 2, data: 'incomplete' } },
      ]),
      /incomplete seed batch/,
    );
  } finally {
    terminal.dispose();
  }
});

test('pure unit: application metrics retain numbers and discard strings', () => {
  assert.deepEqual(
    numericLeaves({
      rss: 12,
      secret: 'drop',
      nested: { count: 3, name: 'drop' },
      values: [1, 'x', 2],
    }),
    { rss: 12, nested: { count: 3 }, values: [1, 2] },
  );
  assert.equal(
    redactUrl('http://user:secret@127.0.0.1:3000/api/debug/metrics?token=secret'),
    'http://127.0.0.1:3000/api/debug/metrics',
  );
});

test('pure unit: fixture clients acknowledge only application heartbeat envelopes', () => {
  const emitted = [];
  const socket = { emit: (...args) => emitted.push(args) };

  assert.equal(acknowledgeApplicationHeartbeat(socket, { type: 'data' }), false);
  assert.equal(acknowledgeApplicationHeartbeat(socket, null), false);
  assert.equal(acknowledgeApplicationHeartbeat(socket, { type: 'ping' }), true);
  assert.deepEqual(emitted, [['pong']]);
});

test('pure unit: retained-state churn resumes the generator without resuming output', async () => {
  const signals = [];
  let churnCycles = 4;
  const fixture = {
    generatorOutputPaused: true,
    generatorPaused: true,
    generatorMetrics: () => ({ churnCycles }),
    signalGenerator: (signal) => {
      signals.push(signal);
      if (signal === 'SIGUSR2') churnCycles += 1;
    },
    pauseGenerator() {
      signals.push('SIGSTOP');
      this.generatorPaused = true;
    },
  };

  await DisposableAppFixture.prototype.churnGeneratorWhileOutputPaused.call(fixture);

  assert.deepEqual(signals, ['SIGCONT', 'SIGUSR2', 'SIGSTOP']);
  assert.equal(fixture.generatorOutputPaused, true);
  assert.equal(fixture.generatorPaused, true);
});

test('pure unit: retained-state history fill advances one row to the configured cap', async () => {
  let historySize = 254;
  let flushed = 0;
  const fixture = {
    options: { socketTimeoutMs: 10_000 },
    tmuxHistoryState: () => ({ size: historySize, limit: 256 }),
    generatorMetrics: () => ({
      historyFillFlushedCount: flushed,
      lastHistoryFillMarker: `history-fill=1337-${flushed}`,
    }),
    signalGenerator: (signal) => {
      assert.equal(signal, 'SIGXFSZ');
      flushed += 1;
      historySize += 1;
    },
  };

  const result = await DisposableAppFixture.prototype.fillTmuxHistoryToLimit.call(fixture);

  assert.deepEqual(result, {
    initialHistoryLines: 254,
    lines: 2,
    lastMarker: 'history-fill=1337-2',
    maximumAttempts: 2,
    timeoutMs: 10_000,
    size: 256,
    limit: 256,
  });
});

function stableSubscriberSample(phase, index, overrides = {}) {
  const tmuxRssBytes = overrides.tmuxRssBytes ?? 40;
  const generatorRssBytes = overrides.generatorRssBytes ?? 30;
  return sample(phase, overrides.targetRssBytes ?? 100, tmuxRssBytes + generatorRssBytes, {
    index,
    workloadProcesses: [
      { pid: 20, ppid: 1, rssBytes: tmuxRssBytes, swapBytes: 0 },
      { pid: 30, ppid: 20, rssBytes: generatorRssBytes, swapBytes: 0 },
    ],
    generators: { expectedPids: [30], alivePids: [30] },
    ...overrides,
  });
}

function stableManySubscriberReport() {
  const samples = [
    stableSubscriberSample('cache-churn-1', 0, { targetRssBytes: 100 }),
    stableSubscriberSample('cache-churn-1', 1, { targetRssBytes: 110 }),
    stableSubscriberSample('cache-churn-1', 2, { targetRssBytes: 120 }),
    stableSubscriberSample('cache-churn-2', 3, {
      targetRssBytes: 120,
      tmuxRssBytes: 42,
    }),
    stableSubscriberSample('cache-churn-2', 4, {
      targetRssBytes: 130,
      tmuxRssBytes: 42,
    }),
    stableSubscriberSample('cache-churn-2', 5, {
      targetRssBytes: 140,
      tmuxRssBytes: 42,
    }),
  ];
  for (const current of samples) {
    current.plateauStableState = {
      subscribers: [1, 2, 3].map((suffix) => ({
        socketId: `socket-${suffix}`,
        connected: true,
      })),
      server: {
        connectedClients: 3,
        tmuxHistoryLines: 256,
        tmuxHistoryLimit: 256,
      },
      workload: {
        generatorOutputBytes: 10_000,
        generatorChunks: 200,
        churnCycles: current.phase === 'cache-churn-1' ? 5 : 6,
      },
    };
  }
  const cleanup = {
    attempted: true,
    socketDisconnected: true,
    socketObservation: {
      observedCount: 3,
      disconnectedCount: 3,
      disconnectErrorCount: 0,
      timedOut: false,
      waitTimeoutMs: 10_000,
      outcomes: [1, 2, 3].map((suffix, index) => ({
        index,
        socketId: `socket-${suffix}`,
        connectedBeforeDisconnect: true,
        disconnectAttempted: true,
        disconnectError: null,
        connectedAfterWait: false,
        disconnected: true,
      })),
    },
    processAliveAfterCleanup: false,
    tmuxServerAliveAfterCleanup: false,
    storageCreated: true,
    storageExistsAfterCleanup: false,
    tempRootExistsAfterCleanup: false,
    processesGone: true,
    alivePidsAfterCleanup: [],
    residuePaths: [],
    removalError: null,
  };
  const thresholds = {
    minimumSamples: 6,
    maximumPlateauGrowthBytes: 32 * 1024 * 1024,
    maximumPlateauGrowthRatio: 0.1,
  };
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    reportKind: 'fixture-scenario',
    harness: { provenance: validHarnessProvenance() },
    scenario: { id: 'many-subscribers-one-session', execution: 'socket-fixture' },
    reproducibility: {
      plateauOutput: 'paused-after-correctness',
      tmuxHistoryLimit: 256,
      tmuxHistoryWarmupCriterion:
        'history-at-limit-output-paused-and-final-generator-marker-rendered',
    },
    target: {
      pid: 10,
      provenance: {
        method: 'linux-procfs-sha256-v1',
        capturedAt: new Date(NOW_MS).toISOString(),
        executable: {
          path: '/usr/bin/node',
          sha256: 'b'.repeat(64),
          sizeBytes: 1,
          mtimeMs: NOW_MS,
        },
        entrypoint: null,
        buildFingerprint: {
          algorithm: 'sha256',
          digest: 'c'.repeat(64),
          subjectKind: 'directory-tree',
          subjectPath: '/repo/apps/local-app/dist',
          fileCount: 1,
          totalBytes: 1,
        },
      },
    },
    fixture: {
      app: { ready: true, pid: 10, port: 3000 },
      socket: {
        connected: true,
        runtimeTokenVerified: true,
        handshakeTokenPresented: true,
        subscribed: true,
        seedObserved: true,
        receivedTypes: ['subscribed', 'seed_ansi'],
        clientCount: 3,
      },
      historyWarmup: {
        criterion: 'history-at-limit-output-paused-and-final-generator-marker-rendered',
        historyLines: 256,
        historyLimit: 256,
        generatorChunks: 200,
        generatorOutputBytes: 10_000,
        generatorChurnCycles: 4,
      },
      scratchSession: {
        sessionName: 'fixture-many',
        tmuxServerPid: 20,
        panePid: 30,
        generatorPid: 30,
        deterministicSeed: 1337,
        outputBytes: 10_000,
      },
      cleanup,
    },
    correctness: {
      pass: true,
      checks: [{ id: 'all-subscribers-converge', actual: 3, expected: 3, pass: true }],
    },
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples,
  };
}

test('pure unit: many-subscriber stable-state gate reports component plateau attribution', () => {
  const result = evaluateReport(stableManySubscriberReport());

  assert.equal(result.pass, true);
  assert.equal(result.refused, undefined);
  const stableState = result.checks.find(
    (check) => check.id === 'fixture-many-subscriber-stable-state',
  );
  assert.equal(stableState.pass, true);
  const attribution = result.checks.find(
    (check) => check.id === 'fixture-plateau-component-attribution',
  );
  assert.deepEqual(attribution.actual.target, {
    firstCycleTailMedianBytes: 110,
    secondCycleTailMedianBytes: 130,
    growthBytes: 20,
  });
  assert.deepEqual(attribution.actual.tmuxServer, {
    pid: 20,
    firstCycleTailMedianBytes: 40,
    secondCycleTailMedianBytes: 42,
    growthBytes: 2,
  });
  assert.deepEqual(attribution.actual.generator, {
    pid: 30,
    firstCycleTailMedianBytes: 30,
    secondCycleTailMedianBytes: 30,
    growthBytes: 0,
  });
});

test('pure unit: many-subscriber stable-state gate refuses a drifting retained workload', () => {
  const report = stableManySubscriberReport();
  report.samples[4].plateauStableState.server.tmuxHistoryLines = 255;

  const result = evaluateReport(report);

  assert.equal(result.pass, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /many-subscriber stable-state gate/);
  assert.equal(result.checks[0].id, 'fixture-many-subscriber-stable-state');
  assert.equal(result.checks[0].pass, false);
  assert.ok(result.checks[0].actual.failures.some((failure) => failure.includes('sample 4')));
});

test('pure unit: CLI defaults and duration profiles remain deterministic', () => {
  const options = parseArgs([
    '--',
    '--scenario',
    'host-burst-plateau',
    '--target-pid',
    '42',
    '--report',
    'reports/baseline.json',
  ]);
  assert.equal(options.seed, 1337);
  assert.equal(options.sessions, 3);
  assert.equal(options.targetPid, 42);
  assert.equal(options.appEntry, path.join(options.repoRoot, 'apps/local-app/dist/main.js'));
  assert.equal(options.appCwd, path.join(options.repoRoot, 'apps/local-app'));
  assert.equal(options.report, path.join(options.repoRoot, 'reports/baseline.json'));
  assert.equal(phaseDuration({ baselineMs: 3000, soakMs: 60000 }, 'smoke'), 1000);
  assert.equal(phaseDuration({ baselineMs: 3000, soakMs: 60000 }, 'baseline'), 3000);
  assert.equal(phaseDuration({ baselineMs: 3000, soakMs: 60000 }, 'soak'), 60000);
});

test('contract unit: runner dispatches by execution and preserves pending stubs', async () => {
  const calls = [];
  const runners = {
    alpha: async (scenario) => {
      calls.push(`alpha:${scenario.id}`);
      return { status: 'completed', pass: true };
    },
    beta: async (scenario) => {
      calls.push(`beta:${scenario.id}`);
      return { status: 'completed', pass: true };
    },
  };
  const active = { id: 'active-beta', state: 'active', execution: 'beta' };
  assert.deepEqual(await dispatchScenario(active, {}, runners), {
    status: 'completed',
    pass: true,
  });
  assert.deepEqual(calls, ['beta:active-beta']);

  const unknown = { id: 'unknown', state: 'active', execution: 'not-implemented' };
  const unknownReport = await dispatchScenario(unknown, {}, runners);
  assert.equal(unknownReport.status, 'pending');
  assert.equal(unknownReport.pass, null);

  const pending = { id: 'pending-alpha', state: 'pending', execution: 'alpha' };
  const pendingReport = await dispatchScenario(pending, {}, runners);
  assert.equal(pendingReport.status, 'pending');
  assert.deepEqual(calls, ['beta:active-beta']);
});

test(
  'contract integration: disposable app fixture authenticates, samples, and leaves no residue',
  { timeout: 30_000 },
  async () => {
    const report = await runFixtureProbeScenario(
      {
        id: 'fixture-contract-probe',
        title: 'Disposable fixture contract probe',
        state: 'active',
        execution: 'socket-fixture',
      },
      {
        repoRoot: REPO_ROOT,
        expectedRepoRoot: REPO_ROOT,
        appEntry: path.join(__dirname, 'fixtures', 'app-runtime.js'),
        appCwd: path.join(REPO_ROOT, 'apps/local-app'),
        seed: 7331,
        profile: 'smoke',
        foregroundRate: 10,
        backgroundRate: 1,
        chunkBytes: 256,
      },
    );

    assert.equal(report.pass, true);
    assert.equal(report.reportKind, 'fixture-scenario');
    assert.equal(report.target.provenance.method, 'linux-procfs-sha256-v1');
    assert.match(report.target.provenance.entrypoint.path, /fixtures\/app-runtime\.js$/);
    assert.equal(report.fixture.socket.runtimeTokenVerified, true);
    assert.equal(report.fixture.socket.handshakeTokenPresented, true);
    assert.equal(report.fixture.socket.subscribed, true);
    assert.equal(report.fixture.socket.seedObserved, true);
    assert.ok(report.fixture.scratchSession.outputBytes > 0);
    assert.equal(report.samples.length, 1);
    assert.equal(report.fixture.cleanup.processAliveAfterCleanup, false);
    assert.equal(report.fixture.cleanup.socketObservation.observedCount, 1);
    assert.equal(report.fixture.cleanup.socketObservation.disconnectedCount, 1);
    assert.equal(report.fixture.cleanup.socketObservation.disconnectErrorCount, 0);
    assert.equal(report.fixture.cleanup.socketObservation.timedOut, false);
    assert.equal(report.fixture.cleanup.socketObservation.outcomes[0].disconnected, true);
    assert.equal(report.fixture.cleanup.tmuxServerAliveAfterCleanup, false);
    assert.equal(report.fixture.cleanup.storageExistsAfterCleanup, false);
    assert.equal(report.fixture.cleanup.tempRootExistsAfterCleanup, false);
    assert.deepEqual(report.fixture.cleanup.alivePidsAfterCleanup, []);
    assert.deepEqual(report.fixture.cleanup.residuePaths, []);

    for (const id of [
      'many-subscribers-one-session',
      'reconnect-replay-available',
      'reconnect-older-than-ring',
      'stalled-and-current-socket',
      'engine-write-buffer-bounded',
      'oversized-unicode-ansi-chunking',
      'seed-during-burst',
      'zero-web-mobile-activity',
      'lifecycle-cleanup-parity',
      'summary-full-provider-parity',
      'eviction-concurrent-transcript-reads',
    ]) {
      const scenario = scenarios.find((item) => item.id === id);
      const runner = async (selected) => ({
        status: 'completed',
        pass: true,
        scenarioId: selected.id,
      });
      const dispatched = await dispatchScenario(
        scenario,
        {},
        {
          'socket-fixture': runner,
          'socket-xterm-fixture': runner,
          'mobile-fixture': runner,
          'lifecycle-fixture': runner,
          'provider-fixture': runner,
          'reader-fixture': runner,
        },
      );
      assert.deepEqual(dispatched, { status: 'completed', pass: true, scenarioId: id });
    }

    const malformed = structuredClone(report);
    delete malformed.fixture.cleanup.processAliveAfterCleanup;
    const refusal = evaluateReport(malformed, malformed.thresholds);
    assert.equal(refusal.refused, true);
    assert.match(refusal.reason, /fixture\.cleanup\.processAliveAfterCleanup/);

    const unobservedSocket = structuredClone(report);
    Object.assign(unobservedSocket.fixture.socket, {
      connected: false,
      handshakeTokenPresented: false,
      subscribed: false,
      seedObserved: false,
    });
    Object.assign(unobservedSocket.fixture.cleanup, {
      socketDisconnected: true,
      socketObservation: {
        observedCount: 0,
        disconnectedCount: 0,
        disconnectErrorCount: 0,
        timedOut: false,
        waitTimeoutMs: 10_000,
        outcomes: [],
      },
    });
    unobservedSocket.evaluation.checks.find((check) => check.id === 'fixture-cleanup').actual =
      structuredClone(unobservedSocket.fixture.cleanup);
    const unobservedRefusal = evaluateReport(unobservedSocket, unobservedSocket.thresholds);
    assert.equal(unobservedRefusal.refused, true);
    assert.match(unobservedRefusal.reason, /socketObservation\.observedCount/);

    for (const socketFailure of [
      {
        disconnectedCount: 0,
        disconnectErrorCount: 0,
        timedOut: true,
        outcome: {
          index: 0,
          socketId: 'forced-survivor',
          connectedBeforeDisconnect: true,
          disconnectAttempted: true,
          disconnectError: null,
          connectedAfterWait: true,
          disconnected: false,
        },
      },
      {
        disconnectedCount: 1,
        disconnectErrorCount: 1,
        timedOut: false,
        outcome: {
          index: 0,
          socketId: 'forced-disconnect-error',
          connectedBeforeDisconnect: true,
          disconnectAttempted: true,
          disconnectError: 'forced disconnect failure',
          connectedAfterWait: false,
          disconnected: true,
        },
      },
    ]) {
      const failedSocketCleanup = structuredClone(report);
      Object.assign(failedSocketCleanup.fixture.cleanup.socketObservation, {
        disconnectedCount: socketFailure.disconnectedCount,
        disconnectErrorCount: socketFailure.disconnectErrorCount,
        timedOut: socketFailure.timedOut,
        outcomes: [socketFailure.outcome],
      });
      failedSocketCleanup.fixture.cleanup.socketDisconnected = false;
      failedSocketCleanup.evaluation.checks.find((check) => check.id === 'fixture-cleanup').actual =
        structuredClone(failedSocketCleanup.fixture.cleanup);
      const failedEvaluation = evaluateReport(failedSocketCleanup, failedSocketCleanup.thresholds);
      assert.equal(failedEvaluation.refused, undefined);
      assert.equal(failedEvaluation.pass, false);
      assert.equal(
        failedEvaluation.checks.find((check) => check.id === 'fixture-cleanup').pass,
        false,
      );
    }

    const dishonestCorrectness = structuredClone(report);
    dishonestCorrectness.correctness = {
      pass: true,
      checks: [{ id: 'expected-outcome', actual: false, expected: true, pass: false }],
    };
    const correctnessRefusal = evaluateReport(
      dishonestCorrectness,
      dishonestCorrectness.thresholds,
    );
    assert.equal(correctnessRefusal.refused, true);
    assert.match(correctnessRefusal.reason, /correctness\.pass/);

    const mobileReport = structuredClone(report);
    mobileReport.scenario.execution = 'mobile-fixture';
    mobileReport.fixture.socket = {
      connected: false,
      runtimeTokenVerified: true,
      handshakeTokenPresented: false,
      subscribed: false,
      seedObserved: false,
      receivedTypes: [],
    };
    mobileReport.fixture.mobile = {
      authentication: { bearerAccepted: true, attestVerified: true, readyIssued: true },
    };
    const mobileEvaluation = evaluateReport(mobileReport, mobileReport.thresholds);
    assert.equal(mobileEvaluation.pass, true);
    assert.equal(
      mobileEvaluation.checks.find((check) => check.id === 'fixture-mobile-ingress-authenticated')
        .pass,
      true,
    );

    const providerReport = structuredClone(report);
    providerReport.scenario.execution = 'provider-fixture';
    providerReport.samples[0].providerRead = {
      providerName: 'claude',
      operation: 'summary',
      iteration: 0,
    };
    providerReport.samples.push({
      ...structuredClone(providerReport.samples[0]),
      index: 1,
      providerRead: { providerName: 'claude', operation: 'full', iteration: 0 },
    });
    providerReport.fixture.socket = {
      connected: false,
      runtimeTokenVerified: true,
      handshakeTokenPresented: false,
      subscribed: false,
      seedObserved: false,
      receivedTypes: [],
    };
    providerReport.fixture.providers = {
      registrySource: 'SessionReaderAdapterFactory.getSupportedProviders',
      registryProviders: ['claude'],
      availableFixtureProviders: ['claude'],
      loadedProviders: ['claude'],
      missingProviders: [],
      coverageRatio: 1,
      loadErrors: [],
      results: [
        {
          providerName: 'claude',
          sessionId: '10000000-0000-4000-8000-000000000001',
          exactFields: ['inputTokens'],
          approximateFields: [],
          exactMismatches: [],
          toleratedDifferences: [],
          unclassifiedFields: [],
          metricsEqual: true,
          summaryMetrics: { inputTokens: 1 },
          fullMetrics: { inputTokens: 1 },
          sampleIndexes: [0, 1],
          error: null,
        },
      ],
    };
    const providerEvaluation = evaluateReport(providerReport, providerReport.thresholds);
    assert.equal(providerEvaluation.pass, true);
    assert.equal(
      providerEvaluation.checks.find((check) => check.id === 'fixture-provider-registry-covered')
        .pass,
      true,
    );
    assert.equal(
      providerEvaluation.checks.find((check) => check.id === 'fixture-provider-metrics-parity')
        .pass,
      true,
    );

    const malformedProviderReport = structuredClone(providerReport);
    malformedProviderReport.fixture.providers.results[0].metricsEqual = 'yes';
    const providerRefusal = evaluateReport(
      malformedProviderReport,
      malformedProviderReport.thresholds,
    );
    assert.equal(providerRefusal.refused, true);
    assert.match(providerRefusal.reason, /fixture\.providers\.results\[0\]\.metricsEqual/);

    const backpressureReport = structuredClone(report);
    backpressureReport.thresholds = {
      minimumSamples: 1,
      minimumBackpressureSamples: 3,
      maximumStalledSocketQueueBytes: 100,
      maximumStalledEngineBufferedPackets: 2,
      maximumCurrentSocketQueueBytes: 20,
      maximumCurrentEngineBufferedPackets: 2,
      maximumCurrentDeliveryLatencyMs: 50,
    };
    const socketSnapshot = (socketId, queuedBytes, desynchronized = false) => ({
      socketId,
      connected: true,
      registered: true,
      queuedBytes,
      inFlightBytes: 0,
      engineBufferedPackets: 0,
      desynchronized,
      droppedFrames: desynchronized ? 1 : 0,
      droppedBytes: desynchronized ? 100 : 0,
    });
    backpressureReport.backpressure = {
      stallActivation: {
        socketId: 'stalled-socket',
        activatedAt: new Date().toISOString(),
      },
      observations: [10, 50, 0].map((queuedBytes, index) => ({
        elapsedMs: index * 10,
        stalled: socketSnapshot('stalled-socket', queuedBytes, index === 2),
        current: socketSnapshot('current-socket', 5),
        currentFramesReceived: index + 1,
      })),
      stalled: {
        socketId: 'stalled-socket',
        maximumQueuedBytes: 50,
        maximumInFlightBytes: 0,
        maximumEngineBufferedPackets: 0,
        queueGrowthObserved: true,
        desynchronized: true,
        droppedFrames: 1,
        disconnectedByPolicy: false,
      },
      current: {
        socketId: 'current-socket',
        maximumQueuedBytes: 5,
        maximumInFlightBytes: 0,
        maximumEngineBufferedPackets: 0,
        deliveryLatencyMs: 10,
        framesReceived: 3,
      },
    };
    const backpressureEvaluation = evaluateReport(
      backpressureReport,
      backpressureReport.thresholds,
    );
    assert.equal(backpressureEvaluation.pass, true);
    assert.equal(
      backpressureEvaluation.checks.find(
        (check) => check.id === 'fixture-current-socket-isolated-from-stalled-peer',
      ).pass,
      true,
    );

    const unboundedWriteBuffer = structuredClone(backpressureReport);
    unboundedWriteBuffer.backpressure.stalled.maximumEngineBufferedPackets = 3;
    unboundedWriteBuffer.backpressure.observations[1].stalled.engineBufferedPackets = 3;
    const unboundedEvaluation = evaluateReport(
      unboundedWriteBuffer,
      unboundedWriteBuffer.thresholds,
    );
    assert.equal(unboundedEvaluation.pass, false);
    assert.equal(
      unboundedEvaluation.checks.find(
        (check) => check.id === 'fixture-engine-write-buffers-bounded',
      ).pass,
      false,
    );

    const comparison = {
      actualSha256: 'b'.repeat(64),
      expectedSha256: 'b'.repeat(64),
      actualBytes: 12,
      expectedBytes: 12,
      firstDifference: -1,
      actualCodePoint: null,
      expectedCodePoint: null,
      actualContext: '',
      expectedContext: '',
      unmatchedActualNonWhitespaceBytes: 0,
      unmatchedExpectedNonWhitespaceBytes: 0,
      actualMarkers: { count: 1, first: 4, last: 4 },
      expectedMarkers: { count: 1, first: 4, last: 4 },
    };
    const xtermReport = structuredClone(report);
    xtermReport.scenario.execution = 'socket-xterm-fixture';
    xtermReport.reproducibility.terminalConsumer = '@xterm/headless@6.0.0';
    xtermReport.terminalEquivalence = {
      dimensions: { cols: 80, rows: 24 },
      text: comparison,
      captureRendering: structuredClone(comparison),
      style: {
        socketSha256: 'c'.repeat(64),
        freshCaptureSha256: 'c'.repeat(64),
        byteIdentical: true,
        socketCellCount: 2,
        freshCaptureCellCount: 2,
        firstDifference: -1,
        socketContext: [],
        freshCaptureContext: [],
      },
      socketSeedResets: 2,
      textNormalization: 'test normalization',
    };
    const xtermEvaluation = evaluateReport(xtermReport, xtermReport.thresholds);
    assert.equal(xtermEvaluation.pass, true);
    assert.equal(
      xtermEvaluation.checks.find((check) => check.id === 'fixture-terminal-state-equivalence')
        .pass,
      true,
    );

    const driftedXtermReport = structuredClone(xtermReport);
    driftedXtermReport.terminalEquivalence.style.byteIdentical = false;
    driftedXtermReport.terminalEquivalence.style.firstDifference = 0;
    const driftedEvaluation = evaluateReport(driftedXtermReport, driftedXtermReport.thresholds);
    assert.equal(driftedEvaluation.pass, false);
    assert.equal(
      driftedEvaluation.checks.find((check) => check.id === 'fixture-terminal-state-equivalence')
        .pass,
      false,
    );

    const malformedXtermReport = structuredClone(xtermReport);
    delete malformedXtermReport.terminalEquivalence.dimensions.rows;
    const malformedXtermEvaluation = evaluateReport(
      malformedXtermReport,
      malformedXtermReport.thresholds,
    );
    assert.equal(malformedXtermEvaluation.refused, true);
    assert.match(malformedXtermEvaluation.reason, /terminalEquivalence\.dimensions\.rows/);
  },
);

test('pure unit: fixture teardown records sockets and continues after disconnect failure', async () => {
  const tempRoot = fs.mkdtempSync('/tmp/devchain-socket-cleanup-contract-');
  const storageDir = path.join(tempRoot, 'storage');
  const tmuxRoot = path.join(tempRoot, 'tmux');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(tmuxRoot);
  let removedListeners = 0;
  const disconnected = {
    id: 'socket-ok',
    connected: true,
    disconnect() {
      this.connected = false;
    },
    removeAllListeners() {
      removedListeners += 1;
    },
  };
  const survivor = {
    id: 'socket-survivor',
    connected: true,
    disconnect() {
      throw new Error('forced disconnect failure');
    },
    removeAllListeners() {
      removedListeners += 1;
    },
  };
  const fixture = {
    cleanup: null,
    appPids: new Set(),
    tmuxServerPid: null,
    panePid: null,
    generatorPid: null,
    samples: [],
    generatorPaused: false,
    sockets: new Set([disconnected, survivor]),
    options: { socketTimeoutMs: 1 },
    appProcess: null,
    mobileIngress: null,
    tempRoot,
    storageDir,
    tmuxRoot,
    runTmux(args) {
      if (args[0] === 'list-sessions') throw new Error('no isolated server');
    },
  };

  const cleanup = await DisposableAppFixture.prototype.teardown.call(fixture);

  assert.equal(cleanup.socketDisconnected, false);
  assert.deepEqual(cleanup.socketObservation, {
    observedCount: 2,
    disconnectedCount: 1,
    disconnectErrorCount: 1,
    timedOut: true,
    waitTimeoutMs: 1,
    outcomes: [
      {
        index: 0,
        socketId: 'socket-ok',
        connectedBeforeDisconnect: true,
        disconnectAttempted: true,
        disconnectError: null,
        connectedAfterWait: false,
        disconnected: true,
      },
      {
        index: 1,
        socketId: 'socket-survivor',
        connectedBeforeDisconnect: true,
        disconnectAttempted: true,
        disconnectError: 'Error: forced disconnect failure',
        connectedAfterWait: true,
        disconnected: false,
      },
    ],
  });
  assert.equal(removedListeners, 2);
  assert.equal(fixture.sockets.size, 0);
  assert.equal(cleanup.processesGone, true);
  assert.equal(cleanup.storageExistsAfterCleanup, false);
  assert.equal(cleanup.tempRootExistsAfterCleanup, false);
  assert.deepEqual(cleanup.residuePaths, []);
});

test(
  'contract integration: transport stall is activated only by the disposable child preload',
  { timeout: 30_000 },
  async () => {
    const fixture = new DisposableAppFixture({
      appEntry: path.join(__dirname, 'fixtures', 'app-runtime.js'),
      appCwd: path.join(REPO_ROOT, 'apps/local-app'),
      seed: 8128,
      foregroundRate: 10,
      backgroundRate: 1,
      chunkBytes: 256,
      enableTransportStall: true,
    });
    try {
      await fixture.startApp();
      const client = await fixture.connectSocketClient();
      const activation = await fixture.stallClientTransport(client);
      assert.equal(activation.socketId, client.socketId);
      assert.ok(Number.isFinite(Date.parse(activation.activatedAt)));
      assert.match(fixture.childEnv.NODE_OPTIONS, /stall-engine-transport\.js/);
      fixture.disconnectClient(client);
      assert.equal(client.socketId, activation.socketId);
    } finally {
      const cleanup = await fixture.teardown();
      assert.equal(cleanup.processesGone, true);
      assert.deepEqual(cleanup.residuePaths, []);
    }
  },
);

// ---------------------------------------------------------------------------
// Generator liveness + metrics freshness (MSR1 remediation)
// ---------------------------------------------------------------------------

function generatorSample(phase, index, generators, overrides = {}) {
  const capturedAtMs = overrides.capturedAtMs ?? NOW_MS - 10_000 + index * 1_000;
  const targetRss = overrides.targetRss ?? 100;
  const workloadRss = overrides.workloadRss ?? 100;
  return {
    index,
    phase,
    system: {
      capturedAt: new Date(capturedAtMs).toISOString(),
      target: {
        rootPid: 10,
        processCount: 1,
        rssBytes: targetRss,
        swapBytes: 0,
        processes: overrides.targetProcesses ?? [
          { pid: 10, ppid: 1, rssBytes: targetRss, swapBytes: 0 },
        ],
      },
      workload: {
        rootPid: 20,
        processCount: overrides.workloadProcessCount ?? 1,
        rssBytes: workloadRss,
        swapBytes: 0,
        processes: overrides.workloadProcesses ?? [
          { pid: 20, ppid: 1, rssBytes: workloadRss, swapBytes: 0 },
        ],
      },
      cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
      host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
      sampler: { pid: 999, platform: 'linux' },
    },
    generators,
  };
}

function freshMetrics(sessionName, overrides = {}) {
  return {
    sessionName,
    outputBytes: overrides.outputBytes ?? 100_000,
    forcedGcCount: overrides.forcedGcCount ?? 3,
    capturedAt: overrides.capturedAt ?? new Date(NOW_MS).toISOString(),
  };
}

test('pure unit: generator liveness — all expected PIDs alive in every sample → pass', () => {
  const samples = [
    generatorSample('cache-churn-1', 0, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-1', 1, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-2', 2, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
  ];
  const result = evaluateGeneratorLiveness(samples);
  assert.equal(result.pass, true);
  assert.deepEqual(result.failures, []);
});

test('pure unit: generator liveness — one generator dead in a later sample → fail with named PID', () => {
  const samples = [
    generatorSample('cache-churn-1', 0, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-1', 1, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-2', 2, { expectedPids: [100, 200, 300], alivePids: [100, 300] }),
  ];
  const result = evaluateGeneratorLiveness(samples);
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].pid, 200);
  assert.equal(result.failures[0].sampleIndex, 2);
  assert.equal(result.failures[0].phase, 'cache-churn-2');
});

test('pure unit: generator liveness — all generators dead → fail with all PIDs', () => {
  const samples = [
    generatorSample('warmup', 0, { expectedPids: [100, 200], alivePids: [100, 200] }),
    generatorSample('cooldown', 1, { expectedPids: [100, 200], alivePids: [] }),
  ];
  const result = evaluateGeneratorLiveness(samples);
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 2);
});

test('pure unit: generator liveness — missing generators field → fail with actionable reason', () => {
  const samples = [
    { index: 0, phase: 'warmup', system: { capturedAt: new Date(NOW_MS).toISOString() } },
  ];
  const result = evaluateGeneratorLiveness(samples);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.reason?.includes('missing required field: generators')));
});

test('pure unit: generator liveness — changed expected PID set fails at the changed sample', () => {
  const samples = [
    generatorSample('warmup', 0, { expectedPids: [100], alivePids: [100] }),
    generatorSample('cooldown', 1, { expectedPids: [200], alivePids: [100] }),
  ];

  const result = evaluateGeneratorLiveness(samples);

  assert.equal(result.pass, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.sampleIndex === 1 && failure.reason?.includes('does not match the initial PID set'),
    ),
  );
});

test('pure unit: generator liveness — PID set rejects non-positive and duplicate members', () => {
  for (const expectedPids of [[0], [-1], [100, 100]]) {
    const result = evaluateGeneratorLiveness([
      generatorSample('warmup', 0, { expectedPids, alivePids: expectedPids }),
    ]);
    assert.equal(result.pass, false, `expected rejection for ${JSON.stringify(expectedPids)}`);
    assert.ok(
      result.failures[0].reason.includes('positive') ||
        result.failures[0].reason.includes('duplicates'),
    );
  }
});

test('pure unit: generator liveness — reordered identical PID set remains stable', () => {
  const result = evaluateGeneratorLiveness([
    generatorSample('warmup', 0, { expectedPids: [100, 200], alivePids: [100, 200] }),
    generatorSample('cooldown', 1, { expectedPids: [200, 100], alivePids: [100, 200] }),
  ]);

  assert.equal(result.pass, true);
});

test('pure unit: pane discovery — blank output rejects before any process signal', () => {
  const killCalls = [];

  assert.throws(
    () => signalWorkloads(parsePanePids('', 1), 'background', (...args) => killCalls.push(args)),
    /pane PID discovery returned no entries/,
  );
  assert.deepEqual(killCalls, []);
});

test('pure unit: pane discovery — PID 0 is rejected', () => {
  assert.throws(() => parsePanePids('0', 1), /positive integer/);
  assert.throws(() => parsePanePids('-1', 1), /positive integer/);
  assert.throws(() => parsePanePids('not-a-pid', 1), /positive integer/);
});

test('pure unit: pane discovery — duplicate PIDs are rejected', () => {
  assert.throws(() => parsePanePids('101\n101', 2), /duplicate PID 101/);
});

test('pure unit: pane discovery — session-count mismatch is rejected', () => {
  assert.throws(() => parsePanePids('101\n102', 3), /expected 3 pane PIDs, received 2/);
});

test('pure unit: pane discovery — exact unique positive set is safe to signal', () => {
  const killCalls = [];
  const pids = parsePanePids('101\n102', 2);

  signalWorkloads(pids, 'background', (...args) => killCalls.push(args));

  assert.deepEqual(pids, [101, 102]);
  assert.deepEqual(killCalls, [
    [101, 'SIGUSR1'],
    [102, 'SIGUSR1'],
  ]);
});

test('pure unit: signal guard — invalid PIDs never reach process.kill', () => {
  const killCalls = [];
  const kill = (...args) => killCalls.push(args);

  assert.throws(() => safeSignal(0, 'SIGUSR1', kill), /positive integer/);
  assert.throws(() => safeSignal(-1, 0, kill), /positive integer/);
  assert.throws(() => signalWorkloads([101, 0], 'churn', kill), /positive integer/);
  assert.deepEqual(killCalls, []);
});

test('pure unit: metrics freshness — recent capturedAt → pass', () => {
  const samples = [
    generatorSample(
      'cooldown',
      0,
      { expectedPids: [100], alivePids: [100] },
      { capturedAtMs: NOW_MS },
    ),
  ];
  const metrics = [freshMetrics('soak-0', { capturedAt: new Date(NOW_MS - 1_000).toISOString() })];
  const result = evaluateMetricsFreshness(metrics, samples);
  assert.equal(result.pass, true);
});

test('pure unit: metrics freshness — stale capturedAt → fail with session named', () => {
  const samples = [
    generatorSample(
      'cooldown',
      0,
      { expectedPids: [100], alivePids: [100] },
      { capturedAtMs: NOW_MS },
    ),
  ];
  const metrics = [freshMetrics('soak-0', { capturedAt: new Date(NOW_MS - 30_000).toISOString() })];
  const result = evaluateMetricsFreshness(metrics, samples);
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].session, 'soak-0');
  assert.ok(result.failures[0].reason.includes('stale'));
});

test('pure unit: metrics freshness — missing capturedAt in metrics → fail with actionable reason', () => {
  const samples = [generatorSample('cooldown', 0, { expectedPids: [100], alivePids: [100] })];
  const metrics = [{ sessionName: 'soak-0', outputBytes: 100, forcedGcCount: 1 }];
  const result = evaluateMetricsFreshness(metrics, samples);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.reason?.includes('no capturedAt')));
});

test('pure unit: dead generator after satisfying minimum counters → evaluateRun pass: false', () => {
  const samples = [
    generatorSample('cache-churn-1', 0, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-1', 1, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample('cache-churn-1', 2, {
      expectedPids: [100, 200, 300],
      alivePids: [100, 200, 300],
    }),
    generatorSample(
      'cache-churn-2',
      3,
      { expectedPids: [100, 200, 300], alivePids: [100, 300] },
      { capturedAtMs: NOW_MS - 2_000 },
    ),
    generatorSample(
      'cache-churn-2',
      4,
      { expectedPids: [100, 200, 300], alivePids: [100, 300] },
      { capturedAtMs: NOW_MS - 1_000 },
    ),
    generatorSample(
      'cache-churn-2',
      5,
      { expectedPids: [100, 200, 300], alivePids: [100, 300] },
      { capturedAtMs: NOW_MS },
    ),
  ];
  const metrics = [freshMetrics('soak-0'), freshMetrics('soak-1'), freshMetrics('soak-2')];
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    minimumSamples: 1,
    minimumOutputBytesPerSession: 1,
    minimumForcedGcCyclesPerSession: 1,
  };
  const result = evaluateRun(samples, metrics, thresholds, {
    attempted: true,
    serverAliveAfterCleanup: false,
  });
  assert.equal(result.pass, false);
  const livenessCheck = result.checks.find((c) => c.id === 'generator-liveness-per-sample');
  assert.equal(livenessCheck.pass, false);
  assert.ok(livenessCheck.actual.failures.some((f) => f.pid === 200));
});

test('pure unit: reviewer repro — tmux root PID alive but all generators dead + stale metrics → pass: false', () => {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(
      generatorSample(
        'cache-churn-1',
        index,
        { expectedPids: [100, 200, 300], alivePids: [] },
        { workloadProcessCount: 1, capturedAtMs: NOW_MS - 6_000 + index * 1_000 },
      ),
    );
  }
  const metrics = [
    freshMetrics('soak-0', { capturedAt: new Date(NOW_MS - 30_000).toISOString() }),
    freshMetrics('soak-1', { capturedAt: new Date(NOW_MS - 30_000).toISOString() }),
    freshMetrics('soak-2', { capturedAt: new Date(NOW_MS - 30_000).toISOString() }),
  ];
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    minimumSamples: 1,
    minimumOutputBytesPerSession: 1,
    minimumForcedGcCyclesPerSession: 1,
  };
  const result = evaluateRun(samples, metrics, thresholds, {
    attempted: true,
    serverAliveAfterCleanup: false,
  });
  assert.equal(result.pass, false);
  const livenessCheck = result.checks.find((c) => c.id === 'generator-liveness-per-sample');
  assert.equal(livenessCheck.pass, false);
  const freshnessCheck = result.checks.find((c) => c.id === 'metrics-freshness-per-session');
  assert.equal(freshnessCheck.pass, false);
});

// ---------------------------------------------------------------------------
// Sampler/target isolation (MSR2 remediation)
// ---------------------------------------------------------------------------

function isolationSample(index, overrides = {}) {
  const samplerPid = overrides.samplerPid ?? 999;
  const targetProcesses = overrides.targetProcesses ?? [
    { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 },
  ];
  const workloadProcesses = overrides.workloadProcesses ?? [
    { pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 },
  ];
  return {
    index,
    phase: overrides.phase ?? 'cache-churn-1',
    system: {
      capturedAt: new Date(NOW_MS).toISOString(),
      target: {
        rootPid: 10,
        processCount: targetProcesses.length,
        rssBytes: 100,
        swapBytes: 0,
        processes: targetProcesses,
      },
      workload: {
        rootPid: 20,
        processCount: workloadProcesses.length,
        rssBytes: 100,
        swapBytes: 0,
        processes: workloadProcesses,
      },
      cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
      host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
      sampler: { pid: samplerPid, platform: 'linux' },
    },
    generators: overrides.generators ?? { expectedPids: [20], alivePids: [20] },
  };
}

test('pure unit: isolation — sampler PID absent from target tree + trees disjoint → pass', () => {
  const samples = [
    isolationSample(0, {
      targetProcesses: [{ pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 }],
      workloadProcesses: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
    }),
    isolationSample(1, {
      targetProcesses: [{ pid: 10, ppid: 1, rssBytes: 110, swapBytes: 0 }],
      workloadProcesses: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
    }),
  ];
  const result = evaluateIsolation(samples);
  assert.equal(result.pass, true);
  assert.deepEqual(result.samplerPidFailures, []);
  assert.deepEqual(result.overlapFailures, []);
});

test('pure unit: isolation — sampler PID in target tree → fail-closed', () => {
  const samples = [
    isolationSample(0, {
      samplerPid: 999,
      targetProcesses: [
        { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 },
        { pid: 999, ppid: 10, rssBytes: 80_000_000, swapBytes: 0 },
      ],
      workloadProcesses: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
    }),
  ];
  const result = evaluateIsolation(samples);
  assert.equal(result.pass, false);
  assert.equal(result.samplerPidFailures.length, 1);
  assert.equal(result.samplerPidFailures[0].samplerPid, 999);
  assert.equal(result.samplerPidFailures[0].sampleIndex, 0);
});

test('pure unit: isolation — target/workload tree overlap → fail-closed', () => {
  const samples = [
    isolationSample(0, {
      targetProcesses: [
        { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 },
        { pid: 15, ppid: 10, rssBytes: 50, swapBytes: 0 },
      ],
      workloadProcesses: [
        { pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 },
        { pid: 15, ppid: 20, rssBytes: 50, swapBytes: 0 },
      ],
    }),
  ];
  const result = evaluateIsolation(samples);
  assert.equal(result.pass, false);
  assert.equal(result.overlapFailures.length, 1);
  assert.equal(result.overlapFailures[0].pid, 15);
});

test('pure unit: isolation — missing process-tree data → fail with actionable reason', () => {
  const samples = [
    {
      index: 0,
      phase: 'warmup',
      system: {
        capturedAt: new Date(NOW_MS).toISOString(),
        target: { rootPid: 10, processCount: 1, rssBytes: 100, swapBytes: 0 },
        workload: { rootPid: 20, processCount: 1, rssBytes: 100, swapBytes: 0 },
        cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
        host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
      },
    },
  ];
  const result = evaluateIsolation(samples);
  assert.equal(result.pass, false);
  assert.ok(result.missingDataFailures.length > 0);
  assert.ok(result.missingDataFailures.some((f) => f.reason?.includes('sampler.pid')));
});

test('pure unit: isolation — sampler in target tree → evaluateRun pass: false', () => {
  const samples = [
    isolationSample(0, {
      samplerPid: 999,
      targetProcesses: [
        { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 },
        { pid: 999, ppid: 10, rssBytes: 80_000_000, swapBytes: 0 },
      ],
      workloadProcesses: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
    }),
    isolationSample(1, {
      samplerPid: 999,
      targetProcesses: [
        { pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 },
        { pid: 999, ppid: 10, rssBytes: 90_000_000, swapBytes: 0 },
      ],
      workloadProcesses: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
    }),
  ];
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    minimumSamples: 1,
    minimumOutputBytesPerSession: 1,
    minimumForcedGcCyclesPerSession: 1,
  };
  const result = evaluateRun(samples, [freshMetrics('soak-0')], thresholds, {
    attempted: true,
    serverAliveAfterCleanup: false,
  });
  assert.equal(result.pass, false);
  const samplerCheck = result.checks.find((c) => c.id === 'sampler-not-in-target-tree');
  assert.equal(samplerCheck.pass, false);
});

test('pure unit: baseline files — no sampler PID in any target sample process list', () => {
  const baselineDir = path.join(__dirname, 'baselines');
  let entries;
  try {
    entries = fs.readdirSync(baselineDir).filter((f) => f.endsWith('.json'));
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    return; // No baseline files to validate — pass
  }
  for (const file of entries) {
    const filePath = path.join(baselineDir, file);
    const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const strictEvaluation = evaluateReport(report, report.thresholds);
    if (report.schemaVersion >= CURRENT_SCHEMA_VERSION) {
      assert.notEqual(
        strictEvaluation.refused,
        true,
        `${file}: current-schema baseline must pass the strict report-level gate`,
      );
    } else {
      assert.equal(
        strictEvaluation.refused,
        true,
        `${file}: legacy baseline must be refused by the strict report-level gate`,
      );
    }
    const runId = report.runId || '';
    const runIdParts = runId.split('-');
    const runnerPid = runIdParts.length >= 2 ? Number(runIdParts[1]) : null;
    assert.ok(Number.isInteger(runnerPid), `${file}: runId must embed a numeric PID`);
    const samples = report.samples || [];
    for (const sample of samples) {
      const targetProcesses = sample.system?.target?.processes || [];
      const targetPids = targetProcesses.map((p) => p.pid);
      assert.ok(
        !targetPids.includes(runnerPid),
        `${file}: sampler PID ${runnerPid} found in target tree at sample ${sample.index} — baseline is contaminated`,
      );
    }
  }
});

test('contract artifact: authoritative Phase-1 baseline binds target identity and stable evidence', () => {
  const baselineDir = path.join(__dirname, 'baselines');
  const entries = fs
    .readdirSync(baselineDir)
    .filter((file) => /^phase1-instrumented-[a-f0-9]{12}-(?:[a-f0-9]{12})\.json$/.test(file));
  assert.deepEqual(
    entries.sort(),
    [AUTHORITATIVE_PHASE1_BASELINE, ...HISTORICAL_PHASE1_BASELINES].sort(),
    'only the documented authoritative and historical Phase-1 baselines may be checked in',
  );

  const filename = AUTHORITATIVE_PHASE1_BASELINE;
  const report = JSON.parse(fs.readFileSync(path.join(baselineDir, filename), 'utf8'));
  const target = report.target?.provenance;
  const fingerprint = target?.buildFingerprint;
  const commitLabel = target?.commit ? target.commit.slice(0, 12) : 'nogit';
  const digestLabel = fingerprint?.digest?.slice(0, 12);

  assert.equal(report.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(filename, `phase1-instrumented-${commitLabel}-${digestLabel}.json`);
  assert.equal(validateReportSchema(report).valid, true);
  const strictEvaluation = evaluateReport(report, report.thresholds);
  assert.notEqual(strictEvaluation.refused, true);
  assert.deepEqual(strictEvaluation, report.evaluation);
  assert.equal(report.pass, strictEvaluation.pass);

  assert.equal(report.harness.provenance.method, 'git-checkout');
  assert.match(report.harness.provenance.commit, /^[a-f0-9]{40}$/);
  assert.ok(target && typeof target === 'object', 'target provenance must be present');
  assert.ok(fingerprint && typeof fingerprint === 'object', 'target fingerprint must be present');
  assert.equal(target.method, 'linux-procfs-sha256-v1');
  assert.match(target.commit, /^[a-f0-9]{40}$/);
  assert.equal(target.dirty, true);
  assert.match(target.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(target.entrypoint.sha256, /^[a-f0-9]{64}$/);
  assert.match(target.entrypoint.path, /\/dist\/main\.js$/);
  assert.match(fingerprint.digest, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint.subjectKind, 'directory-tree');
  assert.ok(fingerprint.fileCount > 0);
  assert.ok(Number.isSafeInteger(report.target.pid) && report.target.pid > 0);

  const runnerPid = Number(report.runId.split('-')[1]);
  const initialExpected = report.samples[0].generators.expectedPids;
  assert.equal(initialExpected.length, report.reproducibility.sessions);
  assert.equal(new Set(initialExpected).size, initialExpected.length);
  assert.ok(initialExpected.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  for (const sample of report.samples) {
    assert.deepEqual(sample.generators.expectedPids, initialExpected);
    assert.ok(initialExpected.every((pid) => sample.generators.alivePids.includes(pid)));
    assert.equal(sample.system.target.rootPid, report.target.pid);
    assert.ok(sample.system.target.processes.some((process) => process.pid === report.target.pid));
    assert.ok(!sample.system.target.processes.some((process) => process.pid === runnerPid));
    assert.equal(sample.application.available, true);
    assert.equal(sample.application.counters.process.pid, report.target.pid);
    assert.equal(typeof sample.application.counters.caches.aggregate.providersFailed, 'number');
  }
});

test('contract artifact: Phase-2 memory-relief evidence establishes a two-cycle plateau', () => {
  const baselineDir = path.join(__dirname, 'baselines');
  const entries = fs
    .readdirSync(baselineDir)
    .filter((file) => /^phase2-memory-relief-[a-f0-9]{12}-[a-f0-9]{12}\.json$/.test(file));
  assert.deepEqual(entries, [PHASE2_MEMORY_RELIEF_BASELINE]);

  const report = JSON.parse(
    fs.readFileSync(path.join(baselineDir, PHASE2_MEMORY_RELIEF_BASELINE), 'utf8'),
  );
  const target = report.target.provenance;
  const fingerprint = target.buildFingerprint;
  assert.equal(
    PHASE2_MEMORY_RELIEF_BASELINE,
    `phase2-memory-relief-${target.commit.slice(0, 12)}-${fingerprint.digest.slice(0, 12)}.json`,
  );
  assert.equal(validateReportSchema(report).valid, true);

  const strictEvaluation = evaluateReport(report, report.thresholds);
  assert.notEqual(strictEvaluation.refused, true);
  assert.deepEqual(strictEvaluation, report.evaluation);
  assert.equal(report.pass, strictEvaluation.pass);

  const plateau = strictEvaluation.checks.find((check) => check.id === 'two-cycle-rss-plateau');
  assert.equal(plateau.pass, true);
  assert.equal(report.workload.sessions.length, report.reproducibility.sessions);
  assert.ok(report.workload.sessions.every((session) => session.churnCycles >= 2));
  assert.ok(report.workload.sessions.every((session) => session.forcedGcCount >= 2));
});

test('contract artifact: Phase-6 final evidence is strict, plateaued, and records coverage gaps', () => {
  const baselineDir = path.join(__dirname, 'baselines');
  const evidenceDir = path.join(__dirname, 'evidence');
  const report = JSON.parse(fs.readFileSync(path.join(baselineDir, PHASE6_FINAL_SOAK), 'utf8'));
  const catalog = JSON.parse(
    fs.readFileSync(path.join(evidenceDir, PHASE6_SCENARIO_CATALOG), 'utf8'),
  );
  const xterm = JSON.parse(fs.readFileSync(path.join(evidenceDir, PHASE6_XTERM_RETENTION), 'utf8'));

  const target = report.target.provenance;
  assert.equal(
    PHASE6_FINAL_SOAK,
    `phase6-final-${target.commit.slice(0, 12)}-${target.buildFingerprint.digest.slice(0, 12)}.json`,
  );
  assert.equal(validateReportSchema(report).valid, true);
  const strictEvaluation = evaluateReport(report, report.thresholds);
  assert.deepEqual(strictEvaluation, report.evaluation);
  assert.equal(
    strictEvaluation.checks.find((check) => check.id === 'two-cycle-rss-plateau').pass,
    true,
  );
  assert.deepEqual(
    strictEvaluation.checks.filter((check) => !check.pass).map((check) => check.id),
    ['memory-psi-full-avg10'],
  );

  assert.equal(catalog.scenarios.filter((scenario) => scenario.state === 'active').length, 1);
  assert.equal(catalog.scenarios.filter((scenario) => scenario.state === 'pending').length, 11);
  const activatedSinceArtifact = new Set([
    'many-subscribers-one-session',
    'reconnect-replay-available',
    'reconnect-older-than-ring',
    'stalled-and-current-socket',
    'engine-write-buffer-bounded',
    'oversized-unicode-ansi-chunking',
    'seed-during-burst',
    'zero-web-mobile-activity',
    'lifecycle-cleanup-parity',
    'summary-full-provider-parity',
    'eviction-concurrent-transcript-reads',
  ]);
  for (const historical of catalog.scenarios) {
    const current = scenarios.find((scenario) => scenario.id === historical.id);
    assert.ok(current);
    assert.equal(historical.state, historical.id === 'host-burst-plateau' ? 'active' : 'pending');
    assert.equal(
      current.state,
      activatedSinceArtifact.has(historical.id) || historical.id === 'host-burst-plateau'
        ? 'active'
        : 'pending',
    );
  }

  assert.equal(xterm.trialCount, 3);
  assert.deepEqual(xterm.summary.xterm5.retainedEventListeners, [60, 60, 66]);
  assert.deepEqual(xterm.summary.xterm6.retainedEventListeners, [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// Strict evidence schema (M2R3 remediation — evaluator never passes on absence)
// ---------------------------------------------------------------------------

test('pure unit: strict schema — evidence-less sample after a valid sample → liveness FAIL', () => {
  const validSample = generatorSample('warmup', 0, {
    expectedPids: [100, 200],
    alivePids: [100, 200],
  });
  const evidenceless = {
    index: 1,
    phase: 'cooldown',
    system: {
      capturedAt: new Date(NOW_MS).toISOString(),
      target: {
        rootPid: 10,
        processCount: 1,
        rssBytes: 100,
        swapBytes: 0,
        processes: [{ pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 }],
      },
      workload: {
        rootPid: 20,
        processCount: 1,
        rssBytes: 100,
        swapBytes: 0,
        processes: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
      },
      cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
      host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
      sampler: { pid: 999, platform: 'linux' },
    },
  };
  const result = evaluateGeneratorLiveness([validSample, evidenceless]);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.sampleIndex === 1 && f.reason?.includes('generators')));
});

test('pure unit: strict schema — evidence-less sample → isolation FAIL', () => {
  const samples = [
    {
      index: 0,
      phase: 'warmup',
      system: {
        capturedAt: new Date(NOW_MS).toISOString(),
        target: {
          rootPid: 10,
          processCount: 1,
          rssBytes: 100,
          swapBytes: 0,
          processes: [{ pid: 10, ppid: 1, rssBytes: 100, swapBytes: 0 }],
        },
        workload: {
          rootPid: 20,
          processCount: 1,
          rssBytes: 100,
          swapBytes: 0,
          processes: [{ pid: 20, ppid: 1, rssBytes: 100, swapBytes: 0 }],
        },
        cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
        host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
        sampler: { pid: 999, platform: 'linux' },
      },
      generators: { expectedPids: [100], alivePids: [100] },
    },
    {
      index: 1,
      phase: 'cooldown',
      system: {
        capturedAt: new Date(NOW_MS).toISOString(),
        target: { rootPid: 10, processCount: 1, rssBytes: 100, swapBytes: 0 },
        workload: { rootPid: 20, processCount: 1, rssBytes: 100, swapBytes: 0 },
        cgroup: { available: true, currentBytes: 1000, swapBytes: 0 },
        host: { pressureAvailable: true, pressure: { full: { avg10: 0 } } },
      },
      generators: { expectedPids: [100], alivePids: [100] },
    },
  ];
  const result = evaluateIsolation(samples);
  assert.equal(result.pass, false);
  assert.ok(result.missingDataFailures.some((f) => f.sampleIndex === 1));
});

test('pure unit: strict schema — invalid capturedAt "not-a-date" → freshness FAIL', () => {
  const samples = [
    generatorSample(
      'cooldown',
      0,
      { expectedPids: [100], alivePids: [100] },
      { capturedAtMs: NOW_MS },
    ),
  ];
  const metrics = [freshMetrics('soak-0', { capturedAt: 'not-a-date' })];
  const result = evaluateMetricsFreshness(metrics, samples);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.reason?.includes('invalid capturedAt')));
});

test('pure unit: strict schema — schemaVersion 1 artifact → rejected', () => {
  const result = validateSchemaVersion({ schemaVersion: 1 });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('legacy schemaVersion 1'));
});

test('pure unit: strict schema — schemaVersion 2 artifact → accepted', () => {
  assert.equal(validateSchemaVersion({ schemaVersion: CURRENT_SCHEMA_VERSION }).valid, true);
});

test('pure unit: strict schema — unknown schemaVersion 3 artifact → rejected', () => {
  const result = validateSchemaVersion({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /unsupported schemaVersion 3/);
});

function validHarnessProvenance() {
  return {
    method: 'git-checkout',
    capturedAt: new Date(NOW_MS).toISOString(),
    repositoryRoot: '/repo',
    commit: 'a'.repeat(40),
    branch: 'main',
    dirty: false,
  };
}

function validReportFixture() {
  const samples = [
    generatorSample('cache-churn-1', 0, { expectedPids: [100], alivePids: [100] }),
    generatorSample('cache-churn-2', 1, { expectedPids: [100], alivePids: [100] }),
  ];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    harness: { provenance: validHarnessProvenance() },
    target: {
      provenance: {
        method: 'not-requested',
        capturedAt: new Date(NOW_MS).toISOString(),
      },
    },
    workload: { sessions: [freshMetrics('soak-0')] },
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      minimumSamples: 1,
      minimumOutputBytesPerSession: 1,
      minimumForcedGcCyclesPerSession: 1,
    },
    samples,
    evaluation: {
      checks: [
        {
          id: 'isolated-tmux-cleanup',
          actual: { attempted: true, serverAliveAfterCleanup: false },
        },
      ],
    },
  };
}

test('contract unit: strict report evaluator refuses hollow reports with named paths', () => {
  const result = evaluateReport({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    harness: { provenance: {} },
    target: { provenance: {} },
    samples: [{}],
    workload: { sessions: [] },
    thresholds: {},
    evaluation: { checks: [] },
  });

  assert.equal(result.pass, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /harness\.provenance\.method/);
  assert.match(result.reason, /target\.provenance\.method/);
});

test('contract unit: strict report evaluator refuses every malformed evidence family', async (t) => {
  const cases = [
    ['sample', 'samples[0]', (report) => (report.samples[0] = null)],
    ['system', 'samples[0].system', (report) => (report.samples[0].system = null)],
    [
      'target',
      'samples[0].system.target.rssBytes',
      (report) => {
        report.samples[0].system.target.rssBytes = undefined;
      },
    ],
    [
      'workload',
      'samples[0].system.workload.processes',
      (report) => {
        report.samples[0].system.workload.processes = null;
      },
    ],
    [
      'cgroup',
      'samples[0].system.cgroup.currentBytes',
      (report) => {
        report.samples[0].system.cgroup.currentBytes = Number.NaN;
      },
    ],
    [
      'host',
      'samples[0].system.host.pressure.full.avg10',
      (report) => {
        report.samples[0].system.host.pressure.full.avg10 = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'generator',
      'samples[0].generators.alivePids',
      (report) => {
        report.samples[0].generators.alivePids = '100';
      },
    ],
    [
      'workload-session metric',
      'workload.sessions[0].outputBytes',
      (report) => {
        report.workload.sessions[0].outputBytes = Number.NaN;
      },
    ],
    [
      'threshold',
      'thresholds.maximumTargetPeakRssBytes',
      (report) => {
        delete report.thresholds.maximumTargetPeakRssBytes;
      },
    ],
  ];

  for (const [name, expectedPath, mutate] of cases) {
    await t.test(name, () => {
      const report = validReportFixture();
      mutate(report);

      const result = evaluateReport(report);

      assert.equal(result.pass, false);
      assert.equal(result.refused, true);
      assert.match(result.reason, new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }
});

test('contract unit: strict report evaluator converts unexpected internal throws to refusal', () => {
  const report = validReportFixture();
  Object.defineProperty(report.samples[0].system.target, 'rssBytes', {
    get() {
      throw new Error('trapped target RSS getter');
    },
  });

  const result = evaluateReport(report);

  assert.equal(result.pass, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /trapped target RSS getter/);
});

test('pure unit: strict schema validator converts getter failures to invalid results', () => {
  const report = validReportFixture();
  Object.defineProperty(report.samples[0], 'system', {
    get() {
      throw new Error('trapped system getter');
    },
  });

  const result = validateReportSchema(report);

  assert.equal(result.valid, false);
  assert.match(result.reason, /schema validation failed: trapped system getter/);
});

test('pure unit: strict schema — validateReportSchema rejects missing provenance', () => {
  const complete = validReportFixture();
  assert.equal(validateReportSchema(complete).valid, true);
  const result = validateReportSchema({ schemaVersion: 2, harness: {}, target: {} });
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('harness.provenance'));
  assert.ok(result.reason.includes('target.provenance'));
});

test('contract unit: strict report evaluator refuses invalid provenance before quantitative reads', () => {
  let quantitativeReads = 0;
  const report = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    harness: {},
    target: {},
    get samples() {
      quantitativeReads += 1;
      throw new Error('quantitative samples must be unreachable');
    },
    get thresholds() {
      quantitativeReads += 1;
      throw new Error('quantitative thresholds must be unreachable');
    },
  };

  const result = evaluateReport(report);

  assert.equal(result.pass, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /harness\.provenance/);
  assert.match(result.reason, /target\.provenance/);
  assert.equal(quantitativeReads, 0);
  assert.deepEqual(result.checks, []);
});

test('contract unit: strict report evaluator preserves quantitative results for valid reports', () => {
  const samples = [
    generatorSample('cache-churn-1', 0, { expectedPids: [100], alivePids: [100] }),
    generatorSample('cache-churn-2', 1, { expectedPids: [100], alivePids: [100] }),
  ];
  const workloadMetrics = [freshMetrics('soak-0')];
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    minimumSamples: 1,
    minimumOutputBytesPerSession: 1,
    minimumForcedGcCyclesPerSession: 1,
  };
  const cleanup = { attempted: true, serverAliveAfterCleanup: false };
  const report = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    harness: { provenance: validHarnessProvenance() },
    target: {
      provenance: {
        method: 'not-requested',
        capturedAt: new Date(NOW_MS).toISOString(),
      },
    },
    workload: { sessions: workloadMetrics },
    thresholds,
    samples,
    evaluation: {
      checks: [{ id: 'isolated-tmux-cleanup', actual: cleanup }],
    },
  };

  assert.deepEqual(
    evaluateReport(report),
    evaluateRun(samples, workloadMetrics, thresholds, cleanup),
  );
});

test('contract unit: CLI runner imports the strict evaluator and never calls raw evaluateRun', () => {
  const source = fs.readFileSync(path.join(__dirname, 'lib', 'runner.js'), 'utf8');

  assert.match(source, /const \{ evaluateReport \} = require\('\.\/evaluate'\)/);
  assert.ok(!source.includes('evaluateRun('), 'runner must not bypass report-level validation');
});

test('pure unit: strict schema — evaluate.js source has no pass:null→true conversion', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'evaluate.js'), 'utf8');
  assert.ok(!src.includes('!== null ?'), 'null-conversion pattern must be eliminated');
  assert.ok(
    !src.includes('pass: null'),
    'pass:null must be eliminated — missing evidence must FAIL',
  );
});
