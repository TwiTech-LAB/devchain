'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DisposableAppFixture, isProcessAlive } = require('./app-fixture');
const { evaluateReport } = require('./evaluate');
const { HeadlessTerminalConsumer } = require('./headless-terminal');
const {
  PROVIDER_MANIFEST_PATH,
  compareProviderMetrics,
  configureProviderRegistryCapture,
  loadProviderFixtures,
  readProviderRegistryCapture,
} = require('./provider-parity-fixture');
const { sampleSystem } = require('./procfs');
const { captureTargetProvenance, createHarnessProvenance } = require('./provenance');
const {
  METRICS_SNAPSHOT_TTL_MS,
  READER_CACHE_BUDGET_BYTES,
  TRANSCRIPT_SESSION_COUNT,
  buildReaderCorrectness,
  cacheSnapshot,
  createTranscriptSessions,
  readerProfile,
  runReaderWorkload,
} = require('./reader-fixture');
const { DEFAULT_THRESHOLDS } = require('./scenarios');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runTmux(label, args, options = {}) {
  return execFileSync('tmux', ['-L', label, ...args], {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 10_000,
  }).trim();
}

function commandAvailable(command, versionArgs = ['--version']) {
  try {
    execFileSync(command, versionArgs, { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function numericLeaves(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(numericLeaves).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const numeric = numericLeaves(child);
    if (numeric !== undefined) result[key] = numeric;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function sampleApplicationMetrics(url) {
  if (!url) return { available: false, reason: 'metrics URL not configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    return { available: true, counters: numericLeaves(body) || {} };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    return { available: false, reason: `request failed (${errorName})` };
  } finally {
    clearTimeout(timeout);
  }
}

function redactUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid URL';
  }
}

function getGitMetadata(repoRoot) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }).trim();
  return {
    root: fs.realpathSync(git('rev-parse', '--show-toplevel')),
    commit: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    dirty: git('status', '--porcelain').length > 0,
  };
}

function phaseDuration(phase, profile) {
  if (profile === 'soak') return phase.soakMs;
  if (profile === 'smoke') return Math.max(500, Math.round(phase.baselineMs / 3));
  return phase.baselineMs;
}

function requirePositivePid(pid, context) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${context} must be a positive integer; received ${pid}`);
  }
  return pid;
}

function parsePanePids(rawOutput, expectedCount) {
  if (typeof rawOutput !== 'string' || rawOutput.trim().length === 0) {
    throw new Error('tmux pane PID discovery returned no entries');
  }
  const pids = rawOutput.split(/\r?\n/).map((entry, index) => {
    const value = entry.trim();
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(
        `tmux pane PID at entry ${index} must be a positive integer; received ${JSON.stringify(value)}`,
      );
    }
    return requirePositivePid(Number(value), `tmux pane PID at entry ${index}`);
  });
  const seen = new Set();
  for (const pid of pids) {
    if (seen.has(pid)) throw new Error(`tmux pane PID discovery returned duplicate PID ${pid}`);
    seen.add(pid);
  }
  if (pids.length !== expectedCount) {
    throw new Error(
      `tmux pane PID discovery expected ${expectedCount} pane PIDs, received ${pids.length}`,
    );
  }
  return pids;
}

function safeSignal(pid, signal, signalProcess = process.kill) {
  requirePositivePid(pid, 'process signal PID');
  return signalProcess(pid, signal);
}

function signalWorkloads(pids, mode, signalProcess = process.kill) {
  const signal = mode === 'background' ? 'SIGUSR1' : mode === 'churn' ? 'SIGUSR2' : null;
  if (!signal) return;
  for (const pid of pids) requirePositivePid(pid, 'workload PID');
  for (const pid of pids) {
    try {
      safeSignal(pid, signal, signalProcess);
    } catch {
      // The next sample records a missing workload process and makes the output gate fail.
    }
  }
}

function checkGeneratorLiveness(pids, signalProcess = process.kill) {
  for (const pid of pids) requirePositivePid(pid, 'generator PID');
  const alivePids = [];
  for (const pid of pids) {
    try {
      safeSignal(pid, 0, signalProcess);
      alivePids.push(pid);
    } catch {
      // Process is dead — absent from alivePids
    }
  }
  return alivePids;
}

async function collectPhaseSamples({
  phase,
  durationMs,
  intervalMs,
  targetPid,
  workloadPid,
  metricsUrl,
  samples,
  startedMonotonicMs,
  expectedGeneratorPids,
}) {
  const phaseStarted = Number(process.hrtime.bigint() / 1_000_000n);
  while (Number(process.hrtime.bigint() / 1_000_000n) - phaseStarted < durationMs) {
    const system = sampleSystem(targetPid, workloadPid);
    const application = await sampleApplicationMetrics(metricsUrl);
    samples.push({
      index: samples.length,
      phase: phase.name,
      elapsedMs: system.monotonicMs - startedMonotonicMs,
      system,
      application,
      generators: {
        expectedPids: expectedGeneratorPids,
        alivePids: checkGeneratorLiveness(expectedGeneratorPids),
      },
    });
    await sleep(intervalMs);
  }
}

async function runHostBurstScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('host-burst-plateau requires Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  if (options.targetPid && options.targetPid === process.pid) {
    throw new Error(
      `target-pid ${options.targetPid} is the sampler process (pid ${process.pid}) — target tree would include the harness, violating isolation`,
    );
  }
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }
  const harnessProvenance = createHarnessProvenance(git);
  const targetProvenance = captureTargetProvenance(options.targetPid);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-memory-soak-'));
  const label = `devchain-soak-${process.pid}-${options.seed}`;
  const metricsFiles = [];
  const sessionNames = [];
  const samples = [];
  const cleanup = { attempted: false, serverAliveAfterCleanup: null };
  let runError = null;
  let workloadPid = null;
  let workloadPids = [];
  const startedAt = new Date().toISOString();
  const startedMonotonicMs = Number(process.hrtime.bigint() / 1_000_000n);
  const profile = options.profile;
  const intervalMs = profile === 'smoke' ? 250 : profile === 'soak' ? 1_000 : 500;
  const thresholds = { ...scenario.thresholds };
  if (profile === 'smoke') {
    thresholds.minimumSamples = 10;
    thresholds.minimumOutputBytesPerSession = 8 * 1024;
  }

  try {
    for (let index = 0; index < options.sessions; index += 1) {
      const sessionName = `soak-${process.pid}-${index}`;
      const metricsFile = path.join(tempRoot, `session-${index}.json`);
      sessionNames.push(sessionName);
      metricsFiles.push(metricsFile);
      runTmux(label, [
        'new-session',
        '-d',
        '-s',
        sessionName,
        process.execPath,
        '--expose-gc',
        path.join(__dirname, '..', 'output-generator.js'),
        '--seed',
        String(options.seed + index),
        '--foreground-rate',
        String(options.foregroundRate),
        '--background-rate',
        String(options.backgroundRate),
        '--chunk-bytes',
        String(options.chunkBytes),
        '--metrics',
        metricsFile,
      ]);
    }
    workloadPid = parsePanePids(runTmux(label, ['display-message', '-p', '#{pid}']), 1)[0];
    workloadPids = parsePanePids(
      runTmux(label, ['list-panes', '-a', '-F', '#{pane_pid}']),
      options.sessions,
    );
    await sleep(250);

    for (const phase of scenario.phases) {
      signalWorkloads(workloadPids, phase.workloadMode);
      await collectPhaseSamples({
        phase,
        durationMs: phaseDuration(phase, profile),
        intervalMs,
        targetPid: options.targetPid,
        workloadPid,
        metricsUrl: options.metricsUrl,
        samples,
        startedMonotonicMs,
        expectedGeneratorPids: workloadPids,
      });
    }
  } catch (error) {
    runError = error;
  } finally {
    cleanup.attempted = true;
    try {
      runTmux(label, ['kill-server']);
    } catch {
      // A workload crash may already have stopped the isolated server.
    }
    try {
      runTmux(label, ['list-sessions']);
      cleanup.serverAliveAfterCleanup = true;
    } catch {
      cleanup.serverAliveAfterCleanup = false;
    }
  }

  const workloadMetrics = metricsFiles.map((filePath, index) => ({
    sessionName: sessionNames[index],
    ...(readJson(filePath) || { outputBytes: 0, error: 'metrics file missing' }),
  }));
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (runError) throw runError;

  // Cleanup evidence already lives in the persisted evaluation contract. Seed only that
  // raw evidence so the strict report evaluator can gate the complete report first.
  const report = {
    schemaVersion: 2,
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: { id: scenario.id, title: scenario.title, state: scenario.state },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile,
      sessions: options.sessions,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunksPerForegroundBurst: 4,
      chunkBytes: options.chunkBytes,
      sampleIntervalMs: intervalMs,
      phases: scenario.phases.map((phase) => ({
        name: phase.name,
        durationMs: phaseDuration(phase, profile),
        workloadMode: phase.workloadMode,
      })),
      gcPolicy: {
        target: 'observational only; sample before and after each phase without remote forcing',
        ownedWorkloads: 'force V8 GC once after each deterministic cache-churn replacement',
      },
    },
    harness: { provenance: harnessProvenance },
    isolation: {
      expectedRepoRoot: expectedRoot,
      isolatedTmuxLabel: label,
      applicationStorageTouched: false,
      samplerPid: process.pid,
      gate: null,
    },
    target: {
      pid: options.targetPid || null,
      metricsUrl: redactUrl(options.metricsUrl),
      provenance: targetProvenance,
    },
    workload: { tmuxServerPid: workloadPid, panePids: workloadPids, sessions: workloadMetrics },
    thresholds,
    evaluation: {
      checks: [{ id: 'isolated-tmux-cleanup', actual: cleanup }],
    },
    samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  report.isolation.gate = evaluation.summary?.isolation ?? null;
  return report;
}

async function runFixtureProbeScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('app fixture scenarios require Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }

  const fixture = new DisposableAppFixture({
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: options.chunkBytes,
  });
  const startedAt = new Date().toISOString();
  let scratchSession;
  let cleanup;
  try {
    await fixture.startApp();
    await fixture.createScratchSession();
    await fixture.attachSocketClient();
    fixture.sample();
    scratchSession = fixture.scratchEvidence();
  } finally {
    cleanup = await fixture.teardown();
  }

  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: options.chunkBytes,
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: {
      pid: fixture.appProcess.pid,
      provenance: fixture.targetProvenance,
    },
    fixture: {
      app: {
        ready: true,
        pid: fixture.appProcess.pid,
        port: fixture.port,
      },
      socket: {
        ...fixture.socketEvidence,
        receivedTypes: [...new Set(fixture.socketEvidence.receivedTypes)],
      },
      scratchSession,
      cleanup,
    },
    thresholds: { minimumSamples: 1 },
    evaluation: {
      checks: [{ id: 'fixture-cleanup', actual: cleanup }],
    },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, report.thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

function socketProfile(profile) {
  if (profile === 'soak') return { samplesPerCycle: 30, intervalMs: 1_000 };
  if (profile === 'baseline') return { samplesPerCycle: 5, intervalMs: 250 };
  return { samplesPerCycle: 3, intervalMs: 100 };
}

function backpressureProfile(profile) {
  if (profile === 'soak') return { intervalMs: 250, timeoutMs: 75_000 };
  if (profile === 'baseline') return { intervalMs: 150, timeoutMs: 15_000 };
  return { intervalMs: 100, timeoutMs: 8_000 };
}

const PAUSED_OUTPUT_SOCKET_PLATEAU_SCENARIOS = new Set([
  'many-subscribers-one-session',
  'reconnect-replay-available',
  'stalled-and-current-socket',
  'engine-write-buffer-bounded',
  'oversized-unicode-ansi-chunking',
  'seed-during-burst',
]);

function pausesOutputDuringSocketPlateau(scenarioId) {
  return PAUSED_OUTPUT_SOCKET_PLATEAU_SCENARIOS.has(scenarioId);
}

function socketPlateauOutputMode(scenarioId) {
  return pausesOutputDuringSocketPlateau(scenarioId) ? 'paused-after-correctness' : 'streaming';
}

function socketFixtureHistoryLimit(scenarioId) {
  return ['many-subscribers-one-session', 'reconnect-replay-available'].includes(scenarioId)
    ? 256
    : undefined;
}

async function captureSubscriberPlateauState(fixture, clients) {
  const metrics = await fixture.fetchMetrics();
  const generator = fixture.generatorMetrics();
  const history = fixture.tmuxHistoryState();
  return {
    subscribers: clients.map((client) => ({
      socketId: client.socketId,
      connected: client.socket.connected,
    })),
    server: {
      connectedClients: metrics.sockets?.connectedClients ?? null,
      tmuxHistoryLines: history.size,
      tmuxHistoryLimit: history.limit,
    },
    workload: {
      generatorOutputBytes: generator.outputBytes ?? null,
      generatorChunks: generator.chunks ?? null,
      churnCycles: generator.churnCycles ?? null,
    },
  };
}

async function captureRetainedReplayState(fixture, { anchor, replay }) {
  const metrics = await fixture.fetchMetrics();
  const generator = fixture.generatorMetrics();
  const history = fixture.tmuxHistoryState();
  return {
    anchor: { socketId: anchor.socketId, connected: anchor.socket.connected },
    replay: { socketId: replay.socketId, connected: replay.socket.connected },
    server: {
      connectedClients: metrics.sockets?.connectedClients ?? null,
      frameBufferSessions: metrics.frameBuffers?.sessions ?? null,
      frameBufferFrames: metrics.frameBuffers?.totalFrames ?? null,
      frameBufferBytes: metrics.frameBuffers?.bytesEstimated ?? null,
      tmuxHistoryLines: history.size,
      tmuxHistoryLimit: history.limit,
    },
    workload: {
      generatorOutputBytes: generator.outputBytes ?? null,
      generatorChunks: generator.chunks ?? null,
      churnCycles: generator.churnCycles ?? null,
    },
  };
}

async function collectSocketPlateauSamples(
  fixture,
  profile,
  pauseOutput = false,
  retainedReplayClients,
  retainedSubscriberClients,
) {
  const { samplesPerCycle, intervalMs } = socketProfile(profile);
  if (!pauseOutput) fixture.resumeGenerator();
  for (const phase of ['cache-churn-1', 'cache-churn-2']) {
    if (pauseOutput && (retainedReplayClients || retainedSubscriberClients)) {
      await fixture.churnGeneratorWhileOutputPaused();
    } else if (pauseOutput) await fixture.churnGeneratorAndPause();
    else fixture.signalGenerator('SIGUSR2');
    for (let index = 0; index < samplesPerCycle; index += 1) {
      const sample = fixture.sample(phase);
      if (retainedReplayClients) {
        sample.retainedReplayState = await captureRetainedReplayState(
          fixture,
          retainedReplayClients,
        );
      }
      if (retainedSubscriberClients) {
        sample.plateauStableState = await captureSubscriberPlateauState(
          fixture,
          retainedSubscriberClients,
        );
      }
      await sleep(intervalMs);
    }
  }
}

function mobileProfile(profile) {
  const { samplesPerCycle } = socketProfile(profile);
  return { samplesPerCycle, intervalMs: profile === 'soak' ? 1_000 : 400 };
}

async function collectMobilePlateauSamples(fixture, profile) {
  const { samplesPerCycle, intervalMs } = mobileProfile(profile);
  const observations = [];
  fixture.resumeGenerator();
  for (const phase of ['cache-churn-1', 'cache-churn-2']) {
    fixture.signalGenerator('SIGUSR2');
    for (let index = 0; index < samplesPerCycle; index += 1) {
      await sleep(intervalMs);
      const metrics = await fixture.fetchMetrics();
      const frames = fixture.mobileIngress.viewportFrames;
      const latestFrame = frames.at(-1) ?? null;
      const observation = {
        index: observations.length,
        phase,
        viewportFrameCount: frames.length,
        latestViewportSequence: latestFrame?.seq ?? null,
        latestViewportDigest: latestFrame
          ? fixture.stateDigest(JSON.stringify(latestFrame.body))
          : null,
        sessionActivity: fixture.sessionActivity(),
        generatorChunks: fixture.generatorMetrics().chunks ?? 0,
        webConnectedClients: metrics.sockets?.connectedClients ?? null,
      };
      const sample = fixture.sample(phase);
      sample.mobile = observation;
      observations.push(observation);
    }
  }
  return observations;
}

function lifecyclePathSchedule(profile) {
  const repeatCount = profile === 'soak' ? 2 : 1;
  return {
    'cache-churn-1': ['stopped', 'crashed', 'dead'],
    'cache-churn-2': Array.from({ length: repeatCount }, () => ['crashed', 'dead'])
      .flat()
      .concat(['crashed']),
  };
}

function lifecycleResourcesReleased(resources, expectedStatus) {
  return (
    resources?.status === expectedStatus &&
    resources.ptyFdCount === 0 &&
    resources.registryEntry === false &&
    resources.frameListener === false &&
    resources.ptySession === false &&
    resources.frameBuffer === false &&
    resources.globalCounts?.registryEntries === 0 &&
    resources.globalCounts?.frameListeners === 0 &&
    resources.globalCounts?.ptySessions === 0 &&
    resources.globalCounts?.frameBuffers === 0 &&
    resources.metricCounts?.ptySessions === 0 &&
    resources.metricCounts?.frameBuffers === 0 &&
    resources.metricCounts?.frameBufferFrames === 0 &&
    resources.metricCounts?.frameBufferBytes === 0
  );
}

function buildLifecycleCorrectness(pathResults) {
  const terminalStates = ['stopped', 'crashed', 'dead'];
  const resultsByPath = new Map(
    terminalStates.map((path) => [path, pathResults.filter((result) => result.path === path)]),
  );
  const signatures = pathResults.map((result) => ({
    path: result.path,
    registryEntries: result.post.globalCounts.registryEntries,
    frameListeners: result.post.globalCounts.frameListeners,
    ptySessions: result.post.globalCounts.ptySessions,
    frameBuffers: result.post.globalCounts.frameBuffers,
    ptyFdCount: result.post.ptyFdCount,
  }));
  return correctness([
    ...terminalStates.map((path) => {
      const results = resultsByPath.get(path);
      return {
        id: `lifecycle-${path}-resources-released`,
        actual: results.map((result) => result.post),
        expected: {
          executions: '> 0',
          ptyFdCount: 0,
          registryEntries: 0,
          frameListeners: 0,
          frameBuffers: 0,
        },
        pass:
          results.length > 0 &&
          results.every((result) =>
            lifecycleResourcesReleased(result.post, path === 'stopped' ? 'stopped' : 'failed'),
          ),
      };
    }),
    {
      id: 'lifecycle-post-cleanup-parity',
      actual: signatures,
      expected: {
        resourceSignature: {
          registryEntries: 0,
          frameListeners: 0,
          ptySessions: 0,
          frameBuffers: 0,
          ptyFdCount: 0,
        },
      },
      pass:
        signatures.length > 0 &&
        signatures.every(
          (signature) =>
            signature.registryEntries === 0 &&
            signature.frameListeners === 0 &&
            signature.ptySessions === 0 &&
            signature.frameBuffers === 0 &&
            signature.ptyFdCount === 0,
        ),
    },
  ]);
}

function socketAggregateEvidence(clients, seed) {
  const receivedTypes = [...new Set(clients.flatMap((client) => client.receivedTypes))];
  return {
    connected: clients.some((client) => client.connected),
    runtimeTokenVerified: true,
    handshakeTokenPresented: true,
    subscribed: clients.every((client) => client.subscribed),
    seedObserved: clients.some((client) => client.seedData.includes(`seed=${seed}`)),
    receivedTypes,
    clientCount: clients.length,
  };
}

function correctness(checks) {
  return { pass: checks.every((check) => check.pass), checks };
}

function byteComparison(fixture, actual, expected) {
  const limit = Math.min(actual.length, expected.length);
  let firstDifference = -1;
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) {
      firstDifference = index;
      break;
    }
  }
  if (firstDifference === -1 && actual.length !== expected.length) firstDifference = limit;
  const markerRange = (value) => {
    const markers = [...value.matchAll(/\bn=(\d+)\b/g)].map((match) => Number(match[1]));
    return { count: markers.length, first: markers[0] ?? null, last: markers.at(-1) ?? null };
  };
  return {
    actualSha256: fixture.stateDigest(actual),
    expectedSha256: fixture.stateDigest(expected),
    actualBytes: Buffer.byteLength(actual),
    expectedBytes: Buffer.byteLength(expected),
    firstDifference,
    actualCodePoint: firstDifference >= 0 ? (actual.codePointAt(firstDifference) ?? null) : null,
    expectedCodePoint:
      firstDifference >= 0 ? (expected.codePointAt(firstDifference) ?? null) : null,
    actualContext:
      firstDifference >= 0
        ? actual.slice(Math.max(0, firstDifference - 40), firstDifference + 80)
        : '',
    expectedContext:
      firstDifference >= 0
        ? expected.slice(Math.max(0, firstDifference - 40), firstDifference + 80)
        : '',
    unmatchedActualNonWhitespaceBytes:
      firstDifference >= 0
        ? Buffer.byteLength(actual.slice(firstDifference).replace(/\s/g, ''))
        : 0,
    unmatchedExpectedNonWhitespaceBytes:
      firstDifference >= 0
        ? Buffer.byteLength(expected.slice(firstDifference).replace(/\s/g, ''))
        : 0,
    actualMarkers: markerRange(actual),
    expectedMarkers: markerRange(expected),
  };
}

async function manySubscribersScenario(fixture, options) {
  await fixture.quiesceGenerator();
  await sleep(200);
  const before = await fixture.fetchMetrics();
  const clients = [];
  for (let index = 0; index < Math.max(3, options.sessions); index += 1) {
    clients.push(await fixture.connectSocketClient());
  }
  const after = await fixture.fetchMetrics();
  const freshCapture = fixture.captureStrict();
  const rendered = await fixture.renderBytesStrict(clients[0].seedData, 'shared-seed');
  const seedDigests = clients.map((client) => fixture.stateDigest(client.seedData));
  const captureDelta =
    (after.sockets?.terminalSeedCaptures ?? 0) - (before.sockets?.terminalSeedCaptures ?? 0);
  return {
    clients,
    plateauSubscriberClients: clients,
    correctness: correctness([
      {
        id: 'one-server-capture',
        actual: captureDelta,
        expected: 1,
        pass: captureDelta === 1,
      },
      {
        id: 'all-subscribers-converge',
        actual: { clientCount: clients.length, stateDigests: seedDigests },
        expected: { uniqueStateDigests: 1 },
        pass: new Set(seedDigests).size === 1,
      },
      {
        id: 'fresh-capture-equivalence',
        actual: byteComparison(fixture, rendered, freshCapture),
        expected: { byteIdentical: true },
        pass: rendered === freshCapture,
      },
    ]),
  };
}

function latestSequence(client) {
  return client.dataFrames.reduce(
    (maximum, frame) => Math.max(maximum, frame.sequence),
    client.subscribedPayload?.currentSequence ?? 0,
  );
}

function clientHasGeneratorChunk(client, chunkIndex) {
  const marker = ` n=${chunkIndex} `;
  return (
    client.seedData.includes(marker) ||
    client.dataFrames.some((frame) => typeof frame.data === 'string' && frame.data.includes(marker))
  );
}

function clientHasTerminalText(client, text) {
  return (
    client.seedData.includes(text) ||
    client.dataFrames.some((frame) => typeof frame.data === 'string' && frame.data.includes(text))
  );
}

function terminalBoundaryEvidence(client, marker) {
  const markerIndex = client.dataFrames.findLastIndex((frame) => frame.data.includes(marker));
  return {
    markerSequence: client.dataFrames[markerIndex]?.sequence ?? null,
    finalSequence: latestSequence(client),
    framesAfterMarker: markerIndex < 0 ? null : client.dataFrames.length - markerIndex - 1,
    markerFrameTail: client.dataFrames[markerIndex]?.data.slice(-80) ?? null,
    postMarkerHead: client.dataFrames[markerIndex + 1]?.data.slice(0, 80) ?? null,
  };
}

async function replayAvailableScenario(fixture) {
  const clients = [];
  await fixture.quiesceGenerator();
  await sleep(250);
  const anchor = await fixture.connectSocketClient();
  clients.push(anchor);
  const reconnecting = await fixture.connectSocketClient();
  clients.push(reconnecting);
  fixture.resumeGenerator();
  await fixture.waitForClient(
    reconnecting,
    (client) => client.dataFrames.length >= 2,
    'initial replay client frames',
  );
  await fixture.quiesceGenerator();
  const initialPaused = fixture.generatorMetrics();
  await fixture.waitForClient(
    reconnecting,
    (client) => clientHasGeneratorChunk(client, initialPaused.chunks - 1),
    'initial client to catch up with the paused scratch pane',
  );
  const lastSequence = latestSequence(reconnecting);
  const initialFrames = reconnecting.dataFrames.filter((frame) => frame.sequence <= lastSequence);
  fixture.disconnectClient(reconnecting);

  fixture.resumeGenerator();
  await fixture.waitForClient(
    anchor,
    (client) => latestSequence(client) >= lastSequence + 40,
    'covered replay window to fill the comparison viewport',
  );
  await fixture.quiesceGenerator();
  const replayPaused = fixture.generatorMetrics();
  await fixture.waitForClient(
    anchor,
    (client) => clientHasGeneratorChunk(client, replayPaused.chunks - 1),
    'gateway stream to catch up with the paused scratch pane',
  );
  const replayTargetSequence = latestSequence(anchor);
  const before = await fixture.fetchMetrics();
  const replay = await fixture.connectSocketClient({ lastSequence, expectSeed: false });
  clients.push(replay);
  const currentSequence = replay.subscribedPayload.currentSequence;
  await fixture.waitForClient(
    replay,
    (client) => (client.dataFrames.at(-1)?.sequence ?? -1) >= replayTargetSequence,
    'covered replay frames',
  );
  const after = await fixture.fetchMetrics();
  const replayFrames = replay.dataFrames.filter((frame) => frame.sequence > lastSequence);
  const sequences = replayFrames.map((frame) => frame.sequence);
  const strictlyOrdered = sequences.every(
    (sequence, index) => index === 0 || sequence > sequences[index - 1],
  );
  const reconstructed =
    reconnecting.seedData +
    initialFrames.map((frame) => frame.data).join('') +
    replayFrames.map((frame) => frame.data).join('');
  const rendered = await fixture.renderBytesStrict(reconstructed, 'covered-replay');
  const freshCapture = fixture.captureStrict();
  const captureDelta =
    (after.sockets?.terminalSeedCaptures ?? 0) - (before.sockets?.terminalSeedCaptures ?? 0);
  return {
    clients,
    plateauRetainedClients: { anchor, replay },
    correctness: correctness([
      {
        id: 'no-fresh-seed',
        actual: { seedChunks: replay.seedChunks.length, captureDelta },
        expected: { seedChunks: 0, captureDelta: 0 },
        pass: replay.seedChunks.length === 0 && captureDelta === 0,
      },
      {
        id: 'strictly-ordered-replay',
        actual: { lastSequence, currentSequence, replayTargetSequence, sequences },
        expected: { strictlyIncreasing: true, replayStatus: 'covered' },
        pass:
          replay.subscribedPayload.replayStatus === 'covered' &&
          sequences.length > 0 &&
          sequences[0] > lastSequence &&
          sequences.some((sequence) => sequence >= replayTargetSequence) &&
          strictlyOrdered,
      },
      {
        id: 'fresh-capture-equivalence',
        actual: byteComparison(fixture, rendered, freshCapture),
        expected: { byteIdentical: true },
        pass: rendered === freshCapture,
      },
    ]),
  };
}

async function olderThanRingScenario(fixture) {
  const clients = [];
  await fixture.quiesceGenerator();
  await sleep(250);
  const anchor = await fixture.connectSocketClient();
  clients.push(anchor);
  const reconnecting = await fixture.connectSocketClient();
  clients.push(reconnecting);
  fixture.resumeGenerator();
  await fixture.waitForClient(
    reconnecting,
    (client) => client.dataFrames.length >= 1,
    'initial stale client frame',
  );
  const lastSequence = latestSequence(reconnecting);
  fixture.disconnectClient(reconnecting);
  await fixture.waitForClient(
    anchor,
    (client) => latestSequence(client) >= lastSequence + 110,
    'bounded replay ring eviction',
  );
  await fixture.quiesceGenerator();
  const gapPaused = fixture.generatorMetrics();
  await fixture.waitForClient(
    anchor,
    (client) => clientHasGeneratorChunk(client, gapPaused.chunks - 1),
    'gap fixture stream to catch up with the paused scratch pane',
  );
  const before = await fixture.fetchMetrics();
  const recovery = await fixture.connectSocketClient({ lastSequence, expectSeed: true });
  clients.push(recovery);
  await fixture.waitForClient(
    recovery,
    (client) => {
      const finalSeed = client.seedChunks.at(-1);
      return (
        client.resyncRequired && finalSeed && client.seedChunks.length === finalSeed.totalChunks
      );
    },
    'explicit forced reseed',
  );
  const after = await fixture.fetchMetrics();
  const rendered = await fixture.renderBytesStrict(recovery.seedData, 'forced-reseed');
  const freshCapture = fixture.captureStrict();
  const captureDelta =
    (after.sockets?.terminalSeedCaptures ?? 0) - (before.sockets?.terminalSeedCaptures ?? 0);
  return {
    clients,
    correctness: correctness([
      {
        id: 'forced-reseed-explicit',
        actual: {
          replayStatus: recovery.subscribedPayload.replayStatus,
          resyncRequired: recovery.resyncRequired,
          captureDelta,
        },
        expected: { replayStatus: 'gap', resyncRequired: true, captureDelta: 1 },
        pass:
          recovery.subscribedPayload.replayStatus === 'gap' &&
          Boolean(recovery.resyncRequired) &&
          captureDelta === 1,
      },
      {
        id: 'fresh-capture-equivalence-after-reseed',
        actual: byteComparison(fixture, rendered, freshCapture),
        expected: { byteIdentical: true },
        pass: rendered === freshCapture,
      },
    ]),
  };
}

function terminalStreamIntegrity(client) {
  const payloads = client.envelopes
    .filter((envelope) => ['seed_ansi', 'data'].includes(envelope?.type))
    .map((envelope) => envelope.payload?.data)
    .filter((data) => typeof data === 'string');
  const stream = payloads.join('');
  const sequences = client.dataFrames.map((frame) => frame.sequence);
  return {
    payloadCount: payloads.length,
    streamBytes: Buffer.byteLength(stream, 'utf8'),
    maximumPayloadBytes: Math.max(0, ...payloads.map((data) => Buffer.byteLength(data, 'utf8'))),
    unicodeCodePoints: [...stream].filter((codePoint) => codePoint.codePointAt(0) > 0x7f).length,
    ansiSequences: stream.match(/\u001b\[[0-9;?]*[ -/]*[@-~]/g)?.length ?? 0,
    replacementCharacters: [...stream].filter((codePoint) => codePoint === '\ufffd').length,
    utf8RoundTrips: payloads.every((data) => Buffer.from(data, 'utf8').toString('utf8') === data),
    sequencesStrictlyIncreasing: sequences.every(
      (sequence, index) => index === 0 || sequence > sequences[index - 1],
    ),
  };
}

async function renderTerminalEquivalence(fixture, client, dimensions, strictCapture) {
  const paneDimensions = fixture.paneDimensions();
  if (paneDimensions.cols !== dimensions.cols || paneDimensions.rows !== dimensions.rows) {
    throw new Error(
      `Scratch pane dimensions ${paneDimensions.cols}x${paneDimensions.rows} do not match the headless terminal ${dimensions.cols}x${dimensions.rows}`,
    );
  }
  const socketTerminal = new HeadlessTerminalConsumer(dimensions);
  const captureTerminal = new HeadlessTerminalConsumer(dimensions);
  try {
    const socketState = await socketTerminal.replay(client.envelopes);
    const escapedCapture = fixture.captureEscaped();
    const captureState = await captureTerminal.write(escapedCapture);
    const socketCells = JSON.stringify(socketState.styledCells);
    const captureCells = JSON.stringify(captureState.styledCells);
    const socketText = socketState.text.replace(/(\p{Extended_Pictographic}) {2}/gu, '$1 ');
    let styleDifference = socketState.styledCells.findIndex(
      (cell, index) => JSON.stringify(cell) !== JSON.stringify(captureState.styledCells[index]),
    );
    if (
      styleDifference === -1 &&
      socketState.styledCells.length !== captureState.styledCells.length
    ) {
      styleDifference = Math.min(socketState.styledCells.length, captureState.styledCells.length);
    }
    return {
      dimensions,
      text: byteComparison(fixture, socketText, strictCapture),
      captureRendering: byteComparison(fixture, captureState.text, strictCapture),
      style: {
        socketSha256: fixture.stateDigest(socketCells),
        freshCaptureSha256: fixture.stateDigest(captureCells),
        byteIdentical: socketCells === captureCells,
        socketCellCount: socketState.styledCells.length,
        freshCaptureCellCount: captureState.styledCells.length,
        firstDifference: styleDifference,
        socketContext:
          styleDifference >= 0
            ? socketState.styledCells.slice(styleDifference, styleDifference + 3)
            : [],
        freshCaptureContext:
          styleDifference >= 0
            ? captureState.styledCells.slice(styleDifference, styleDifference + 3)
            : [],
      },
      socketSeedResets: socketState.seedResets,
      textNormalization: 'omit tmux wide-cell padding for extended pictographs',
    };
  } finally {
    socketTerminal.dispose();
    captureTerminal.dispose();
  }
}

async function waitForTerminalConvergence(fixture, clients, quietMs = 750, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let capture = fixture.captureStrict();
  let frameCounts = clients.map((client) => client.dataFrames.length).join(',');
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(50);
    const nextCapture = fixture.captureStrict();
    const nextFrameCounts = clients.map((client) => client.dataFrames.length).join(',');
    if (nextCapture !== capture || nextFrameCounts !== frameCounts) {
      capture = nextCapture;
      frameCounts = nextFrameCounts;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return capture;
    }
  }
  throw new Error('Socket stream and scratch tmux capture did not converge');
}

function terminalEquivalencePassed(equivalence) {
  return (
    equivalence.text.firstDifference === -1 &&
    equivalence.captureRendering.firstDifference === -1 &&
    equivalence.style.byteIdentical
  );
}

async function oversizedUnicodeAnsiScenario(fixture, options) {
  await fixture.pauseGeneratorOutput();
  await sleep(200);
  const dimensions = { cols: 512, rows: 300 };
  const client = await fixture.connectSocketClient(dimensions);
  const initialChunks = fixture.generatorMetrics().chunks;
  const requiredChunks = options.profile === 'soak' ? 32 : options.profile === 'baseline' ? 16 : 8;

  fixture.resumeGenerator();
  await fixture.waitForOutputChunks(initialChunks + requiredChunks);
  const pauseBoundary = await fixture.pauseGeneratorOutput();
  const paused = fixture.generatorMetrics();
  await fixture.waitForClient(
    client,
    (candidate) => clientHasGeneratorChunk(candidate, paused.chunks - 1),
    'oversized Unicode/ANSI stream to reach the socket client',
  );
  await fixture.waitForClient(
    client,
    (candidate) => clientHasTerminalText(candidate, pauseBoundary.marker),
    'oversized stream pause boundary',
  );
  const strictCapture = await waitForTerminalConvergence(fixture, [client]);

  const integrity = terminalStreamIntegrity(client);
  const equivalence = await renderTerminalEquivalence(fixture, client, dimensions, strictCapture);
  return {
    clients: [client],
    terminalEquivalence: equivalence,
    correctness: correctness([
      {
        id: 'oversized-generator-chunk-exercised',
        actual: {
          configuredChunkBytes: fixture.options.chunkBytes,
          outputChunks: paused.chunks - initialChunks,
          maximumSocketPayloadBytes: integrity.maximumPayloadBytes,
        },
        expected: { configuredChunkBytes: '> 64 KiB', outputChunks: `>= ${requiredChunks}` },
        pass:
          fixture.options.chunkBytes > 64 * 1024 &&
          paused.chunks - initialChunks >= requiredChunks &&
          integrity.maximumPayloadBytes > 0,
      },
      {
        id: 'utf8-boundary-integrity',
        actual: integrity,
        expected: {
          utf8RoundTrips: true,
          replacementCharacters: 0,
          unicodeCodePoints: '> 0',
          sequencesStrictlyIncreasing: true,
        },
        pass:
          integrity.utf8RoundTrips &&
          integrity.replacementCharacters === 0 &&
          integrity.unicodeCodePoints > 0 &&
          integrity.sequencesStrictlyIncreasing,
      },
      {
        id: 'ansi-state-integrity',
        actual: { ansiSequences: integrity.ansiSequences, style: equivalence.style },
        expected: { ansiSequences: '> 0', styleByteIdentical: true },
        pass: integrity.ansiSequences > 0 && equivalence.style.byteIdentical,
      },
      {
        id: 'fresh-tmux-capture-equivalence',
        actual: equivalence,
        expected: { textAndCellStateByteIdentical: true },
        pass: terminalEquivalencePassed(equivalence),
      },
    ]),
  };
}

async function seedDuringBurstScenario(fixture) {
  await fixture.pauseGeneratorOutput();
  await sleep(200);
  const dimensions = { cols: 120, rows: 30 };
  const anchor = await fixture.connectSocketClient(dimensions);
  const recovery = await fixture.connectSocketClient({
    ...dimensions,
    autoCompleteResync: false,
  });

  fixture.resumeGenerator();
  await fixture.waitForClient(
    recovery,
    (client) => client.dataFrames.length >= 2,
    'pre-recovery live frames',
  );
  recovery.socket.emit('terminal:resync_request', {
    sessionId: fixture.sessionName,
    reason: 'client_write_overflow',
  });
  await fixture.waitForClient(
    recovery,
    (client) => client.pendingResyncCompletions.length === 1,
    'watermarked recovery seed',
  );
  const pendingCompletion = recovery.pendingResyncCompletions[0];
  await fixture.waitForClient(
    anchor,
    (client) => latestSequence(client) >= pendingCompletion.capturedSequence + 20,
    'burst output spanning capture to resync completion',
  );
  const sequenceAtCompletion = latestSequence(anchor);
  const completion = fixture.completeResync(recovery);
  await fixture.waitForClient(
    recovery,
    (client) =>
      client.envelopes
        .slice(completion.envelopeIndex)
        .some(
          (envelope) =>
            envelope.type === 'data' && envelope.payload?.sequence >= sequenceAtCompletion,
        ),
    'covered recovery tail',
  );

  const pauseBoundary = await fixture.pauseGeneratorOutput();
  const paused = fixture.generatorMetrics();
  await fixture.waitForClient(
    anchor,
    (client) => clientHasGeneratorChunk(client, paused.chunks - 1),
    'anchor client to reach the final burst chunk',
  );
  const targetSequence = latestSequence(anchor);
  await fixture.waitForClient(
    recovery,
    (client) => latestSequence(client) >= targetSequence,
    'recovery client to reach the final burst sequence',
  );
  for (const client of [anchor, recovery]) {
    await fixture.waitForClient(
      client,
      (candidate) => clientHasTerminalText(candidate, pauseBoundary.marker),
      'burst pause boundary',
    );
  }
  const strictCapture = await waitForTerminalConvergence(fixture, [anchor, recovery]);

  const tailFrames = recovery.envelopes
    .slice(completion.envelopeIndex)
    .filter((envelope) => envelope.type === 'data')
    .map((envelope) => envelope.payload);
  const tailSequences = tailFrames.map((frame) => frame.sequence);
  const tailContiguous = tailSequences.every((sequence, index) =>
    index === 0
      ? sequence === pendingCompletion.capturedSequence + 1
      : sequence === tailSequences[index - 1] + 1,
  );
  const equivalence = await renderTerminalEquivalence(fixture, recovery, dimensions, strictCapture);
  const burstWindowFrames = sequenceAtCompletion - pendingCompletion.capturedSequence;
  const boundaryEvidence = terminalBoundaryEvidence(recovery, pauseBoundary.marker);
  return {
    clients: [anchor, recovery],
    terminalEquivalence: equivalence,
    correctness: correctness([
      {
        id: 'burst-spans-capture-to-resync-complete',
        actual: {
          capturedSequence: pendingCompletion.capturedSequence,
          sequenceAtCompletion,
          burstWindowFrames,
          recoveryEpoch: pendingCompletion.recoveryEpoch,
          boundary: boundaryEvidence,
        },
        expected: { burstWindowFrames: '>= 20', boundaryIsFinalFrame: true },
        pass:
          burstWindowFrames >= 20 &&
          boundaryEvidence.markerSequence === boundaryEvidence.finalSequence &&
          boundaryEvidence.framesAfterMarker === 0,
      },
      {
        id: 'covered-tail-has-no-gap',
        actual: {
          firstSequence: tailSequences[0] ?? null,
          lastSequence: tailSequences.at(-1) ?? null,
          targetSequence,
          frameCount: tailSequences.length,
          contiguous: tailContiguous,
        },
        expected: {
          firstSequence: pendingCompletion.capturedSequence + 1,
          lastSequence: `>= ${targetSequence}`,
          contiguous: true,
        },
        pass: tailSequences.length > 0 && tailSequences.at(-1) >= targetSequence && tailContiguous,
      },
      {
        id: 'fresh-tmux-capture-equivalence-after-burst-reseed',
        actual: equivalence,
        expected: { textAndCellStateByteIdentical: true, seedResets: '>= 2' },
        pass: terminalEquivalencePassed(equivalence) && equivalence.socketSeedResets >= 2,
      },
    ]),
  };
}

function terminalQueueSnapshot(metrics, client) {
  const queue = metrics.sockets?.terminalQueues?.[client.socketId];
  return {
    socketId: client.socketId,
    connected: client.socket.connected && Boolean(queue),
    registered: Boolean(queue),
    queuedBytes: queue?.queuedBytes ?? 0,
    inFlightBytes: queue?.inFlightBytes ?? 0,
    engineBufferedPackets: queue?.engineBufferedPackets ?? 0,
    desynchronized: queue?.desynchronized ?? false,
    droppedFrames: queue?.droppedFrames ?? 0,
    droppedBytes: queue?.droppedBytes ?? 0,
  };
}

function maximumObservation(observations, socketRole, field) {
  return Math.max(0, ...observations.map((observation) => observation[socketRole][field]));
}

async function stalledTransportScenario(fixture, options) {
  await fixture.quiesceGenerator();
  await sleep(200);
  const stalled = await fixture.connectSocketClient();
  const current = await fixture.connectSocketClient();
  const stallActivation = await fixture.stallClientTransport(stalled);
  const profile = backpressureProfile(options.profile);
  const startedAtMs = Date.now();
  const initialCurrentFrameCount = current.dataFrames.length;
  const observations = [];

  fixture.resumeGenerator();
  const latencyMarker = await fixture.emitLatencyMarker();
  const deadline = Date.now() + profile.timeoutMs;
  while (Date.now() < deadline) {
    const metrics = await fixture.fetchMetrics();
    const stalledSnapshot = terminalQueueSnapshot(metrics, stalled);
    const currentSnapshot = terminalQueueSnapshot(metrics, current);
    observations.push({
      elapsedMs: Date.now() - startedAtMs,
      stalled: stalledSnapshot,
      current: currentSnapshot,
      currentFramesReceived: current.dataFrames.length - initialCurrentFrameCount,
    });

    const markerReceived = current.dataFrames.some(
      (frame) =>
        frame.receivedAtMs >= startedAtMs &&
        typeof frame.data === 'string' &&
        frame.data.includes(latencyMarker.marker),
    );
    const stalledPolicyObserved =
      stalledSnapshot.desynchronized ||
      stalledSnapshot.droppedFrames > 0 ||
      !stalledSnapshot.registered;
    if (
      observations.length >= (options.scenarioThresholds?.minimumBackpressureSamples ?? 10) &&
      markerReceived &&
      stalledPolicyObserved
    ) {
      break;
    }
    await sleep(profile.intervalMs);
  }
  await fixture.quiesceGenerator();

  const markerFrame = current.dataFrames.find(
    (frame) => typeof frame.data === 'string' && frame.data.includes(latencyMarker.marker),
  );
  const finalStalled = observations.at(-1)?.stalled;
  const currentDeliveryLatencyMs = markerFrame
    ? markerFrame.receivedAtMs - latencyMarker.emittedAtMs
    : Number.MAX_SAFE_INTEGER;
  const backpressure = {
    stallActivation,
    observations,
    stalled: {
      socketId: stalled.socketId,
      maximumQueuedBytes: maximumObservation(observations, 'stalled', 'queuedBytes'),
      maximumInFlightBytes: maximumObservation(observations, 'stalled', 'inFlightBytes'),
      maximumEngineBufferedPackets: maximumObservation(
        observations,
        'stalled',
        'engineBufferedPackets',
      ),
      queueGrowthObserved: observations.some((observation) => observation.stalled.queuedBytes > 0),
      desynchronized: observations.some((observation) => observation.stalled.desynchronized),
      droppedFrames: maximumObservation(observations, 'stalled', 'droppedFrames'),
      disconnectedByPolicy: finalStalled ? !finalStalled.registered : false,
    },
    current: {
      socketId: current.socketId,
      maximumQueuedBytes: maximumObservation(observations, 'current', 'queuedBytes'),
      maximumInFlightBytes: maximumObservation(observations, 'current', 'inFlightBytes'),
      maximumEngineBufferedPackets: maximumObservation(
        observations,
        'current',
        'engineBufferedPackets',
      ),
      deliveryLatencyMs: currentDeliveryLatencyMs,
      framesReceived: current.dataFrames.length - initialCurrentFrameCount,
    },
  };

  fixture.disconnectClient(stalled);
  fixture.disconnectClient(current);
  return { clients: [stalled, current], backpressure };
}

const SOCKET_SCENARIO_RUNNERS = Object.freeze({
  'many-subscribers-one-session': manySubscribersScenario,
  'reconnect-replay-available': replayAvailableScenario,
  'reconnect-older-than-ring': olderThanRingScenario,
  'stalled-and-current-socket': stalledTransportScenario,
  'engine-write-buffer-bounded': stalledTransportScenario,
  'oversized-unicode-ansi-chunking': oversizedUnicodeAnsiScenario,
  'seed-during-burst': seedDuringBurstScenario,
});

async function runMobileFixtureScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('mobile fixture scenarios require Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }

  const fixtureOptions = {
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: options.chunkBytes,
    socketTimeoutMs: options.profile === 'soak' ? 60_000 : 30_000,
    enableMobileIngress: true,
    uuidSession: true,
  };
  const fixture = new DisposableAppFixture(fixtureOptions);
  const startedAt = new Date().toISOString();
  let authentication;
  let subscription;
  let unsubscribe;
  let observations = [];
  let scratchSession;
  let webSocketClientsAttached = null;
  let cleanup;
  try {
    await fixture.startMobileIngress();
    await fixture.startApp();
    fixture.createMobileScratchProject();
    authentication = await fixture.authenticateMobileIngress();
    const launchResponse = await fixture.mobileIngress.sendRpc('chat.launchAgent', {
      agentId: fixture.agentId,
      projectId: fixture.projectId,
    });
    if (launchResponse.error || !launchResponse.result?.operationId) {
      throw new Error(`Mobile scratch launch failed: ${JSON.stringify(launchResponse.error)}`);
    }
    const launchedSessionId = await fixture.waitForLaunchedSessionId();
    await fixture.adoptLaunchedSession(launchedSessionId);
    const response = await fixture.mobileIngress.sendRpc('terminal.viewport.subscribe', {
      sessionId: fixture.sessionName,
      projectId: fixture.projectId,
      cols: 80,
      rows: 24,
    });
    if (response.error || !response.result?.subscriptionId) {
      throw new Error(`Mobile viewport subscribe failed: ${JSON.stringify(response.error)}`);
    }
    subscription = response.result;
    const initialFrame = await fixture.mobileIngress.waitFor(
      () => fixture.mobileIngress.viewportFrames.length > 0,
      fixtureOptions.socketTimeoutMs,
    );
    if (!initialFrame) throw new Error('Mobile viewport subscription emitted no initial frame');
    observations = await collectMobilePlateauSamples(fixture, options.profile);
    const unsubscribeResponse = await fixture.mobileIngress.sendRpc(
      'terminal.viewport.unsubscribe',
      { subscriptionId: subscription.subscriptionId },
    );
    unsubscribe = unsubscribeResponse.result;
    webSocketClientsAttached = fixture.sockets.size;
    scratchSession = fixture.scratchEvidence();
  } finally {
    cleanup = await fixture.teardown();
  }

  const frames = fixture.mobileIngress.viewportFrames;
  const frameDigests = frames.map((frame) => fixture.stateDigest(JSON.stringify(frame.body)));
  const sequences = frames.map((frame) => frame.seq);
  const activities = observations
    .map((observation) => observation.sessionActivity?.lastActivityAt)
    .filter((value) => typeof value === 'string');
  const generatorChunks = observations.map((observation) => observation.generatorChunks);
  const credentialEvidence = fixture.mobileIngress.credentialEvidence();
  const outcome = correctness([
    {
      id: 'disposable-mobile-authentication',
      actual: { localAppAccepted: authentication.localAppAccepted, ...credentialEvidence },
      expected: {
        localAppAccepted: true,
        bearerAccepted: true,
        attestVerified: true,
        scope: `memory-soak:viewport-project:${fixture.projectId}`,
      },
      pass:
        authentication.localAppAccepted &&
        credentialEvidence.bearerAccepted &&
        credentialEvidence.attestVerified &&
        credentialEvidence.scope === `memory-soak:viewport-project:${fixture.projectId}` &&
        credentialEvidence.scratchProjectId === fixture.projectId,
    },
    {
      id: 'zero-web-socket-subscribers',
      actual: {
        harnessSocketClients: webSocketClientsAttached,
        sampledConnectedClients: observations.map((observation) => observation.webConnectedClients),
      },
      expected: { harnessSocketClients: 0, sampledConnectedClients: 'all zero' },
      pass:
        webSocketClientsAttached === 0 &&
        observations.length > 0 &&
        observations.every((observation) => observation.webConnectedClients === 0),
    },
    {
      id: 'mobile-viewport-content-advances',
      actual: {
        frameCount: frames.length,
        sequences,
        uniqueContentDigests: new Set(frameDigests).size,
        sessionIds: [...new Set(frames.map((frame) => frame.sessionId))],
      },
      expected: { increasingSequence: true, uniqueContentDigests: '> 1', scratchSessionOnly: true },
      pass:
        sequences.length > 1 &&
        sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]) &&
        new Set(frameDigests).size > 1 &&
        frames.every((frame) => frame.sessionId === fixture.sessionName),
    },
    {
      id: 'session-activity-advances',
      actual: {
        activityTimestamps: activities,
        firstGeneratorChunks: generatorChunks[0] ?? null,
        lastGeneratorChunks: generatorChunks.at(-1) ?? null,
      },
      expected: { distinctActivityTimestamps: '> 1', generatorChunksAdvance: true },
      pass:
        new Set(activities).size > 1 &&
        generatorChunks.length > 1 &&
        generatorChunks.at(-1) > generatorChunks[0],
    },
    {
      id: 'mobile-viewport-unsubscribed',
      actual: unsubscribe,
      expected: { ok: true },
      pass: unsubscribe?.ok === true,
    },
  ]);
  const profile = mobileProfile(options.profile);
  const thresholds = {
    minimumSamples: profile.samplesPerCycle * 2,
    maximumPlateauGrowthBytes: DEFAULT_THRESHOLDS.maximumPlateauGrowthBytes,
    maximumPlateauGrowthRatio: DEFAULT_THRESHOLDS.maximumPlateauGrowthRatio,
  };
  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
      expected: scenario.expected,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: options.chunkBytes,
      mobileFixturePath: 'authenticated-loopback-bridge-to-local-app-tunnel-ingress',
      sampleIntervalMs: profile.intervalMs,
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: { pid: fixture.appProcess.pid, provenance: fixture.targetProvenance },
    fixture: {
      app: { ready: true, pid: fixture.appProcess.pid, port: fixture.port },
      socket: {
        connected: false,
        runtimeTokenVerified: true,
        handshakeTokenPresented: false,
        subscribed: false,
        seedObserved: false,
        receivedTypes: [],
      },
      mobile: {
        pathChoice: 'authenticated bridge-path fixture against Local App mobile ingress',
        authentication: credentialEvidence,
        subscription,
        unsubscribe,
        observations,
      },
      scratchSession,
      cleanup,
    },
    correctness: outcome,
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

async function waitForLifecycleState(fixture, sessionId, predicate, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs;
  let lastResources = null;
  while (Date.now() < deadline) {
    const resources = await fixture.lifecycleResources(sessionId);
    lastResources = resources;
    if (predicate(resources)) return resources;
    await sleep(100);
  }
  throw new Error(
    `Lifecycle ${context} did not settle for ${sessionId}: ${JSON.stringify(lastResources)}`,
  );
}

async function runLifecyclePath(fixture, pathName, phase, cycleIndex) {
  fixture.prepareLifecycleLaunch();
  const launch = await fixture.mobileIngress.sendRpc('chat.launchAgent', {
    agentId: fixture.agentId,
    projectId: fixture.projectId,
  });
  if (launch.error || !launch.result?.operationId) {
    throw new Error(`Lifecycle scratch launch failed: ${JSON.stringify(launch.error)}`);
  }
  const sessionId = await fixture.waitForLaunchedSessionId();
  const session = await fixture.adoptLifecycleSession(sessionId);
  let client;
  try {
    client = await fixture.connectSocketClient({ sessionId, cols: 80, rows: 24 });
    const initial = await waitForLifecycleState(
      fixture,
      sessionId,
      (resources) =>
        resources.status === 'running' &&
        resources.ptyFdCount > 0 &&
        resources.registryEntry === true &&
        resources.frameListener === true &&
        resources.ptySession === true &&
        resources.frameBuffer === true &&
        resources.metricCounts?.ptySessions === 1 &&
        resources.metricCounts?.frameBuffers === 1,
      15_000,
      `${pathName} initial resources`,
    );
    const triggeredAt = Date.now();
    let trigger;
    if (pathName === 'stopped') {
      const response = await fetch(
        `http://127.0.0.1:${fixture.port}/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        throw new Error(`Lifecycle clean stop failed with HTTP ${response.status}`);
      }
      trigger = {
        kind: 'local-app-http',
        method: 'DELETE',
        resource: '/api/sessions/:id',
        status: response.status,
      };
    } else if (pathName === 'crashed') {
      safeSignal(session.panePid, 'SIGKILL');
      trigger = {
        kind: 'process-signal',
        signal: 'SIGKILL',
        panePid: session.panePid,
        generatorPid: session.generatorPid,
      };
    } else if (pathName === 'dead') {
      fixture.runTmux(['kill-session', '-t', `=${session.tmuxSessionName}`]);
      trigger = { kind: 'tmux-target-removal', tmuxSessionName: session.tmuxSessionName };
    } else {
      throw new Error(`Unknown lifecycle path ${pathName}`);
    }
    const expectedStatus = pathName === 'stopped' ? 'stopped' : 'failed';
    const post = await waitForLifecycleState(
      fixture,
      sessionId,
      (resources) =>
        lifecycleResourcesReleased(resources, expectedStatus) &&
        !isProcessAlive(session.generatorPid),
      pathName === 'stopped' ? 75_000 : 20_000,
      `${pathName} post-cleanup resources`,
    );
    const sample = fixture.sample(phase);
    sample.lifecycle = {
      path: pathName,
      cycleIndex,
      sessionId,
      cleanupLatencyMs: Date.now() - triggeredAt,
      resources: post,
    };
    return {
      path: pathName,
      phase,
      cycleIndex,
      session,
      trigger,
      initial,
      post,
      cleanupLatencyMs: Date.now() - triggeredAt,
      providerProcessAliveAfterCleanup: isProcessAlive(session.generatorPid),
      socket: {
        connected: client.connected,
        subscribed: client.subscribed,
        seedObserved: client.seedData.includes(`seed=${fixture.options.seed}`),
        receivedTypes: [...new Set(client.receivedTypes)],
      },
    };
  } finally {
    if (client) fixture.disconnectClient(client);
  }
}

async function runLifecycleFixtureScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('lifecycle fixture scenarios require Linux');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }

  const fixture = new DisposableAppFixture({
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: options.chunkBytes,
    socketTimeoutMs: options.profile === 'soak' ? 60_000 : 30_000,
    enableLifecycleProbe: true,
    enableMobileIngress: true,
    uuidSession: true,
  });
  const startedAt = new Date().toISOString();
  const schedule = lifecyclePathSchedule(options.profile);
  const pathResults = [];
  let authentication;
  let scratchSession;
  let cleanup;
  try {
    await fixture.startMobileIngress();
    await fixture.startApp();
    fixture.createMobileScratchProject();
    scratchSession = await fixture.createWorkloadAnchor();
    authentication = await fixture.authenticateMobileIngress();
    for (const [phase, paths] of Object.entries(schedule)) {
      for (let cycleIndex = 0; cycleIndex < paths.length; cycleIndex += 1) {
        pathResults.push(await runLifecyclePath(fixture, paths[cycleIndex], phase, cycleIndex));
      }
    }
  } finally {
    cleanup = await fixture.teardown();
  }

  const outcome = buildLifecycleCorrectness(pathResults);
  const thresholds = {
    minimumSamples: Object.values(schedule).flat().length,
    maximumPlateauGrowthBytes: DEFAULT_THRESHOLDS.maximumPlateauGrowthBytes,
    maximumPlateauGrowthRatio: DEFAULT_THRESHOLDS.maximumPlateauGrowthRatio,
  };
  const socketEvidence = {
    connected: pathResults.every((result) => result.socket.connected),
    runtimeTokenVerified: true,
    handshakeTokenPresented: true,
    subscribed: pathResults.every((result) => result.socket.subscribed),
    seedObserved: pathResults.every((result) => result.socket.seedObserved),
    receivedTypes: [...new Set(pathResults.flatMap((result) => result.socket.receivedTypes))],
    clientCount: pathResults.length,
  };
  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
      expected: scenario.expected,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: options.chunkBytes,
      lifecyclePathSchedule: schedule,
      configuredStoppedReplayRetentionMs: 60_000,
      stoppedReplayRetentionOverride: null,
      resourceProbe: 'fixture-child-preload-observing-real-resource-maps',
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: { pid: fixture.appProcess.pid, provenance: fixture.targetProvenance },
    fixture: {
      app: { ready: true, pid: fixture.appProcess.pid, port: fixture.port },
      socket: socketEvidence,
      mobile: {
        pathChoice: 'authenticated bridge-path fixture against Local App mobile ingress',
        authentication: {
          localAppAccepted: authentication.localAppAccepted,
          ...fixture.mobileIngress.credentialEvidence(),
        },
      },
      lifecycle: {
        paths: pathResults,
        resourceCounts: ['ptyFdCount', 'registryEntries', 'frameListeners', 'frameBuffers'],
      },
      scratchSession,
      cleanup,
    },
    correctness: outcome,
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

function providerProfile(profile) {
  return { iterationsPerCycle: profile === 'soak' ? 6 : 1 };
}

async function fetchProviderJson(fixture, sessionId, resource) {
  const response = await fetch(
    `http://127.0.0.1:${fixture.port}/api/sessions/${encodeURIComponent(sessionId)}/transcript${resource}`,
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${resource || '/full'} returned HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

async function collectProviderParityReads(fixture, providerFixture, capturePath, profileName) {
  const { iterationsPerCycle } = providerProfile(profileName);
  const results = new Map(
    providerFixture.sessions.map((session) => [
      session.providerName,
      {
        providerName: session.providerName,
        sessionId: session.sessionId,
        exactFields: [],
        approximateFields: [],
        exactMismatches: [],
        toleratedDifferences: [],
        unclassifiedFields: [],
        metricsEqual: false,
        summaryMetrics: null,
        fullMetrics: null,
        sampleIndexes: [],
        error: null,
      },
    ]),
  );
  for (const phase of ['cache-churn-1', 'cache-churn-2']) {
    for (let iteration = 0; iteration < iterationsPerCycle; iteration += 1) {
      for (const session of providerFixture.sessions) {
        const result = results.get(session.providerName);
        let summary;
        let full;
        try {
          summary = await fetchProviderJson(fixture, session.sessionId, '/summary');
        } catch (error) {
          result.error ??= `summary: ${String(error?.message ?? error)}`;
        } finally {
          const providerSample = fixture.sample(phase);
          providerSample.providerRead = {
            providerName: session.providerName,
            operation: 'summary',
            iteration,
          };
          result.sampleIndexes.push(providerSample.index);
        }
        try {
          full = await fetchProviderJson(fixture, session.sessionId, '');
        } catch (error) {
          result.error ??= `full: ${String(error?.message ?? error)}`;
        } finally {
          const providerSample = fixture.sample(phase);
          providerSample.providerRead = {
            providerName: session.providerName,
            operation: 'full',
            iteration,
          };
          result.sampleIndexes.push(providerSample.index);
        }
        if (phase !== 'cache-churn-1' || iteration !== 0) continue;
        if (!summary?.metrics || !full?.metrics) {
          result.error ??= 'summary or full response omitted metrics';
          continue;
        }
        const capture = readProviderRegistryCapture(capturePath);
        const contract = capture.summaryContracts?.[session.providerName];
        const comparison = compareProviderMetrics(summary.metrics, full.metrics, contract);
        Object.assign(result, comparison, {
          summaryMetrics: summary.metrics,
          fullMetrics: full.metrics,
        });
        if (!contract?.available) {
          result.error ??= 'adapter summary contract was not observed on the cold summary path';
          result.metricsEqual = false;
        }
      }
    }
  }
  return [...results.values()];
}

function buildProviderCorrectness(providerFixture, results) {
  const resultByProvider = new Map(results.map((result) => [result.providerName, result]));
  return correctness([
    {
      id: 'provider-registry-fixture-coverage',
      actual: {
        registryProviders: providerFixture.registryProviders,
        loadedProviders: providerFixture.loadedProviders,
        missingProviders: providerFixture.missingProviders,
        coverageRatio: providerFixture.coverageRatio,
        loadErrors: providerFixture.loadErrors,
      },
      expected: { coverageRatio: 1, missingProviders: [], loadErrors: [] },
      pass:
        providerFixture.registryProviders.length > 0 &&
        providerFixture.coverageRatio === 1 &&
        providerFixture.missingProviders.length === 0 &&
        providerFixture.loadErrors.length === 0,
    },
    ...providerFixture.registryProviders.map((providerName) => {
      const result = resultByProvider.get(providerName);
      return {
        id: `provider-${providerName.replace(/[^a-z0-9-]/gi, '-')}-summary-full-parity`,
        actual: result ?? { providerName, result: 'missing' },
        expected: {
          exactFieldsEqual: true,
          differencesLimitedToAdapterDeclaredApproximateFields: true,
        },
        pass: Boolean(result?.metricsEqual && !result.error),
      };
    }),
  ]);
}

async function runProviderFixtureScenario(scenario, options) {
  if (process.platform !== 'linux')
    throw new Error('provider fixture scenarios require Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }

  const fixture = new DisposableAppFixture({
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: options.chunkBytes,
    socketTimeoutMs: options.profile === 'soak' ? 60_000 : 30_000,
  });
  const capturePath = configureProviderRegistryCapture(fixture);
  const startedAt = new Date().toISOString();
  let providerFixture;
  let results = [];
  let scratchSession;
  let cleanup;
  try {
    await fixture.startApp();
    await fixture.createScratchSession();
    const initialCapture = readProviderRegistryCapture(capturePath);
    await fixture.stopApp();
    providerFixture = loadProviderFixtures(fixture, initialCapture.providers);
    await fixture.startApp();
    await fixture.quiesceGenerator();
    const activeCapture = readProviderRegistryCapture(capturePath);
    if (JSON.stringify(activeCapture.providers) !== JSON.stringify(initialCapture.providers)) {
      throw new Error('Session-reader adapter registry changed across disposable app restart');
    }
    results = await collectProviderParityReads(
      fixture,
      providerFixture,
      capturePath,
      options.profile,
    );
    scratchSession = fixture.scratchEvidence();
  } finally {
    cleanup = await fixture.teardown();
  }

  const profile = providerProfile(options.profile);
  const thresholds = {
    minimumSamples: Math.max(
      1,
      providerFixture.loadedProviders.length * profile.iterationsPerCycle * 4,
    ),
    maximumPlateauGrowthBytes: DEFAULT_THRESHOLDS.maximumPlateauGrowthBytes,
    maximumPlateauGrowthRatio: DEFAULT_THRESHOLDS.maximumPlateauGrowthRatio,
  };
  const providers = {
    registrySource: 'SessionReaderAdapterFactory.getSupportedProviders',
    registryProviders: providerFixture.registryProviders,
    availableFixtureProviders: providerFixture.availableFixtureProviders,
    loadedProviders: providerFixture.loadedProviders,
    missingProviders: providerFixture.missingProviders,
    coverageRatio: providerFixture.coverageRatio,
    loadErrors: providerFixture.loadErrors,
    results,
  };
  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
      expected: scenario.expected,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: options.chunkBytes,
      fixtureManifest: path.relative(options.repoRoot, PROVIDER_MANIFEST_PATH),
      providerIterationsPerCycle: profile.iterationsPerCycle,
      memorySamplePoint: 'immediately after each per-provider summary and full response',
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: { pid: fixture.appProcess.pid, provenance: fixture.targetProvenance },
    fixture: {
      app: { ready: true, pid: fixture.appProcess.pid, port: fixture.port },
      socket: {
        connected: false,
        runtimeTokenVerified: true,
        handshakeTokenPresented: false,
        subscribed: false,
        seedObserved: false,
        receivedTypes: [],
      },
      providers,
      scratchSession,
      cleanup,
    },
    correctness: buildProviderCorrectness(providerFixture, results),
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

async function runReaderFixtureScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('reader fixture scenarios require Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }

  const fixtureOptions = {
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: options.chunkBytes,
    socketTimeoutMs: options.profile === 'soak' ? 60_000 : 30_000,
    uuidSession: true,
  };
  const fixture = new DisposableAppFixture(fixtureOptions);
  fixture.childEnv.TRANSCRIPT_CACHE_MAX_BYTES = String(READER_CACHE_BUDGET_BYTES);
  fixture.childEnv.METRICS_LOG_INTERVAL_MS = '0';
  const startedAt = new Date().toISOString();
  let reader;
  let scratchSession;
  let cleanup;
  try {
    await fixture.startApp();
    await fixture.createScratchSession();
    const transcripts = createTranscriptSessions(fixture, options.seed, TRANSCRIPT_SESSION_COUNT);
    await fixture.restartApp();
    await fixture.attachSocketClient();
    await fixture.quiesceGenerator();
    const initialMetrics = await fixture.fetchMetrics();
    const workload = await runReaderWorkload(fixture, transcripts, options.profile);
    const finalMetrics = await fixture.fetchMetrics();
    reader = {
      cacheBudgetBytes: READER_CACHE_BUDGET_BYTES,
      metricsSnapshotTtlMs: METRICS_SNAPSHOT_TTL_MS,
      evictionSchedule: 'seeded round-robin hot session plus the next two sessions',
      transcriptWeightRule: 'source bytes * 2 parsed + source bytes * 1 chunks',
      transcripts: transcripts.map((transcript) => ({
        sessionIndex: transcript.sessionIndex,
        sessionId: transcript.sessionId,
        generation: transcript.generation,
        marker: transcript.marker,
        messageCount: transcript.messageCount,
        chunkCount: transcript.chunkCount,
        sizeBytes: transcript.sizeBytes,
      })),
      rounds: workload.rounds,
      sampleWindowMs: workload.sampleWindowMs,
      samplesPerCycle: workload.samplesPerCycle,
      intervalMs: workload.intervalMs,
      cacheSnapshots: {
        initial: cacheSnapshot(initialMetrics),
        final: cacheSnapshot(finalMetrics),
      },
    };
    scratchSession = fixture.scratchEvidence();
  } finally {
    cleanup = await fixture.teardown();
  }

  const profile = readerProfile(options.profile);
  const thresholds = {
    minimumSamples: profile.samplesPerCycle * 2,
    maximumPlateauGrowthBytes: DEFAULT_THRESHOLDS.maximumPlateauGrowthBytes,
    maximumPlateauGrowthRatio: DEFAULT_THRESHOLDS.maximumPlateauGrowthRatio,
  };
  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
      expected: scenario.expected,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: options.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: options.chunkBytes,
      transcriptSessionCount: TRANSCRIPT_SESSION_COUNT,
      transcriptCacheBudgetBytes: READER_CACHE_BUDGET_BYTES,
      metricsSnapshotTtlMs: METRICS_SNAPSHOT_TTL_MS,
      sampleIntervalMs: profile.intervalMs,
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: { pid: fixture.appProcess.pid, provenance: fixture.targetProvenance },
    fixture: {
      app: { ready: true, pid: fixture.appProcess.pid, port: fixture.port },
      socket: {
        ...fixture.socketEvidence,
        receivedTypes: [...new Set(fixture.socketEvidence.receivedTypes)],
      },
      reader,
      scratchSession,
      cleanup,
    },
    correctness: buildReaderCorrectness(reader),
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

async function runSocketFixtureScenario(scenario, options) {
  if (process.platform !== 'linux') throw new Error('socket fixture scenarios require Linux /proc');
  if (!commandAvailable('tmux', ['-V'])) throw new Error('tmux is required');
  const scenarioRunner = SOCKET_SCENARIO_RUNNERS[scenario.id];
  if (!scenarioRunner) throw new Error(`No socket fixture implementation for ${scenario.id}`);
  const git = getGitMetadata(options.repoRoot);
  const expectedRoot = options.expectedRepoRoot
    ? fs.realpathSync(options.expectedRepoRoot)
    : git.root;
  if (git.root !== expectedRoot) {
    throw new Error(`Worktree isolation check failed: expected ${expectedRoot}, found ${git.root}`);
  }
  const backpressureScenario = [
    'stalled-and-current-socket',
    'engine-write-buffer-bounded',
  ].includes(scenario.id);
  const xtermScenario = ['oversized-unicode-ansi-chunking', 'seed-during-burst'].includes(
    scenario.id,
  );
  const oversizedScenario = scenario.id === 'oversized-unicode-ansi-chunking';
  const plateauOutput = socketPlateauOutputMode(scenario.id);
  const pauseOutputDuringPlateau = plateauOutput === 'paused-after-correctness';
  const fixtureOptions = {
    appEntry: options.appEntry,
    appCwd: options.appCwd,
    seed: options.seed,
    foregroundRate: backpressureScenario
      ? Math.max(options.foregroundRate, 64)
      : options.foregroundRate,
    backgroundRate: options.backgroundRate,
    chunkBytes: backpressureScenario
      ? Math.max(options.chunkBytes, 16 * 1024)
      : oversizedScenario
        ? Math.max(options.chunkBytes, 128 * 1024)
        : options.chunkBytes,
    socketTimeoutMs: options.profile === 'soak' ? 60_000 : 30_000,
    enableTransportStall: backpressureScenario,
    historyLimit: socketFixtureHistoryLimit(scenario.id),
  };
  const fixture = new DisposableAppFixture(fixtureOptions);
  const startedAt = new Date().toISOString();
  let outcome;
  let historyWarmup;
  let plateauRetainedState;
  let scratchSession;
  let cleanup;
  try {
    await fixture.startApp();
    await fixture.createScratchSession();
    await fixture.restartApp();
    outcome = await scenarioRunner(fixture, {
      ...options,
      scenarioThresholds: scenario.thresholds,
    });
    if (fixtureOptions.historyLimit) historyWarmup = await fixture.warmTmuxHistoryToLimit();
    await collectSocketPlateauSamples(
      fixture,
      options.profile,
      pauseOutputDuringPlateau,
      outcome.plateauRetainedClients,
      outcome.plateauSubscriberClients,
    );
    if (outcome.plateauRetainedClients) {
      const retainedSamples = fixture.samples
        .map((sample) => sample.retainedReplayState)
        .filter(Boolean);
      const finalRetainedState = retainedSamples.at(-1);
      const churnCyclesByPhase = Object.fromEntries(
        fixture.samples.map((sample) => [
          sample.phase,
          sample.retainedReplayState?.workload.churnCycles,
        ]),
      );
      plateauRetainedState = {
        ...finalRetainedState,
        sampleCount: retainedSamples.length,
        allSamplesConnected: retainedSamples.every(
          (state) =>
            state.anchor.connected && state.replay.connected && state.server.connectedClients >= 2,
        ),
        replayResidentInAllSamples: retainedSamples.every(
          (state) =>
            state.server.frameBufferSessions >= 1 &&
            state.server.frameBufferFrames > 0 &&
            state.server.frameBufferBytes > 0,
        ),
        tmuxHistoryAtLimitInAllSamples: retainedSamples.every(
          (state) =>
            state.server.tmuxHistoryLines === fixtureOptions.historyLimit &&
            state.server.tmuxHistoryLimit === fixtureOptions.historyLimit,
        ),
        generatorOutputBytesUnchangedInAllSamples: retainedSamples.every(
          (state) => state.workload.generatorOutputBytes === historyWarmup?.generatorOutputBytes,
        ),
        churnExecutedInEveryPhase:
          churnCyclesByPhase['cache-churn-1'] === historyWarmup?.generatorChurnCycles + 1 &&
          churnCyclesByPhase['cache-churn-2'] === historyWarmup?.generatorChurnCycles + 2,
      };
      outcome.correctness.checks.push({
        id: 'retained-replay-state-sampled-after-output-pause',
        actual: plateauRetainedState,
        expected: {
          anchorConnected: true,
          replayConnected: true,
          connectedClients: '>= 2',
          frameBufferSessions: '>= 1',
          frameBufferFrames: '> 0',
          tmuxHistoryLines: fixtureOptions.historyLimit,
          generatorOutputBytes: historyWarmup?.generatorOutputBytes,
          memoryOnlyChurnPhases: 2,
          everyPlateauSample: true,
        },
        pass:
          retainedSamples.length === fixture.samples.length &&
          plateauRetainedState.allSamplesConnected &&
          plateauRetainedState.replayResidentInAllSamples &&
          plateauRetainedState.tmuxHistoryAtLimitInAllSamples &&
          plateauRetainedState.generatorOutputBytesUnchangedInAllSamples &&
          plateauRetainedState.churnExecutedInEveryPhase,
      });
      outcome.correctness.pass = outcome.correctness.checks.every((check) => check.pass);
    }
    scratchSession = fixture.scratchEvidence();
  } finally {
    cleanup = await fixture.teardown();
  }
  const profile = socketProfile(options.profile);
  const thresholds = {
    minimumSamples: profile.samplesPerCycle * 2,
    maximumPlateauGrowthBytes: DEFAULT_THRESHOLDS.maximumPlateauGrowthBytes,
    maximumPlateauGrowthRatio: DEFAULT_THRESHOLDS.maximumPlateauGrowthRatio,
    ...(scenario.thresholds || {}),
  };
  const report = {
    schemaVersion: 2,
    reportKind: 'fixture-scenario',
    runId: `${Date.now()}-${process.pid}-${options.seed}`,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      state: scenario.state,
      execution: scenario.execution,
      expected: scenario.expected,
    },
    status: 'completed',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    reproducibility: {
      seed: options.seed,
      profile: options.profile,
      foregroundBurstsPerSecond: fixtureOptions.foregroundRate,
      backgroundBurstsPerSecond: options.backgroundRate,
      chunkBytes: fixtureOptions.chunkBytes,
      plateauOutput,
      ...(fixtureOptions.historyLimit && { tmuxHistoryLimit: fixtureOptions.historyLimit }),
      ...(historyWarmup && { tmuxHistoryWarmupCriterion: historyWarmup.criterion }),
      ...(backpressureScenario && {
        transportControl: 'fixture-child-preload',
        requestedForegroundBurstsPerSecond: options.foregroundRate,
        requestedChunkBytes: options.chunkBytes,
      }),
      ...(xtermScenario && { terminalConsumer: '@xterm/headless@6.0.0' }),
    },
    harness: { provenance: createHarnessProvenance(git) },
    target: { pid: fixture.appProcess.pid, provenance: fixture.targetProvenance },
    fixture: {
      app: { ready: true, pid: fixture.appProcess.pid, port: fixture.port },
      socket: socketAggregateEvidence(outcome.clients, options.seed),
      ...(plateauRetainedState && { plateauRetainedState }),
      ...(historyWarmup && { historyWarmup }),
      scratchSession,
      cleanup,
    },
    correctness: outcome.correctness,
    ...(outcome.backpressure && { backpressure: outcome.backpressure }),
    ...(outcome.terminalEquivalence && { terminalEquivalence: outcome.terminalEquivalence }),
    thresholds,
    evaluation: { checks: [{ id: 'fixture-cleanup', actual: cleanup }] },
    samples: fixture.samples,
  };
  const evaluation = evaluateReport(report, thresholds);
  report.pass = evaluation.pass;
  report.evaluation = evaluation;
  return report;
}

function pendingScenarioReport(scenario) {
  return {
    schemaVersion: 1,
    scenario,
    status: 'pending',
    pass: null,
    generatedAt: new Date().toISOString(),
  };
}

const EXECUTION_RUNNERS = Object.freeze({
  'tmux-host': runHostBurstScenario,
  'socket-fixture': runSocketFixtureScenario,
  'socket-xterm-fixture': runSocketFixtureScenario,
  'mobile-fixture': runMobileFixtureScenario,
  'lifecycle-fixture': runLifecycleFixtureScenario,
  'provider-fixture': runProviderFixtureScenario,
  'reader-fixture': runReaderFixtureScenario,
});

async function dispatchScenario(scenario, options, executionRunners = EXECUTION_RUNNERS) {
  if (scenario.state === 'pending') return pendingScenarioReport(scenario);
  const runner = executionRunners[scenario.execution];
  if (typeof runner !== 'function') return pendingScenarioReport(scenario);
  return runner(scenario, options);
}

module.exports = {
  EXECUTION_RUNNERS,
  buildLifecycleCorrectness,
  dispatchScenario,
  getGitMetadata,
  numericLeaves,
  parsePanePids,
  pausesOutputDuringSocketPlateau,
  socketFixtureHistoryLimit,
  socketPlateauOutputMode,
  phaseDuration,
  redactUrl,
  runFixtureProbeScenario,
  runLifecycleFixtureScenario,
  runMobileFixtureScenario,
  runProviderFixtureScenario,
  runReaderFixtureScenario,
  runSocketFixtureScenario,
  runHostBurstScenario,
  safeSignal,
  sampleApplicationMetrics,
  signalWorkloads,
};
