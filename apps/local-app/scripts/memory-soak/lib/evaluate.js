'use strict';

const METRICS_STALENESS_THRESHOLD_MS = 5_000;
const CURRENT_SCHEMA_VERSION = 2;

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function cycleTailRss(samples, phaseName) {
  return samples
    .filter((sample) => sample.phase === phaseName)
    .slice(-3)
    .map((sample) => sample.system.target.rssBytes + sample.system.workload.rssBytes);
}

function evaluatePlateau(samples, thresholds) {
  const first = median(cycleTailRss(samples, 'cache-churn-1'));
  const second = median(cycleTailRss(samples, 'cache-churn-2'));
  const growthBytes = second - first;
  const growthRatio = first > 0 ? growthBytes / first : Number.POSITIVE_INFINITY;
  const pass =
    first > 0 &&
    second > 0 &&
    (growthBytes <= thresholds.maximumPlateauGrowthBytes ||
      growthRatio <= thresholds.maximumPlateauGrowthRatio);
  return {
    firstCycleTailMedianBytes: first,
    secondCycleTailMedianBytes: second,
    growthBytes,
    growthRatio,
    pass,
  };
}

function componentTailMedian(samples, phaseName, selectRssBytes, componentName, failures) {
  const tail = samples.filter((sample) => sample.phase === phaseName).slice(-3);
  if (tail.length !== 3) {
    failures.push(`${componentName} ${phaseName} requires exactly three tail samples`);
  }
  const values = tail.map((sample) => selectRssBytes(sample));
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      failures.push(`${componentName} ${phaseName} tail sample ${index} is unavailable`);
    }
  });
  return median(values.filter(Number.isFinite));
}

function plateauComponentAttribution(samples, componentName, selectRssBytes, failures, pid) {
  const firstCycleTailMedianBytes = componentTailMedian(
    samples,
    'cache-churn-1',
    selectRssBytes,
    componentName,
    failures,
  );
  const secondCycleTailMedianBytes = componentTailMedian(
    samples,
    'cache-churn-2',
    selectRssBytes,
    componentName,
    failures,
  );
  return {
    ...(pid !== undefined && { pid }),
    firstCycleTailMedianBytes,
    secondCycleTailMedianBytes,
    growthBytes: secondCycleTailMedianBytes - firstCycleTailMedianBytes,
  };
}

function evaluateFixturePlateauAttribution(report) {
  const failures = [];
  const tmuxServerPid = report.fixture?.scratchSession?.tmuxServerPid;
  const generatorPid = report.fixture?.scratchSession?.generatorPid;
  const processRssBytes = (sample, pid) =>
    sample.system?.workload?.processes?.find((processInfo) => processInfo.pid === pid)?.rssBytes;
  const target = plateauComponentAttribution(
    report.samples,
    'target',
    (sample) => sample.system?.target?.rssBytes,
    failures,
  );
  const tmuxServer = plateauComponentAttribution(
    report.samples,
    'tmux-server',
    (sample) => processRssBytes(sample, tmuxServerPid),
    failures,
    tmuxServerPid,
  );
  const generator = plateauComponentAttribution(
    report.samples,
    'generator',
    (sample) => processRssBytes(sample, generatorPid),
    failures,
    generatorPid,
  );
  return {
    pass: failures.length === 0,
    window: { phases: ['cache-churn-1', 'cache-churn-2'], tailSamplesPerPhase: 3 },
    target,
    tmuxServer,
    generator,
    failures,
  };
}

function evaluateManySubscriberStableState(report) {
  const failures = [];
  const expectedClientCount = report.fixture?.socket?.clientCount;
  const historyLimit = report.reproducibility?.tmuxHistoryLimit;
  const warmup = report.fixture?.historyWarmup;
  const expectedSocketIds = report.samples[0]?.plateauStableState?.subscribers
    ?.map((subscriber) => subscriber.socketId)
    .sort();
  const fail = (condition, reason) => {
    if (!condition) failures.push(reason);
  };

  fail(
    report.reproducibility?.plateauOutput === 'paused-after-correctness',
    'plateau output was not paused after correctness',
  );
  fail(
    Number.isSafeInteger(expectedClientCount) && expectedClientCount > 0,
    'client count is invalid',
  );
  fail(Number.isSafeInteger(historyLimit) && historyLimit > 0, 'history limit is invalid');
  fail(
    warmup?.criterion === 'history-at-limit-output-paused-and-final-generator-marker-rendered' &&
      report.reproducibility?.tmuxHistoryWarmupCriterion === warmup.criterion,
    'warm-up did not establish the rendered retained-state barrier',
  );
  fail(warmup?.historyLines === historyLimit, 'warm-up history did not reach the configured limit');
  fail(warmup?.historyLimit === historyLimit, 'warm-up history limit does not match the run');

  for (const sample of report.samples) {
    const state = sample.plateauStableState;
    if (!state) {
      failures.push(`sample ${sample.index} has no plateau stable-state evidence`);
      continue;
    }
    const socketIds = state.subscribers.map((subscriber) => subscriber.socketId).sort();
    fail(
      state.subscribers.length === expectedClientCount &&
        new Set(socketIds).size === expectedClientCount &&
        JSON.stringify(socketIds) === JSON.stringify(expectedSocketIds),
      `sample ${sample.index} did not retain the complete subscriber set`,
    );
    fail(
      state.subscribers.every((subscriber) => subscriber.connected),
      `sample ${sample.index} has a disconnected subscriber`,
    );
    fail(
      state.server.connectedClients >= expectedClientCount,
      `sample ${sample.index} reports fewer connected server clients than expected`,
    );
    fail(
      state.server.tmuxHistoryLines === historyLimit &&
        state.server.tmuxHistoryLimit === historyLimit,
      `sample ${sample.index} did not retain the bounded tmux history`,
    );
    fail(
      state.workload.generatorOutputBytes === warmup?.generatorOutputBytes &&
        state.workload.generatorChunks === warmup?.generatorChunks,
      `sample ${sample.index} generator output changed after the stable-state barrier`,
    );
    const expectedChurnCycles =
      sample.phase === 'cache-churn-1'
        ? warmup?.generatorChurnCycles + 1
        : sample.phase === 'cache-churn-2'
          ? warmup?.generatorChurnCycles + 2
          : null;
    fail(
      expectedChurnCycles !== null && state.workload.churnCycles === expectedChurnCycles,
      `sample ${sample.index} has an unexpected memory-only churn cycle`,
    );
  }

  return {
    pass: failures.length === 0,
    criterion: 'all-subscribers-connected-history-at-limit-output-unchanged-memory-churn-only',
    sampleCount: report.samples.length,
    expectedClientCount,
    historyLimit,
    generatorOutputBytes: warmup?.generatorOutputBytes,
    generatorChunks: warmup?.generatorChunks,
    failures,
  };
}

function validateSchemaVersion(report) {
  const version = report?.schemaVersion;
  if (!Number.isInteger(version)) {
    return {
      valid: false,
      reason: `schemaVersion ${version ?? 'missing'} is invalid; expected version ${CURRENT_SCHEMA_VERSION}`,
    };
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    const direction = version < CURRENT_SCHEMA_VERSION ? 'legacy' : 'unsupported';
    return {
      valid: false,
      reason: `${direction} schemaVersion ${version}; expected version ${CURRENT_SCHEMA_VERSION}; use a compatible evaluator or regenerate the artifact`,
    };
  }
  return { valid: true };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addRequirement(errors, condition, path, expectation) {
  if (!condition) errors.push(`${path} ${expectation}`);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateFileEvidence(value, path, errors) {
  addRequirement(errors, isRecord(value), path, 'must be an object');
  if (!isRecord(value)) return;
  addRequirement(
    errors,
    isNonEmptyString(value.path),
    `${path}.path`,
    'must be a non-empty string',
  );
  addRequirement(
    errors,
    /^[a-f0-9]{64}$/.test(value.sha256),
    `${path}.sha256`,
    'must be a SHA-256 digest',
  );
  addRequirement(errors, Number.isFinite(value.sizeBytes), `${path}.sizeBytes`, 'must be finite');
  addRequirement(errors, Number.isFinite(value.mtimeMs), `${path}.mtimeMs`, 'must be finite');
}

function validateProvenance(report, errors) {
  const harness = report?.harness?.provenance;
  addRequirement(errors, isRecord(harness), 'harness.provenance', 'must be an object');
  if (isRecord(harness)) {
    addRequirement(
      errors,
      harness.method === 'git-checkout',
      'harness.provenance.method',
      'must be "git-checkout"',
    );
    addRequirement(
      errors,
      isTimestamp(harness.capturedAt),
      'harness.provenance.capturedAt',
      'must be a valid timestamp',
    );
    addRequirement(
      errors,
      isNonEmptyString(harness.repositoryRoot),
      'harness.provenance.repositoryRoot',
      'must be a non-empty string',
    );
    addRequirement(
      errors,
      /^[a-f0-9]{40}$/.test(harness.commit),
      'harness.provenance.commit',
      'must be a 40-character Git commit',
    );
    addRequirement(
      errors,
      typeof harness.dirty === 'boolean',
      'harness.provenance.dirty',
      'must be boolean',
    );
  }

  const target = report?.target?.provenance;
  addRequirement(errors, isRecord(target), 'target.provenance', 'must be an object');
  if (!isRecord(target)) return;
  addRequirement(
    errors,
    isNonEmptyString(target.method),
    'target.provenance.method',
    'must name a supported method',
  );
  if (!isNonEmptyString(target.method)) return;
  addRequirement(
    errors,
    isTimestamp(target.capturedAt),
    'target.provenance.capturedAt',
    'must be a valid timestamp',
  );
  if (target.method === 'not-requested') return;
  if (target.method !== 'linux-procfs-sha256-v1') {
    errors.push(`target.provenance.method ${JSON.stringify(target.method)} is unsupported`);
    return;
  }

  validateFileEvidence(target.executable, 'target.provenance.executable', errors);
  if (target.entrypoint !== null) {
    validateFileEvidence(target.entrypoint, 'target.provenance.entrypoint', errors);
  }
  const fingerprint = target.buildFingerprint;
  addRequirement(
    errors,
    isRecord(fingerprint),
    'target.provenance.buildFingerprint',
    'must be an object',
  );
  if (isRecord(fingerprint)) {
    addRequirement(
      errors,
      fingerprint.algorithm === 'sha256',
      'target.provenance.buildFingerprint.algorithm',
      'must be "sha256"',
    );
    addRequirement(
      errors,
      /^[a-f0-9]{64}$/.test(fingerprint.digest),
      'target.provenance.buildFingerprint.digest',
      'must be a SHA-256 digest',
    );
    addRequirement(
      errors,
      ['file', 'directory-tree'].includes(fingerprint.subjectKind),
      'target.provenance.buildFingerprint.subjectKind',
      'must be "file" or "directory-tree"',
    );
    addRequirement(
      errors,
      isNonEmptyString(fingerprint.subjectPath),
      'target.provenance.buildFingerprint.subjectPath',
      'must be a non-empty string',
    );
    addRequirement(
      errors,
      isPositiveInteger(fingerprint.fileCount),
      'target.provenance.buildFingerprint.fileCount',
      'must be a positive integer',
    );
    addRequirement(
      errors,
      Number.isFinite(fingerprint.totalBytes),
      'target.provenance.buildFingerprint.totalBytes',
      'must be finite',
    );
  }
}

function validateProcessTree(tree, path, errors) {
  addRequirement(errors, isRecord(tree), path, 'must be an object');
  if (!isRecord(tree)) return;
  addRequirement(
    errors,
    tree.rootPid === null || isPositiveInteger(tree.rootPid),
    `${path}.rootPid`,
    'must be null or a positive integer',
  );
  addRequirement(
    errors,
    Number.isSafeInteger(tree.processCount) && tree.processCount >= 0,
    `${path}.processCount`,
    'must be a non-negative integer',
  );
  addRequirement(errors, Number.isFinite(tree.rssBytes), `${path}.rssBytes`, 'must be finite');
  addRequirement(errors, Number.isFinite(tree.swapBytes), `${path}.swapBytes`, 'must be finite');
  addRequirement(errors, Array.isArray(tree.processes), `${path}.processes`, 'must be an array');
  if (!Array.isArray(tree.processes)) return;
  tree.processes.forEach((processInfo, index) => {
    const processPath = `${path}.processes[${index}]`;
    addRequirement(errors, isRecord(processInfo), processPath, 'must be an object');
    if (isRecord(processInfo)) {
      addRequirement(
        errors,
        isPositiveInteger(processInfo.pid),
        `${processPath}.pid`,
        'must be a positive integer',
      );
    }
  });
}

function validatePidArray(value, path, errors, { nonEmpty = false } = {}) {
  addRequirement(errors, Array.isArray(value), path, 'must be an array');
  if (!Array.isArray(value)) return;
  if (nonEmpty) addRequirement(errors, value.length > 0, path, 'must be non-empty');
  value.forEach((pid, index) =>
    addRequirement(
      errors,
      isPositiveInteger(pid),
      `${path}[${index}]`,
      'must be a positive integer',
    ),
  );
  addRequirement(errors, new Set(value).size === value.length, path, 'must not contain duplicates');
}

function validateSample(sample, index, errors) {
  const path = `samples[${index}]`;
  addRequirement(errors, isRecord(sample), path, 'must be an object');
  if (!isRecord(sample)) return;
  addRequirement(
    errors,
    Number.isSafeInteger(sample.index) && sample.index >= 0,
    `${path}.index`,
    'must be a non-negative integer',
  );
  addRequirement(
    errors,
    isNonEmptyString(sample.phase),
    `${path}.phase`,
    'must be a non-empty string',
  );
  const system = sample.system;
  addRequirement(errors, isRecord(system), `${path}.system`, 'must be an object');
  if (isRecord(system)) {
    addRequirement(
      errors,
      isTimestamp(system.capturedAt),
      `${path}.system.capturedAt`,
      'must be a valid timestamp',
    );
    validateProcessTree(system.target, `${path}.system.target`, errors);
    validateProcessTree(system.workload, `${path}.system.workload`, errors);

    const cgroup = system.cgroup;
    addRequirement(errors, isRecord(cgroup), `${path}.system.cgroup`, 'must be an object');
    if (isRecord(cgroup)) {
      addRequirement(
        errors,
        typeof cgroup.available === 'boolean',
        `${path}.system.cgroup.available`,
        'must be boolean',
      );
      if (cgroup.available) {
        addRequirement(
          errors,
          Number.isFinite(cgroup.currentBytes),
          `${path}.system.cgroup.currentBytes`,
          'must be finite',
        );
        addRequirement(
          errors,
          Number.isFinite(cgroup.swapBytes),
          `${path}.system.cgroup.swapBytes`,
          'must be finite',
        );
      }
    }

    const host = system.host;
    addRequirement(errors, isRecord(host), `${path}.system.host`, 'must be an object');
    if (isRecord(host)) {
      addRequirement(
        errors,
        typeof host.pressureAvailable === 'boolean',
        `${path}.system.host.pressureAvailable`,
        'must be boolean',
      );
      if (host.pressureAvailable) {
        addRequirement(
          errors,
          isRecord(host.pressure),
          `${path}.system.host.pressure`,
          'must be an object',
        );
        addRequirement(
          errors,
          isRecord(host.pressure?.full),
          `${path}.system.host.pressure.full`,
          'must be an object',
        );
        addRequirement(
          errors,
          Number.isFinite(host.pressure?.full?.avg10),
          `${path}.system.host.pressure.full.avg10`,
          'must be finite',
        );
      }
    }

    const sampler = system.sampler;
    addRequirement(errors, isRecord(sampler), `${path}.system.sampler`, 'must be an object');
    if (isRecord(sampler)) {
      addRequirement(
        errors,
        isPositiveInteger(sampler.pid),
        `${path}.system.sampler.pid`,
        'must be a positive integer',
      );
    }
  }

  addRequirement(errors, isRecord(sample.generators), `${path}.generators`, 'must be an object');
  if (isRecord(sample.generators)) {
    validatePidArray(sample.generators.expectedPids, `${path}.generators.expectedPids`, errors, {
      nonEmpty: true,
    });
    validatePidArray(sample.generators.alivePids, `${path}.generators.alivePids`, errors);
  }
}

const THRESHOLD_FIELDS = [
  'minimumSamples',
  'minimumOutputBytesPerSession',
  'minimumForcedGcCyclesPerSession',
  'maximumTargetPeakRssBytes',
  'maximumWorkloadPeakRssBytes',
  'maximumTargetSwapBytes',
  'maximumMemoryPsiFullAvg10',
  'maximumPlateauGrowthBytes',
  'maximumPlateauGrowthRatio',
];

function validateEvaluationEvidence(report, thresholds, errors) {
  addRequirement(errors, Array.isArray(report.samples), 'samples', 'must be an array');
  if (Array.isArray(report.samples)) {
    report.samples.forEach((sample, index) => validateSample(sample, index, errors));
  }

  const sessions = report.workload?.sessions;
  addRequirement(errors, Array.isArray(sessions), 'workload.sessions', 'must be an array');
  if (Array.isArray(sessions)) {
    sessions.forEach((metric, index) => {
      const path = `workload.sessions[${index}]`;
      addRequirement(errors, isRecord(metric), path, 'must be an object');
      if (!isRecord(metric)) return;
      addRequirement(
        errors,
        isNonEmptyString(metric.sessionName),
        `${path}.sessionName`,
        'must be a non-empty string',
      );
      addRequirement(
        errors,
        Number.isFinite(metric.outputBytes),
        `${path}.outputBytes`,
        'must be finite',
      );
      addRequirement(
        errors,
        Number.isFinite(metric.forcedGcCount),
        `${path}.forcedGcCount`,
        'must be finite',
      );
      addRequirement(
        errors,
        isTimestamp(metric.capturedAt),
        `${path}.capturedAt`,
        'must be a valid timestamp',
      );
    });
  }

  addRequirement(errors, isRecord(thresholds), 'thresholds', 'must be an object');
  if (isRecord(thresholds)) {
    for (const field of THRESHOLD_FIELDS) {
      addRequirement(
        errors,
        Number.isFinite(thresholds[field]),
        `thresholds.${field}`,
        'must be finite',
      );
    }
  }

  const checks = report.evaluation?.checks;
  addRequirement(errors, Array.isArray(checks), 'evaluation.checks', 'must be an array');
  if (!Array.isArray(checks)) return;
  const cleanupIndex = checks.findIndex(
    (check) => isRecord(check) && check.id === 'isolated-tmux-cleanup',
  );
  addRequirement(
    errors,
    cleanupIndex >= 0,
    'evaluation.checks[isolated-tmux-cleanup]',
    'must be present',
  );
  if (cleanupIndex < 0) return;
  const cleanup = checks[cleanupIndex].actual;
  const cleanupPath = `evaluation.checks[${cleanupIndex}].actual`;
  addRequirement(errors, isRecord(cleanup), cleanupPath, 'must be an object');
  if (isRecord(cleanup)) {
    addRequirement(
      errors,
      typeof cleanup.attempted === 'boolean',
      `${cleanupPath}.attempted`,
      'must be boolean',
    );
    addRequirement(
      errors,
      typeof cleanup.serverAliveAfterCleanup === 'boolean',
      `${cleanupPath}.serverAliveAfterCleanup`,
      'must be boolean',
    );
  }
}

function expectedFixtureSocketCount(fixture, execution) {
  const executionMinimum = new Set([
    'socket-fixture',
    'socket-xterm-fixture',
    'lifecycle-fixture',
    'reader-fixture',
  ]).has(execution)
    ? 1
    : 0;
  if (isNonNegativeInteger(fixture?.socket?.clientCount)) {
    return Math.max(executionMinimum, fixture.socket.clientCount);
  }
  const evidenceMinimum = [
    fixture?.socket?.connected,
    fixture?.socket?.handshakeTokenPresented,
    fixture?.socket?.subscribed,
    fixture?.socket?.seedObserved,
  ].some((value) => value === true)
    ? 1
    : 0;
  return Math.max(executionMinimum, evidenceMinimum);
}

function validateFixtureCleanup(cleanup, path, errors, expectedSocketCount) {
  addRequirement(errors, isRecord(cleanup), path, 'must be an object');
  if (!isRecord(cleanup)) return;
  for (const field of [
    'attempted',
    'socketDisconnected',
    'processAliveAfterCleanup',
    'tmuxServerAliveAfterCleanup',
    'storageCreated',
    'storageExistsAfterCleanup',
    'tempRootExistsAfterCleanup',
    'processesGone',
  ]) {
    addRequirement(
      errors,
      typeof cleanup[field] === 'boolean',
      `${path}.${field}`,
      'must be boolean',
    );
  }
  const socketObservation = cleanup.socketObservation;
  const socketPath = `${path}.socketObservation`;
  addRequirement(errors, isRecord(socketObservation), socketPath, 'must be an object');
  if (isRecord(socketObservation)) {
    for (const field of ['observedCount', 'disconnectedCount', 'disconnectErrorCount']) {
      addRequirement(
        errors,
        isNonNegativeInteger(socketObservation[field]),
        `${socketPath}.${field}`,
        'must be a non-negative integer',
      );
    }
    addRequirement(
      errors,
      typeof socketObservation.timedOut === 'boolean',
      `${socketPath}.timedOut`,
      'must be boolean',
    );
    addRequirement(
      errors,
      isPositiveInteger(socketObservation.waitTimeoutMs),
      `${socketPath}.waitTimeoutMs`,
      'must be a positive integer',
    );
    addRequirement(
      errors,
      Array.isArray(socketObservation.outcomes),
      `${socketPath}.outcomes`,
      'must be an array',
    );
    if (Array.isArray(socketObservation.outcomes)) {
      socketObservation.outcomes.forEach((outcome, index) => {
        const outcomePath = `${socketPath}.outcomes[${index}]`;
        addRequirement(errors, isRecord(outcome), outcomePath, 'must be an object');
        if (!isRecord(outcome)) return;
        addRequirement(
          errors,
          isNonNegativeInteger(outcome.index),
          `${outcomePath}.index`,
          'must be a non-negative integer',
        );
        addRequirement(
          errors,
          outcome.socketId === null || isNonEmptyString(outcome.socketId),
          `${outcomePath}.socketId`,
          'must be null or a non-empty string',
        );
        for (const field of [
          'connectedBeforeDisconnect',
          'disconnectAttempted',
          'connectedAfterWait',
          'disconnected',
        ]) {
          addRequirement(
            errors,
            typeof outcome[field] === 'boolean',
            `${outcomePath}.${field}`,
            'must be boolean',
          );
        }
        addRequirement(
          errors,
          outcome.disconnectError === null || isNonEmptyString(outcome.disconnectError),
          `${outcomePath}.disconnectError`,
          'must be null or a non-empty string',
        );
        addRequirement(
          errors,
          outcome.disconnected === !outcome.connectedAfterWait,
          `${outcomePath}.disconnected`,
          'must be the inverse of connectedAfterWait',
        );
      });
      addRequirement(
        errors,
        socketObservation.observedCount === socketObservation.outcomes.length,
        `${socketPath}.observedCount`,
        'must equal outcomes.length',
      );
      addRequirement(
        errors,
        socketObservation.disconnectedCount ===
          socketObservation.outcomes.filter((outcome) => outcome?.disconnected === true).length,
        `${socketPath}.disconnectedCount`,
        'must equal the number of disconnected outcomes',
      );
      addRequirement(
        errors,
        socketObservation.disconnectErrorCount ===
          socketObservation.outcomes.filter((outcome) => outcome?.disconnectError != null).length,
        `${socketPath}.disconnectErrorCount`,
        'must equal the number of disconnect errors',
      );
    }
    addRequirement(
      errors,
      isNonNegativeInteger(expectedSocketCount) &&
        isNonNegativeInteger(socketObservation.observedCount) &&
        socketObservation.observedCount >= expectedSocketCount,
      `${socketPath}.observedCount`,
      `must observe at least ${expectedSocketCount} expected fixture socket(s)`,
    );
    const successfulSocketCleanup =
      isNonNegativeInteger(socketObservation.observedCount) &&
      isNonNegativeInteger(socketObservation.disconnectedCount) &&
      isNonNegativeInteger(socketObservation.disconnectErrorCount) &&
      Array.isArray(socketObservation.outcomes) &&
      socketObservation.observedCount >= expectedSocketCount &&
      socketObservation.disconnectedCount === socketObservation.observedCount &&
      socketObservation.disconnectErrorCount === 0 &&
      socketObservation.timedOut === false &&
      socketObservation.outcomes.every(
        (outcome) => outcome?.disconnectAttempted === true && outcome.disconnected === true,
      );
    addRequirement(
      errors,
      cleanup.socketDisconnected === successfulSocketCleanup,
      `${path}.socketDisconnected`,
      'must equal the observed socket cleanup outcome',
    );
  }
  validatePidArray(cleanup.alivePidsAfterCleanup, `${path}.alivePidsAfterCleanup`, errors);
  addRequirement(
    errors,
    Array.isArray(cleanup.residuePaths),
    `${path}.residuePaths`,
    'must be an array',
  );
  if (Array.isArray(cleanup.residuePaths)) {
    cleanup.residuePaths.forEach((entry, index) =>
      addRequirement(
        errors,
        isNonEmptyString(entry),
        `${path}.residuePaths[${index}]`,
        'must be a non-empty string',
      ),
    );
  }
  addRequirement(
    errors,
    cleanup.removalError === null || isNonEmptyString(cleanup.removalError),
    `${path}.removalError`,
    'must be null or a non-empty string',
  );
}

const BACKPRESSURE_THRESHOLD_FIELDS = [
  'minimumBackpressureSamples',
  'maximumStalledSocketQueueBytes',
  'maximumStalledEngineBufferedPackets',
  'maximumCurrentSocketQueueBytes',
  'maximumCurrentEngineBufferedPackets',
  'maximumCurrentDeliveryLatencyMs',
];

const SOCKET_OBSERVATION_NUMBER_FIELDS = [
  'queuedBytes',
  'inFlightBytes',
  'engineBufferedPackets',
  'droppedFrames',
  'droppedBytes',
];

function validateBackpressureEvidence(backpressure, thresholds, errors) {
  addRequirement(errors, isRecord(backpressure), 'backpressure', 'must be an object');
  if (!isRecord(backpressure)) return;
  for (const field of BACKPRESSURE_THRESHOLD_FIELDS) {
    addRequirement(
      errors,
      Number.isFinite(thresholds?.[field]),
      `thresholds.${field}`,
      'must be finite',
    );
  }

  const activation = backpressure.stallActivation;
  addRequirement(errors, isRecord(activation), 'backpressure.stallActivation', 'must be an object');
  if (isRecord(activation)) {
    addRequirement(
      errors,
      isNonEmptyString(activation.socketId),
      'backpressure.stallActivation.socketId',
      'must be non-empty',
    );
    addRequirement(
      errors,
      isTimestamp(activation.activatedAt),
      'backpressure.stallActivation.activatedAt',
      'must be a valid timestamp',
    );
  }

  addRequirement(
    errors,
    Array.isArray(backpressure.observations) && backpressure.observations.length > 0,
    'backpressure.observations',
    'must be a non-empty array',
  );
  if (Array.isArray(backpressure.observations)) {
    backpressure.observations.forEach((observation, index) => {
      const path = `backpressure.observations[${index}]`;
      addRequirement(errors, isRecord(observation), path, 'must be an object');
      if (!isRecord(observation)) return;
      addRequirement(
        errors,
        Number.isFinite(observation.elapsedMs) && observation.elapsedMs >= 0,
        `${path}.elapsedMs`,
        'must be a non-negative finite number',
      );
      addRequirement(
        errors,
        Number.isSafeInteger(observation.currentFramesReceived) &&
          observation.currentFramesReceived >= 0,
        `${path}.currentFramesReceived`,
        'must be a non-negative integer',
      );
      for (const role of ['stalled', 'current']) {
        const snapshot = observation[role];
        const snapshotPath = `${path}.${role}`;
        addRequirement(errors, isRecord(snapshot), snapshotPath, 'must be an object');
        if (!isRecord(snapshot)) continue;
        addRequirement(
          errors,
          isNonEmptyString(snapshot.socketId),
          `${snapshotPath}.socketId`,
          'must be non-empty',
        );
        for (const field of ['connected', 'registered', 'desynchronized']) {
          addRequirement(
            errors,
            typeof snapshot[field] === 'boolean',
            `${snapshotPath}.${field}`,
            'must be boolean',
          );
        }
        for (const field of SOCKET_OBSERVATION_NUMBER_FIELDS) {
          addRequirement(
            errors,
            Number.isFinite(snapshot[field]) && snapshot[field] >= 0,
            `${snapshotPath}.${field}`,
            'must be a non-negative finite number',
          );
        }
      }
    });
  }

  for (const role of ['stalled', 'current']) {
    const summary = backpressure[role];
    const path = `backpressure.${role}`;
    addRequirement(errors, isRecord(summary), path, 'must be an object');
    if (!isRecord(summary)) continue;
    addRequirement(
      errors,
      isNonEmptyString(summary.socketId),
      `${path}.socketId`,
      'must be non-empty',
    );
    for (const field of [
      'maximumQueuedBytes',
      'maximumInFlightBytes',
      'maximumEngineBufferedPackets',
    ]) {
      addRequirement(
        errors,
        Number.isFinite(summary[field]) && summary[field] >= 0,
        `${path}.${field}`,
        'must be a non-negative finite number',
      );
    }
  }
  if (isRecord(backpressure.stalled)) {
    for (const field of ['queueGrowthObserved', 'desynchronized', 'disconnectedByPolicy']) {
      addRequirement(
        errors,
        typeof backpressure.stalled[field] === 'boolean',
        `backpressure.stalled.${field}`,
        'must be boolean',
      );
    }
    addRequirement(
      errors,
      Number.isFinite(backpressure.stalled.droppedFrames) &&
        backpressure.stalled.droppedFrames >= 0,
      'backpressure.stalled.droppedFrames',
      'must be a non-negative finite number',
    );
  }
  if (isRecord(backpressure.current)) {
    addRequirement(
      errors,
      Number.isFinite(backpressure.current.deliveryLatencyMs) &&
        backpressure.current.deliveryLatencyMs >= 0,
      'backpressure.current.deliveryLatencyMs',
      'must be a non-negative finite number',
    );
    addRequirement(
      errors,
      Number.isSafeInteger(backpressure.current.framesReceived) &&
        backpressure.current.framesReceived >= 0,
      'backpressure.current.framesReceived',
      'must be a non-negative integer',
    );
  }

  const observations = Array.isArray(backpressure.observations)
    ? backpressure.observations.filter(isRecord)
    : [];
  if (observations.length > 0 && isRecord(backpressure.stalled) && isRecord(backpressure.current)) {
    addRequirement(
      errors,
      activation?.socketId === backpressure.stalled.socketId,
      'backpressure.stallActivation.socketId',
      'must match backpressure.stalled.socketId',
    );
    addRequirement(
      errors,
      backpressure.stalled.socketId !== backpressure.current.socketId,
      'backpressure.current.socketId',
      'must identify a distinct socket',
    );
    for (const role of ['stalled', 'current']) {
      addRequirement(
        errors,
        observations.every(
          (observation) => observation[role]?.socketId === backpressure[role].socketId,
        ),
        `backpressure.observations[*].${role}.socketId`,
        `must match backpressure.${role}.socketId`,
      );
      for (const [summaryField, observationField] of [
        ['maximumQueuedBytes', 'queuedBytes'],
        ['maximumInFlightBytes', 'inFlightBytes'],
        ['maximumEngineBufferedPackets', 'engineBufferedPackets'],
      ]) {
        const observedMaximum = maximum(
          observations.map((observation) => observation[role]?.[observationField] ?? 0),
        );
        addRequirement(
          errors,
          backpressure[role][summaryField] === observedMaximum,
          `backpressure.${role}.${summaryField}`,
          `must equal the observation maximum ${observedMaximum}`,
        );
      }
    }
    const maximumDroppedFrames = maximum(
      observations.map((observation) => observation.stalled?.droppedFrames ?? 0),
    );
    addRequirement(
      errors,
      backpressure.stalled.droppedFrames === maximumDroppedFrames,
      'backpressure.stalled.droppedFrames',
      `must equal the observation maximum ${maximumDroppedFrames}`,
    );
    addRequirement(
      errors,
      backpressure.stalled.queueGrowthObserved ===
        observations.some((observation) => observation.stalled?.queuedBytes > 0),
      'backpressure.stalled.queueGrowthObserved',
      'must match the observations',
    );
    addRequirement(
      errors,
      backpressure.stalled.desynchronized ===
        observations.some((observation) => observation.stalled?.desynchronized === true),
      'backpressure.stalled.desynchronized',
      'must match the observations',
    );
    const finalStalledObservation = observations.at(-1)?.stalled;
    addRequirement(
      errors,
      backpressure.stalled.disconnectedByPolicy ===
        Boolean(finalStalledObservation && !finalStalledObservation.registered),
      'backpressure.stalled.disconnectedByPolicy',
      'must match the final queue registration state',
    );
    addRequirement(
      errors,
      backpressure.current.framesReceived >=
        maximum(observations.map((observation) => observation.currentFramesReceived ?? 0)),
      'backpressure.current.framesReceived',
      'must cover the observed frame count',
    );
  }
}

function validateTerminalComparison(comparison, path, errors) {
  addRequirement(errors, isRecord(comparison), path, 'must be an object');
  if (!isRecord(comparison)) return;
  for (const field of ['actualSha256', 'expectedSha256']) {
    addRequirement(
      errors,
      /^[a-f0-9]{64}$/.test(comparison[field]),
      `${path}.${field}`,
      'must be a SHA-256 digest',
    );
  }
  for (const field of [
    'actualBytes',
    'expectedBytes',
    'unmatchedActualNonWhitespaceBytes',
    'unmatchedExpectedNonWhitespaceBytes',
  ]) {
    addRequirement(
      errors,
      isNonNegativeInteger(comparison[field]),
      `${path}.${field}`,
      'must be a non-negative integer',
    );
  }
  addRequirement(
    errors,
    Number.isSafeInteger(comparison.firstDifference) && comparison.firstDifference >= -1,
    `${path}.firstDifference`,
    'must be an integer greater than or equal to -1',
  );
  for (const field of ['actualCodePoint', 'expectedCodePoint']) {
    addRequirement(
      errors,
      comparison[field] === null || isNonNegativeInteger(comparison[field]),
      `${path}.${field}`,
      'must be null or a non-negative integer',
    );
  }
  for (const field of ['actualContext', 'expectedContext']) {
    addRequirement(
      errors,
      typeof comparison[field] === 'string',
      `${path}.${field}`,
      'must be a string',
    );
  }
  for (const side of ['actual', 'expected']) {
    const markers = comparison[`${side}Markers`];
    const markerPath = `${path}.${side}Markers`;
    addRequirement(errors, isRecord(markers), markerPath, 'must be an object');
    if (!isRecord(markers)) continue;
    addRequirement(
      errors,
      isNonNegativeInteger(markers.count),
      `${markerPath}.count`,
      'must be a non-negative integer',
    );
    for (const field of ['first', 'last']) {
      addRequirement(
        errors,
        markers[field] === null || isNonNegativeInteger(markers[field]),
        `${markerPath}.${field}`,
        'must be null or a non-negative integer',
      );
    }
  }
}

function validateTerminalEquivalence(equivalence, errors) {
  addRequirement(errors, isRecord(equivalence), 'terminalEquivalence', 'must be an object');
  if (!isRecord(equivalence)) return;
  const dimensions = equivalence.dimensions;
  addRequirement(
    errors,
    isRecord(dimensions),
    'terminalEquivalence.dimensions',
    'must be an object',
  );
  if (isRecord(dimensions)) {
    for (const field of ['cols', 'rows']) {
      addRequirement(
        errors,
        isPositiveInteger(dimensions[field]),
        `terminalEquivalence.dimensions.${field}`,
        'must be a positive integer',
      );
    }
  }
  validateTerminalComparison(equivalence.text, 'terminalEquivalence.text', errors);
  validateTerminalComparison(
    equivalence.captureRendering,
    'terminalEquivalence.captureRendering',
    errors,
  );

  const style = equivalence.style;
  addRequirement(errors, isRecord(style), 'terminalEquivalence.style', 'must be an object');
  if (isRecord(style)) {
    for (const field of ['socketSha256', 'freshCaptureSha256']) {
      addRequirement(
        errors,
        /^[a-f0-9]{64}$/.test(style[field]),
        `terminalEquivalence.style.${field}`,
        'must be a SHA-256 digest',
      );
    }
    addRequirement(
      errors,
      typeof style.byteIdentical === 'boolean',
      'terminalEquivalence.style.byteIdentical',
      'must be boolean',
    );
    for (const field of ['socketCellCount', 'freshCaptureCellCount']) {
      addRequirement(
        errors,
        isNonNegativeInteger(style[field]),
        `terminalEquivalence.style.${field}`,
        'must be a non-negative integer',
      );
    }
    addRequirement(
      errors,
      Number.isSafeInteger(style.firstDifference) && style.firstDifference >= -1,
      'terminalEquivalence.style.firstDifference',
      'must be an integer greater than or equal to -1',
    );
    for (const field of ['socketContext', 'freshCaptureContext']) {
      addRequirement(
        errors,
        Array.isArray(style[field]),
        `terminalEquivalence.style.${field}`,
        'must be an array',
      );
    }
  }
  addRequirement(
    errors,
    isPositiveInteger(equivalence.socketSeedResets),
    'terminalEquivalence.socketSeedResets',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    isNonEmptyString(equivalence.textNormalization),
    'terminalEquivalence.textNormalization',
    'must be a non-empty string',
  );
}

function validateReaderCacheSnapshot(snapshot, path, errors) {
  addRequirement(errors, isRecord(snapshot), path, 'must be an object');
  if (!isRecord(snapshot)) return;
  addRequirement(errors, isTimestamp(snapshot.capturedAt), `${path}.capturedAt`, 'must be valid');
  for (const name of ['parsed', 'chunks', 'dto', 'aggregate']) {
    const cache = snapshot[name];
    const cachePath = `${path}.${name}`;
    addRequirement(errors, isRecord(cache), cachePath, 'must be an object');
    if (!isRecord(cache)) continue;
    for (const field of ['entries', 'bytesEstimated', 'hits', 'misses']) {
      addRequirement(
        errors,
        isNonNegativeInteger(cache[field]),
        `${cachePath}.${field}`,
        'must be a non-negative integer',
      );
    }
    addRequirement(
      errors,
      Number.isFinite(cache.hitRate) && cache.hitRate >= 0 && cache.hitRate <= 1,
      `${cachePath}.hitRate`,
      'must be finite between zero and one',
    );
  }
  const aggregate = snapshot.aggregate;
  if (!isRecord(aggregate)) return;
  for (const field of ['providersFailed', 'budgetUsedBytes', 'budgetBytes', 'evictions']) {
    addRequirement(
      errors,
      isNonNegativeInteger(aggregate[field]),
      `${path}.aggregate.${field}`,
      'must be a non-negative integer',
    );
  }
}

function validateReaderEvidence(reader, errors) {
  addRequirement(errors, isRecord(reader), 'fixture.reader', 'must be an object');
  if (!isRecord(reader)) return;
  addRequirement(
    errors,
    isPositiveInteger(reader.cacheBudgetBytes),
    'fixture.reader.cacheBudgetBytes',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    isPositiveInteger(reader.metricsSnapshotTtlMs),
    'fixture.reader.metricsSnapshotTtlMs',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    Number.isFinite(reader.sampleWindowMs) && reader.sampleWindowMs > reader.metricsSnapshotTtlMs,
    'fixture.reader.sampleWindowMs',
    'must exceed metricsSnapshotTtlMs',
  );
  addRequirement(
    errors,
    Array.isArray(reader.transcripts) && reader.transcripts.length >= 3,
    'fixture.reader.transcripts',
    'must contain at least three sessions',
  );
  if (Array.isArray(reader.transcripts)) {
    reader.transcripts.forEach((transcript, index) => {
      const transcriptPath = `fixture.reader.transcripts[${index}]`;
      addRequirement(errors, isRecord(transcript), transcriptPath, 'must be an object');
      if (!isRecord(transcript)) return;
      for (const field of [
        'sessionIndex',
        'generation',
        'messageCount',
        'chunkCount',
        'sizeBytes',
      ]) {
        addRequirement(
          errors,
          isNonNegativeInteger(transcript[field]),
          `${transcriptPath}.${field}`,
          'must be a non-negative integer',
        );
      }
      for (const field of ['sessionId', 'marker']) {
        addRequirement(
          errors,
          isNonEmptyString(transcript[field]),
          `${transcriptPath}.${field}`,
          'must be non-empty',
        );
      }
    });
  }
  addRequirement(
    errors,
    Array.isArray(reader.rounds) && reader.rounds.length > 0,
    'fixture.reader.rounds',
    'must be a non-empty array',
  );
  if (Array.isArray(reader.rounds)) {
    reader.rounds.forEach((round, index) => {
      const roundPath = `fixture.reader.rounds[${index}]`;
      addRequirement(errors, isRecord(round), roundPath, 'must be an object');
      if (!isRecord(round)) return;
      addRequirement(
        errors,
        typeof round.consistent === 'boolean',
        `${roundPath}.consistent`,
        'must be boolean',
      );
      for (const field of ['expectedMarker', 'phase']) {
        addRequirement(
          errors,
          isNonEmptyString(round[field]),
          `${roundPath}.${field}`,
          'must be non-empty',
        );
      }
    });
  }
  addRequirement(
    errors,
    isRecord(reader.cacheSnapshots),
    'fixture.reader.cacheSnapshots',
    'must be an object',
  );
  if (isRecord(reader.cacheSnapshots)) {
    validateReaderCacheSnapshot(
      reader.cacheSnapshots.initial,
      'fixture.reader.cacheSnapshots.initial',
      errors,
    );
    validateReaderCacheSnapshot(
      reader.cacheSnapshots.final,
      'fixture.reader.cacheSnapshots.final',
      errors,
    );
  }
}

function validateStringArray(value, path, errors) {
  addRequirement(errors, Array.isArray(value), path, 'must be an array');
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) =>
    addRequirement(errors, isNonEmptyString(entry), `${path}[${index}]`, 'must be non-empty'),
  );
  addRequirement(errors, new Set(value).size === value.length, path, 'must contain unique values');
}

function validateProviderDifferenceList(value, path, errors) {
  addRequirement(errors, Array.isArray(value), path, 'must be an array');
  if (!Array.isArray(value)) return;
  value.forEach((difference, index) => {
    const differencePath = `${path}[${index}]`;
    addRequirement(errors, isRecord(difference), differencePath, 'must be an object');
    if (!isRecord(difference)) return;
    addRequirement(
      errors,
      isNonEmptyString(difference.field),
      `${differencePath}.field`,
      'must be non-empty',
    );
  });
}

function validateProviderEvidence(providers, samples, errors) {
  addRequirement(errors, isRecord(providers), 'fixture.providers', 'must be an object');
  if (!isRecord(providers)) return;
  addRequirement(
    errors,
    providers.registrySource === 'SessionReaderAdapterFactory.getSupportedProviders',
    'fixture.providers.registrySource',
    'must identify the runtime adapter registry',
  );
  for (const field of [
    'registryProviders',
    'availableFixtureProviders',
    'loadedProviders',
    'missingProviders',
  ]) {
    validateStringArray(providers[field], `fixture.providers.${field}`, errors);
  }
  addRequirement(
    errors,
    Number.isFinite(providers.coverageRatio) &&
      providers.coverageRatio >= 0 &&
      providers.coverageRatio <= 1,
    'fixture.providers.coverageRatio',
    'must be finite between zero and one',
  );
  if (Array.isArray(providers.registryProviders) && Array.isArray(providers.loadedProviders)) {
    const expectedCoverage =
      providers.registryProviders.length === 0
        ? 0
        : providers.loadedProviders.length / providers.registryProviders.length;
    addRequirement(
      errors,
      providers.coverageRatio === expectedCoverage,
      'fixture.providers.coverageRatio',
      `must equal loaded/registered (${expectedCoverage})`,
    );
  }
  addRequirement(
    errors,
    Array.isArray(providers.loadErrors),
    'fixture.providers.loadErrors',
    'must be an array',
  );
  addRequirement(
    errors,
    Array.isArray(providers.results) && providers.results.length > 0,
    'fixture.providers.results',
    'must be a non-empty array',
  );
  if (!Array.isArray(providers.results)) return;
  providers.results.forEach((result, index) => {
    const resultPath = `fixture.providers.results[${index}]`;
    addRequirement(errors, isRecord(result), resultPath, 'must be an object');
    if (!isRecord(result)) return;
    for (const field of ['providerName', 'sessionId']) {
      addRequirement(
        errors,
        isNonEmptyString(result[field]),
        `${resultPath}.${field}`,
        'must be non-empty',
      );
    }
    for (const field of ['exactFields', 'approximateFields', 'unclassifiedFields']) {
      validateStringArray(result[field], `${resultPath}.${field}`, errors);
    }
    validateProviderDifferenceList(result.exactMismatches, `${resultPath}.exactMismatches`, errors);
    validateProviderDifferenceList(
      result.toleratedDifferences,
      `${resultPath}.toleratedDifferences`,
      errors,
    );
    addRequirement(
      errors,
      typeof result.metricsEqual === 'boolean',
      `${resultPath}.metricsEqual`,
      'must be boolean',
    );
    addRequirement(
      errors,
      isRecord(result.summaryMetrics) || result.summaryMetrics === null,
      `${resultPath}.summaryMetrics`,
      'must be an object or null',
    );
    addRequirement(
      errors,
      isRecord(result.fullMetrics) || result.fullMetrics === null,
      `${resultPath}.fullMetrics`,
      'must be an object or null',
    );
    addRequirement(
      errors,
      result.error === null || isNonEmptyString(result.error),
      `${resultPath}.error`,
      'must be null or non-empty',
    );
    addRequirement(
      errors,
      Array.isArray(result.sampleIndexes) && result.sampleIndexes.length > 0,
      `${resultPath}.sampleIndexes`,
      'must be a non-empty array',
    );
    if (Array.isArray(result.sampleIndexes)) {
      result.sampleIndexes.forEach((sampleIndex, sampleOffset) =>
        addRequirement(
          errors,
          isNonNegativeInteger(sampleIndex),
          `${resultPath}.sampleIndexes[${sampleOffset}]`,
          'must be a non-negative integer',
        ),
      );
      const providerSamples = result.sampleIndexes
        .map((sampleIndex) => samples?.[sampleIndex])
        .filter(Boolean);
      addRequirement(
        errors,
        providerSamples.length === result.sampleIndexes.length &&
          providerSamples.every(
            (sample) => sample.providerRead?.providerName === result.providerName,
          ),
        `${resultPath}.sampleIndexes`,
        'must point to samples for the same provider',
      );
      for (const operation of ['summary', 'full']) {
        addRequirement(
          errors,
          providerSamples.some((sample) => sample.providerRead?.operation === operation),
          `${resultPath}.sampleIndexes`,
          `must include a ${operation} read sample`,
        );
      }
    }
    if (result.metricsEqual === true) {
      addRequirement(
        errors,
        Array.isArray(result.exactMismatches) && result.exactMismatches.length === 0,
        `${resultPath}.exactMismatches`,
        'must be empty when metricsEqual is true',
      );
      addRequirement(
        errors,
        Array.isArray(result.unclassifiedFields) && result.unclassifiedFields.length === 0,
        `${resultPath}.unclassifiedFields`,
        'must be empty when metricsEqual is true',
      );
    }
  });
}

function validateManySubscriberPlateauEvidence(report, errors) {
  const fixture = report.fixture;
  addRequirement(
    errors,
    report.reproducibility?.plateauOutput === 'paused-after-correctness',
    'reproducibility.plateauOutput',
    'must be "paused-after-correctness"',
  );
  addRequirement(
    errors,
    isPositiveInteger(report.reproducibility?.tmuxHistoryLimit),
    'reproducibility.tmuxHistoryLimit',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    isNonEmptyString(report.reproducibility?.tmuxHistoryWarmupCriterion),
    'reproducibility.tmuxHistoryWarmupCriterion',
    'must be non-empty',
  );
  addRequirement(
    errors,
    isPositiveInteger(fixture?.socket?.clientCount),
    'fixture.socket.clientCount',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    isPositiveInteger(fixture?.scratchSession?.generatorPid),
    'fixture.scratchSession.generatorPid',
    'must be a positive integer',
  );

  const warmup = fixture?.historyWarmup;
  addRequirement(errors, isRecord(warmup), 'fixture.historyWarmup', 'must be an object');
  if (isRecord(warmup)) {
    addRequirement(
      errors,
      isNonEmptyString(warmup.criterion),
      'fixture.historyWarmup.criterion',
      'must be non-empty',
    );
    for (const field of [
      'historyLines',
      'historyLimit',
      'generatorChunks',
      'generatorOutputBytes',
      'generatorChurnCycles',
    ]) {
      addRequirement(
        errors,
        isNonNegativeInteger(warmup[field]),
        `fixture.historyWarmup.${field}`,
        'must be a non-negative integer',
      );
    }
  }

  if (!Array.isArray(report.samples)) return;
  report.samples.forEach((sample, index) => {
    const path = `samples[${index}].plateauStableState`;
    const state = sample?.plateauStableState;
    addRequirement(errors, isRecord(state), path, 'must be an object');
    if (!isRecord(state)) return;
    addRequirement(
      errors,
      Array.isArray(state.subscribers) && state.subscribers.length > 0,
      `${path}.subscribers`,
      'must be a non-empty array',
    );
    if (Array.isArray(state.subscribers)) {
      state.subscribers.forEach((subscriber, subscriberIndex) => {
        const subscriberPath = `${path}.subscribers[${subscriberIndex}]`;
        addRequirement(errors, isRecord(subscriber), subscriberPath, 'must be an object');
        if (!isRecord(subscriber)) return;
        addRequirement(
          errors,
          isNonEmptyString(subscriber.socketId),
          `${subscriberPath}.socketId`,
          'must be non-empty',
        );
        addRequirement(
          errors,
          typeof subscriber.connected === 'boolean',
          `${subscriberPath}.connected`,
          'must be boolean',
        );
      });
    }
    addRequirement(errors, isRecord(state.server), `${path}.server`, 'must be an object');
    if (isRecord(state.server)) {
      for (const field of ['connectedClients', 'tmuxHistoryLines', 'tmuxHistoryLimit']) {
        addRequirement(
          errors,
          isNonNegativeInteger(state.server[field]),
          `${path}.server.${field}`,
          'must be a non-negative integer',
        );
      }
    }
    addRequirement(errors, isRecord(state.workload), `${path}.workload`, 'must be an object');
    if (isRecord(state.workload)) {
      for (const field of ['generatorOutputBytes', 'generatorChunks', 'churnCycles']) {
        addRequirement(
          errors,
          isNonNegativeInteger(state.workload[field]),
          `${path}.workload.${field}`,
          'must be a non-negative integer',
        );
      }
    }
  });
}

function validateFixtureEvidence(report, thresholds, errors) {
  addRequirement(errors, isRecord(report.scenario), 'scenario', 'must be an object');
  if (isRecord(report.scenario)) {
    addRequirement(
      errors,
      isNonEmptyString(report.scenario.id),
      'scenario.id',
      'must be a non-empty string',
    );
    addRequirement(
      errors,
      isNonEmptyString(report.scenario.execution),
      'scenario.execution',
      'must be a non-empty string',
    );
  }
  addRequirement(
    errors,
    isPositiveInteger(report.target?.pid),
    'target.pid',
    'must be a positive integer',
  );
  addRequirement(
    errors,
    report.target?.provenance?.method !== 'not-requested',
    'target.provenance.method',
    'must bind the spawned application build',
  );

  addRequirement(errors, Array.isArray(report.samples), 'samples', 'must be an array');
  if (Array.isArray(report.samples)) {
    report.samples.forEach((sample, index) => validateSample(sample, index, errors));
  }
  addRequirement(errors, isRecord(thresholds), 'thresholds', 'must be an object');
  if (isRecord(thresholds)) {
    addRequirement(
      errors,
      Number.isFinite(thresholds.minimumSamples),
      'thresholds.minimumSamples',
      'must be finite',
    );
    const hasPlateauThreshold =
      thresholds.maximumPlateauGrowthBytes !== undefined ||
      thresholds.maximumPlateauGrowthRatio !== undefined;
    if (hasPlateauThreshold) {
      for (const field of ['maximumPlateauGrowthBytes', 'maximumPlateauGrowthRatio']) {
        addRequirement(
          errors,
          Number.isFinite(thresholds[field]),
          `thresholds.${field}`,
          'must be finite',
        );
      }
    }
  }

  if (report.correctness !== undefined) {
    addRequirement(errors, isRecord(report.correctness), 'correctness', 'must be an object');
    if (isRecord(report.correctness)) {
      addRequirement(
        errors,
        typeof report.correctness.pass === 'boolean',
        'correctness.pass',
        'must be boolean',
      );
      addRequirement(
        errors,
        Array.isArray(report.correctness.checks) && report.correctness.checks.length > 0,
        'correctness.checks',
        'must be a non-empty array',
      );
      if (Array.isArray(report.correctness.checks)) {
        report.correctness.checks.forEach((check, index) => {
          const path = `correctness.checks[${index}]`;
          addRequirement(errors, isRecord(check), path, 'must be an object');
          if (!isRecord(check)) return;
          addRequirement(errors, isNonEmptyString(check.id), `${path}.id`, 'must be non-empty');
          addRequirement(errors, 'actual' in check, `${path}.actual`, 'must be present');
          addRequirement(errors, 'expected' in check, `${path}.expected`, 'must be present');
          addRequirement(
            errors,
            typeof check.pass === 'boolean',
            `${path}.pass`,
            'must be boolean',
          );
        });
        addRequirement(
          errors,
          report.correctness.pass ===
            report.correctness.checks.every((check) => isRecord(check) && check.pass === true),
          'correctness.pass',
          'must equal the conjunction of correctness.checks[*].pass',
        );
      }
    }
  }
  if (report.backpressure !== undefined) {
    validateBackpressureEvidence(report.backpressure, thresholds, errors);
  }
  const requiresTerminalEquivalence = report.scenario?.execution === 'socket-xterm-fixture';
  if (requiresTerminalEquivalence) {
    addRequirement(
      errors,
      report.reproducibility?.terminalConsumer === '@xterm/headless@6.0.0',
      'reproducibility.terminalConsumer',
      'must be "@xterm/headless@6.0.0"',
    );
    addRequirement(
      errors,
      report.terminalEquivalence !== undefined,
      'terminalEquivalence',
      'must be present for socket-xterm-fixture scenarios',
    );
  }
  if (report.terminalEquivalence !== undefined) {
    validateTerminalEquivalence(report.terminalEquivalence, errors);
  }

  const fixture = report.fixture;
  addRequirement(errors, isRecord(fixture), 'fixture', 'must be an object');
  if (!isRecord(fixture)) return;
  addRequirement(errors, isRecord(fixture.app), 'fixture.app', 'must be an object');
  if (isRecord(fixture.app)) {
    addRequirement(
      errors,
      typeof fixture.app.ready === 'boolean',
      'fixture.app.ready',
      'must be boolean',
    );
    addRequirement(
      errors,
      isPositiveInteger(fixture.app.pid),
      'fixture.app.pid',
      'must be a positive integer',
    );
    addRequirement(
      errors,
      isPositiveInteger(fixture.app.port),
      'fixture.app.port',
      'must be a positive integer',
    );
  }

  addRequirement(errors, isRecord(fixture.socket), 'fixture.socket', 'must be an object');
  if (isRecord(fixture.socket)) {
    for (const field of [
      'connected',
      'runtimeTokenVerified',
      'handshakeTokenPresented',
      'subscribed',
      'seedObserved',
    ]) {
      addRequirement(
        errors,
        typeof fixture.socket[field] === 'boolean',
        `fixture.socket.${field}`,
        'must be boolean',
      );
    }
    addRequirement(
      errors,
      Array.isArray(fixture.socket.receivedTypes),
      'fixture.socket.receivedTypes',
      'must be an array',
    );
    if (Array.isArray(fixture.socket.receivedTypes)) {
      fixture.socket.receivedTypes.forEach((entry, index) =>
        addRequirement(
          errors,
          isNonEmptyString(entry),
          `fixture.socket.receivedTypes[${index}]`,
          'must be a non-empty string',
        ),
      );
    }
    if (fixture.socket.clientCount !== undefined) {
      addRequirement(
        errors,
        isNonNegativeInteger(fixture.socket.clientCount),
        'fixture.socket.clientCount',
        'must be a non-negative integer',
      );
    }
  }

  if (report.scenario?.execution === 'reader-fixture') {
    validateReaderEvidence(fixture.reader, errors);
  }
  if (report.scenario?.execution === 'provider-fixture') {
    validateProviderEvidence(fixture.providers, report.samples, errors);
  }

  const scratch = fixture.scratchSession;
  addRequirement(errors, isRecord(scratch), 'fixture.scratchSession', 'must be an object');
  if (isRecord(scratch)) {
    addRequirement(
      errors,
      isNonEmptyString(scratch.sessionName),
      'fixture.scratchSession.sessionName',
      'must be a non-empty string',
    );
    for (const field of ['tmuxServerPid', 'panePid', 'deterministicSeed']) {
      addRequirement(
        errors,
        isPositiveInteger(scratch[field]),
        `fixture.scratchSession.${field}`,
        'must be a positive integer',
      );
    }
    addRequirement(
      errors,
      Number.isFinite(scratch.outputBytes),
      'fixture.scratchSession.outputBytes',
      'must be finite',
    );
  }
  if (report.scenario?.id === 'many-subscribers-one-session') {
    validateManySubscriberPlateauEvidence(report, errors);
  }
  const expectedSocketCount = expectedFixtureSocketCount(fixture, report.scenario?.execution);
  validateFixtureCleanup(fixture.cleanup, 'fixture.cleanup', errors, expectedSocketCount);

  const checks = report.evaluation?.checks;
  addRequirement(errors, Array.isArray(checks), 'evaluation.checks', 'must be an array');
  if (!Array.isArray(checks)) return;
  const cleanupIndex = checks.findIndex(
    (check) => isRecord(check) && check.id === 'fixture-cleanup',
  );
  addRequirement(
    errors,
    cleanupIndex >= 0,
    'evaluation.checks[fixture-cleanup]',
    'must be present',
  );
  if (cleanupIndex >= 0) {
    const evaluationCleanup = checks[cleanupIndex].actual;
    validateFixtureCleanup(
      evaluationCleanup,
      `evaluation.checks[${cleanupIndex}].actual`,
      errors,
      expectedSocketCount,
    );
    addRequirement(
      errors,
      JSON.stringify(evaluationCleanup) === JSON.stringify(fixture.cleanup),
      `evaluation.checks[${cleanupIndex}].actual`,
      'must match fixture.cleanup',
    );
  }
}

function validateReportSchemaUnsafe(report, thresholds) {
  const versionCheck = validateSchemaVersion(report);
  if (!versionCheck.valid) return versionCheck;
  const provenanceErrors = [];
  validateProvenance(report, provenanceErrors);
  if (provenanceErrors.length > 0) {
    return {
      valid: false,
      reason: `schemaVersion ${report.schemaVersion} report has invalid provenance: ${provenanceErrors.join(', ')}`,
    };
  }
  const evidenceErrors = [];
  if (report.reportKind === 'fixture-scenario') {
    validateFixtureEvidence(report, thresholds ?? report.thresholds, evidenceErrors);
  } else {
    validateEvaluationEvidence(report, thresholds ?? report.thresholds, evidenceErrors);
  }
  if (evidenceErrors.length > 0) {
    return {
      valid: false,
      reason: `schemaVersion ${report.schemaVersion} report has invalid evidence: ${evidenceErrors.join(', ')}`,
    };
  }
  return { valid: true };
}

function validateReportSchema(report, thresholds) {
  try {
    return validateReportSchemaUnsafe(report, thresholds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `schema validation failed: ${detail}` };
  }
}

function evaluateGeneratorLiveness(samples) {
  const failures = [];
  let expectedPids = [];
  for (const sample of samples) {
    if (!sample.generators) {
      failures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: 'missing required field: generators',
      });
      continue;
    }
    const sampleExpected = sample.generators.expectedPids;
    if (!Array.isArray(sampleExpected) || sampleExpected.length === 0) {
      failures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: 'generators.expectedPids must be a non-empty array',
      });
      continue;
    }
    if (sampleExpected.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
      failures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: 'generators.expectedPids must contain only positive integers',
      });
      continue;
    }
    if (new Set(sampleExpected).size !== sampleExpected.length) {
      failures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: 'generators.expectedPids must not contain duplicates',
      });
      continue;
    }
    if (expectedPids.length === 0) {
      expectedPids = [...sampleExpected];
    } else if (
      sampleExpected.length !== expectedPids.length ||
      sampleExpected.some((pid) => !expectedPids.includes(pid))
    ) {
      failures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: `generators.expectedPids does not match the initial PID set; expected [${expectedPids.join(', ')}], received [${sampleExpected.join(', ')}]`,
      });
    }
    const aliveSet = new Set(sample.generators.alivePids || []);
    for (const pid of expectedPids) {
      if (!aliveSet.has(pid)) {
        failures.push({ pid, sampleIndex: sample.index, phase: sample.phase });
      }
    }
  }
  return { pass: failures.length === 0, failures, expectedPids };
}

function evaluateMetricsFreshness(workloadMetrics, samples) {
  const failures = [];
  if (samples.length === 0) {
    return { pass: false, failures: [{ reason: 'no samples for freshness reference' }] };
  }
  const lastSampleCapturedAt = samples[samples.length - 1].system?.capturedAt;
  const lastSampleTime = lastSampleCapturedAt ? new Date(lastSampleCapturedAt).getTime() : NaN;
  if (!Number.isFinite(lastSampleTime)) {
    return {
      pass: false,
      failures: [{ reason: `invalid last sample capturedAt: ${lastSampleCapturedAt}` }],
    };
  }
  for (const metric of workloadMetrics) {
    if (!metric.capturedAt) {
      failures.push({
        session: metric.sessionName,
        reason: 'no capturedAt timestamp',
      });
      continue;
    }
    const capturedAtMs = new Date(metric.capturedAt).getTime();
    if (!Number.isFinite(capturedAtMs)) {
      failures.push({
        session: metric.sessionName,
        reason: `invalid capturedAt: ${metric.capturedAt}`,
      });
      continue;
    }
    const stalenessMs = lastSampleTime - capturedAtMs;
    if (stalenessMs > METRICS_STALENESS_THRESHOLD_MS) {
      failures.push({
        session: metric.sessionName,
        reason: `stale: last capturedAt ${metric.capturedAt}, ${stalenessMs}ms behind last sample`,
        lastCapturedAt: metric.capturedAt,
        stalenessMs,
      });
    }
  }
  return { pass: failures.length === 0, failures };
}

function evaluateIsolation(samples) {
  const samplerPidFailures = [];
  const overlapFailures = [];
  const missingDataFailures = [];
  for (const sample of samples) {
    const samplerPid = sample.system?.sampler?.pid;
    const targetProcesses = sample.system?.target?.processes;
    const workloadProcesses = sample.system?.workload?.processes;
    if (!samplerPid || !targetProcesses || !workloadProcesses) {
      const missing = [];
      if (!samplerPid) missing.push('sampler.pid');
      if (!targetProcesses) missing.push('target.processes');
      if (!workloadProcesses) missing.push('workload.processes');
      missingDataFailures.push({
        sampleIndex: sample.index,
        phase: sample.phase,
        reason: `missing required field(s): ${missing.join(', ')}`,
      });
      continue;
    }
    const targetPids = new Set(targetProcesses.map((p) => p.pid));
    const workloadPids = new Set(workloadProcesses.map((p) => p.pid));
    if (targetPids.has(samplerPid)) {
      samplerPidFailures.push({ sampleIndex: sample.index, samplerPid, phase: sample.phase });
    }
    for (const pid of targetPids) {
      if (workloadPids.has(pid)) {
        overlapFailures.push({ sampleIndex: sample.index, pid, phase: sample.phase });
      }
    }
  }
  return {
    pass:
      samplerPidFailures.length === 0 &&
      overlapFailures.length === 0 &&
      missingDataFailures.length === 0,
    samplerPidFailures,
    overlapFailures,
    missingDataFailures,
  };
}

function evaluateRun(samples, workloadMetrics, thresholds, cleanup) {
  const plateau = evaluatePlateau(samples, thresholds);
  const targetPeakRssBytes = maximum(samples.map((sample) => sample.system.target.rssBytes));
  const workloadPeakRssBytes = maximum(samples.map((sample) => sample.system.workload.rssBytes));
  const targetPeakSwapBytes = maximum(samples.map((sample) => sample.system.target.swapBytes));
  const targetRequired = samples.some((sample) => sample.system.target.rootPid !== null);
  const targetObserved =
    !targetRequired || samples.every((sample) => sample.system.target.processCount > 0);
  const generatorLiveness = evaluateGeneratorLiveness(samples);
  const metricsFreshness = evaluateMetricsFreshness(workloadMetrics, samples);
  const isolation = evaluateIsolation(samples);
  const cgroupMemoryAvailable =
    samples.length > 0 &&
    samples.every(
      (sample) =>
        sample.system.cgroup.available &&
        typeof sample.system.cgroup.currentBytes === 'number' &&
        typeof sample.system.cgroup.swapBytes === 'number',
    );
  const memoryPsiAvailable =
    samples.length > 0 &&
    samples.every(
      (sample) =>
        sample.system.host.pressureAvailable &&
        typeof sample.system.host.pressure?.full?.avg10 === 'number',
    );
  const memoryPsiFullAvg10Peak = maximum(
    samples.map((sample) => sample.system.host.pressure?.full?.avg10 || 0),
  );
  const outputBytesBySession = workloadMetrics.map((metric) => metric.outputBytes || 0);
  const checks = [
    {
      id: 'minimum-samples',
      actual: samples.length,
      threshold: thresholds.minimumSamples,
      comparator: '>=',
      pass: samples.length >= thresholds.minimumSamples,
    },
    {
      id: 'minimum-output-per-session',
      actual: outputBytesBySession.length > 0 ? Math.min(...outputBytesBySession) : 0,
      threshold: thresholds.minimumOutputBytesPerSession,
      comparator: '>=',
      pass:
        outputBytesBySession.length > 0 &&
        outputBytesBySession.every((value) => value >= thresholds.minimumOutputBytesPerSession),
    },
    {
      id: 'minimum-forced-gc-cycles',
      actual:
        workloadMetrics.length > 0
          ? Math.min(...workloadMetrics.map((metric) => metric.forcedGcCount || 0))
          : 0,
      threshold: thresholds.minimumForcedGcCyclesPerSession,
      comparator: '>=',
      pass:
        workloadMetrics.length > 0 &&
        workloadMetrics.every(
          (metric) => (metric.forcedGcCount || 0) >= thresholds.minimumForcedGcCyclesPerSession,
        ),
    },
    {
      id: 'target-process-tree-observed',
      actual: { required: targetRequired, observedEverySample: targetObserved },
      threshold: { observedEverySample: true },
      comparator: '===',
      pass: targetObserved,
    },
    {
      id: 'workload-process-tree-observed',
      actual: { generatorLiveness: generatorLiveness.pass, failures: generatorLiveness.failures },
      threshold: true,
      comparator: '===',
      pass: generatorLiveness.pass,
    },
    {
      id: 'generator-liveness-per-sample',
      actual: {
        pass: generatorLiveness.pass,
        failureCount: generatorLiveness.failures.length,
        failures: generatorLiveness.failures.slice(0, 10),
      },
      threshold: { allExpectedAlive: true },
      comparator: '===',
      pass: generatorLiveness.pass,
    },
    {
      id: 'metrics-freshness-per-session',
      actual: {
        pass: metricsFreshness.pass,
        failureCount: metricsFreshness.failures.length,
        failures: metricsFreshness.failures,
      },
      threshold: { allSessionsFresh: true },
      comparator: '===',
      pass: metricsFreshness.pass,
    },
    {
      id: 'sampler-not-in-target-tree',
      actual: {
        pass: isolation.samplerPidFailures.length === 0,
        samplerPidFailures: isolation.samplerPidFailures.slice(0, 10),
        missingDataFailures: isolation.missingDataFailures.slice(0, 10),
      },
      threshold: { samplerAbsentFromTarget: true },
      comparator: '===',
      pass: isolation.samplerPidFailures.length === 0 && isolation.missingDataFailures.length === 0,
    },
    {
      id: 'target-workload-tree-disjoint',
      actual: {
        pass: isolation.overlapFailures.length === 0,
        overlapFailures: isolation.overlapFailures.slice(0, 10),
      },
      threshold: { treesDisjoint: true },
      comparator: '===',
      pass: isolation.overlapFailures.length === 0,
    },
    {
      id: 'target-peak-rss',
      actual: targetPeakRssBytes,
      threshold: thresholds.maximumTargetPeakRssBytes,
      comparator: '<=',
      pass: targetPeakRssBytes <= thresholds.maximumTargetPeakRssBytes,
    },
    {
      id: 'workload-peak-rss',
      actual: workloadPeakRssBytes,
      threshold: thresholds.maximumWorkloadPeakRssBytes,
      comparator: '<=',
      pass: workloadPeakRssBytes <= thresholds.maximumWorkloadPeakRssBytes,
    },
    {
      id: 'target-peak-swap',
      actual: targetPeakSwapBytes,
      threshold: thresholds.maximumTargetSwapBytes,
      comparator: '<=',
      pass: targetPeakSwapBytes <= thresholds.maximumTargetSwapBytes,
    },
    {
      id: 'cgroup-memory-counters-available',
      actual: cgroupMemoryAvailable,
      threshold: true,
      comparator: '===',
      pass: cgroupMemoryAvailable,
    },
    {
      id: 'memory-psi-full-avg10',
      actual: memoryPsiAvailable ? memoryPsiFullAvg10Peak : null,
      threshold: thresholds.maximumMemoryPsiFullAvg10,
      comparator: '<=',
      pass: memoryPsiAvailable && memoryPsiFullAvg10Peak <= thresholds.maximumMemoryPsiFullAvg10,
    },
    {
      id: 'two-cycle-rss-plateau',
      actual: { growthBytes: plateau.growthBytes, growthRatio: plateau.growthRatio },
      threshold: {
        maximumGrowthBytes: thresholds.maximumPlateauGrowthBytes,
        maximumGrowthRatio: thresholds.maximumPlateauGrowthRatio,
        rule: 'either bound may establish a plateau',
      },
      comparator: '<=',
      pass: plateau.pass,
    },
    {
      id: 'isolated-tmux-cleanup',
      actual: cleanup,
      threshold: { serverAliveAfterCleanup: false },
      comparator: '===',
      pass: cleanup.attempted && !cleanup.serverAliveAfterCleanup,
    },
  ];
  return {
    pass: checks.every((check) => check.pass),
    checks,
    summary: {
      targetPeakRssBytes,
      workloadPeakRssBytes,
      targetPeakSwapBytes,
      memoryPsiAvailable,
      memoryPsiFullAvg10Peak: memoryPsiAvailable ? memoryPsiFullAvg10Peak : null,
      plateau,
      totalOutputBytes: outputBytesBySession.reduce((sum, value) => sum + value, 0),
      generatorLiveness,
      metricsFreshness,
      isolation,
    },
  };
}

function evaluationRefusal(reason) {
  return {
    pass: false,
    refused: true,
    reason: `report evaluation refused: ${reason}`,
    checks: [],
    summary: null,
  };
}

function evaluateFixtureRun(report, thresholds) {
  const { fixture, samples } = report;
  const cleanup = fixture.cleanup;
  const expectedSocketCount = expectedFixtureSocketCount(fixture, report.scenario?.execution);
  const socketObservation = cleanup.socketObservation;
  const socketCleanupPassed =
    cleanup.socketDisconnected &&
    socketObservation.observedCount >= expectedSocketCount &&
    socketObservation.disconnectedCount === socketObservation.observedCount &&
    socketObservation.disconnectErrorCount === 0 &&
    !socketObservation.timedOut &&
    socketObservation.outcomes.every(
      (outcome) =>
        outcome.disconnectAttempted && !outcome.connectedAfterWait && outcome.disconnected,
    );
  const isolation = evaluateIsolation(samples);
  const targetPeakRssBytes = maximum(samples.map((sample) => sample.system.target.rssBytes));
  const workloadPeakRssBytes = maximum(samples.map((sample) => sample.system.workload.rssBytes));
  const cleanupPassed =
    cleanup.attempted &&
    socketCleanupPassed &&
    !cleanup.processAliveAfterCleanup &&
    !cleanup.tmuxServerAliveAfterCleanup &&
    cleanup.storageCreated &&
    !cleanup.storageExistsAfterCleanup &&
    !cleanup.tempRootExistsAfterCleanup &&
    cleanup.processesGone &&
    cleanup.alivePidsAfterCleanup.length === 0 &&
    cleanup.residuePaths.length === 0 &&
    cleanup.removalError === null;
  const plateau =
    Number.isFinite(thresholds.maximumPlateauGrowthBytes) &&
    Number.isFinite(thresholds.maximumPlateauGrowthRatio)
      ? evaluatePlateau(samples, thresholds)
      : null;
  const requiresStableState = report.scenario?.id === 'many-subscribers-one-session';
  const stableState = requiresStableState ? evaluateManySubscriberStableState(report) : null;
  const plateauAttribution = requiresStableState ? evaluateFixturePlateauAttribution(report) : null;
  const stableStateCheck = stableState
    ? {
        id: 'fixture-many-subscriber-stable-state',
        actual: stableState,
        threshold: {
          allSubscribersConnected: true,
          tmuxHistoryAtConfiguredLimit: true,
          generatorOutputUnchanged: true,
          memoryOnlyChurnPerPhase: true,
        },
        comparator: '===',
        pass: stableState.pass,
      }
    : null;
  const attributionCheck = plateauAttribution
    ? {
        id: 'fixture-plateau-component-attribution',
        actual: plateauAttribution,
        threshold: { targetTmuxServerAndGeneratorTailMediansPresent: true },
        comparator: '===',
        pass: plateauAttribution.pass,
      }
    : null;
  if (requiresStableState && (!stableState.pass || !plateauAttribution.pass)) {
    const reason = !stableState.pass
      ? `many-subscriber stable-state gate failed: ${stableState.failures[0]}`
      : `many-subscriber plateau attribution failed: ${plateauAttribution.failures[0]}`;
    return {
      pass: false,
      refused: true,
      reason: `report evaluation refused: ${reason}`,
      checks: [stableStateCheck, attributionCheck],
      summary: { stableState, plateauAttribution },
    };
  }
  const correctnessPassed = report.correctness?.pass ?? true;
  const equivalence = report.terminalEquivalence;
  const terminalEquivalencePassed = equivalence
    ? equivalence.text.firstDifference === -1 &&
      equivalence.text.actualSha256 === equivalence.text.expectedSha256 &&
      equivalence.text.actualBytes === equivalence.text.expectedBytes &&
      equivalence.captureRendering.firstDifference === -1 &&
      equivalence.captureRendering.actualSha256 === equivalence.captureRendering.expectedSha256 &&
      equivalence.captureRendering.actualBytes === equivalence.captureRendering.expectedBytes &&
      equivalence.style.byteIdentical &&
      equivalence.style.firstDifference === -1 &&
      equivalence.style.socketSha256 === equivalence.style.freshCaptureSha256 &&
      equivalence.style.socketCellCount === equivalence.style.freshCaptureCellCount
    : true;
  const backpressure = report.backpressure;
  const firstMissingStalledRegistration = backpressure?.observations.findIndex(
    (observation) => !observation.stalled.registered,
  );
  const socketRegistrationEvidencePassed = backpressure
    ? backpressure.observations.every((observation) => observation.current.registered) &&
      (firstMissingStalledRegistration === -1 ||
        (firstMissingStalledRegistration > 0 &&
          backpressure.observations
            .slice(firstMissingStalledRegistration)
            .every((observation) => !observation.stalled.registered)))
    : true;
  const backpressureChecks = backpressure
    ? [
        {
          id: 'fixture-backpressure-observation-count',
          actual: backpressure.observations.length,
          threshold: thresholds.minimumBackpressureSamples,
          comparator: '>=',
          pass:
            backpressure.observations.length >= thresholds.minimumBackpressureSamples &&
            socketRegistrationEvidencePassed,
        },
        {
          id: 'fixture-stalled-application-queue-bounded',
          actual: backpressure.stalled,
          threshold: {
            maximumQueuedBytes: thresholds.maximumStalledSocketQueueBytes,
            policyOutcome: 'desynchronized or disconnected',
            queueGrowthObserved: true,
          },
          comparator: '<=',
          pass:
            backpressure.stalled.maximumQueuedBytes <= thresholds.maximumStalledSocketQueueBytes &&
            backpressure.stalled.queueGrowthObserved &&
            (backpressure.stalled.desynchronized ||
              backpressure.stalled.disconnectedByPolicy ||
              backpressure.stalled.droppedFrames > 0),
        },
        {
          id: 'fixture-engine-write-buffers-bounded',
          actual: {
            stalled: backpressure.stalled.maximumEngineBufferedPackets,
            current: backpressure.current.maximumEngineBufferedPackets,
          },
          threshold: {
            stalled: thresholds.maximumStalledEngineBufferedPackets,
            current: thresholds.maximumCurrentEngineBufferedPackets,
          },
          comparator: '<=',
          pass:
            backpressure.stalled.maximumEngineBufferedPackets <=
              thresholds.maximumStalledEngineBufferedPackets &&
            backpressure.current.maximumEngineBufferedPackets <=
              thresholds.maximumCurrentEngineBufferedPackets,
        },
        {
          id: 'fixture-current-socket-isolated-from-stalled-peer',
          actual: backpressure.current,
          threshold: {
            maximumQueuedBytes: thresholds.maximumCurrentSocketQueueBytes,
            maximumDeliveryLatencyMs: thresholds.maximumCurrentDeliveryLatencyMs,
            framesReceived: '> 0',
          },
          comparator: '<=',
          pass:
            backpressure.current.maximumQueuedBytes <= thresholds.maximumCurrentSocketQueueBytes &&
            backpressure.current.deliveryLatencyMs <= thresholds.maximumCurrentDeliveryLatencyMs &&
            backpressure.current.framesReceived > 0,
        },
      ]
    : [];
  const providerFixture = report.scenario?.execution === 'provider-fixture';
  const mobileFixture = report.scenario?.execution === 'mobile-fixture';
  const providerEvidence = fixture.providers;
  const providerResults = Array.isArray(providerEvidence?.results) ? providerEvidence.results : [];
  const transportChecks = providerFixture
    ? [
        {
          id: 'fixture-provider-registry-covered',
          actual: {
            registrySource: providerEvidence?.registrySource,
            registryProviders: providerEvidence?.registryProviders,
            loadedProviders: providerEvidence?.loadedProviders,
            missingProviders: providerEvidence?.missingProviders,
            coverageRatio: providerEvidence?.coverageRatio,
            loadErrors: providerEvidence?.loadErrors,
          },
          threshold: { runtimeRegistryCoverage: 1, missingProviders: [], loadErrors: [] },
          comparator: '===',
          pass:
            providerEvidence?.registrySource ===
              'SessionReaderAdapterFactory.getSupportedProviders' &&
            providerEvidence?.registryProviders?.length > 0 &&
            providerEvidence?.coverageRatio === 1 &&
            providerEvidence?.missingProviders?.length === 0 &&
            providerEvidence?.loadErrors?.length === 0 &&
            JSON.stringify(providerEvidence?.loadedProviders) ===
              JSON.stringify(providerEvidence?.registryProviders),
        },
        {
          id: 'fixture-provider-metrics-parity',
          actual: providerResults.map((result) => ({
            providerName: result.providerName,
            metricsEqual: result.metricsEqual,
            exactMismatches: result.exactMismatches,
            toleratedDifferences: result.toleratedDifferences,
            error: result.error,
          })),
          threshold: {
            everyRegisteredProviderCompared: true,
            exactFieldsEqual: true,
            toleratedFieldsDocumented: true,
          },
          comparator: '===',
          pass:
            providerResults.length === providerEvidence?.registryProviders?.length &&
            providerEvidence?.registryProviders?.every((providerName) => {
              const result = providerResults.find((entry) => entry.providerName === providerName);
              return result?.metricsEqual === true && result.error === null;
            }),
        },
        {
          id: 'fixture-provider-reads-memory-sampled',
          actual: providerResults.map((result) => ({
            providerName: result.providerName,
            sampleIndexes: result.sampleIndexes,
          })),
          threshold: { summaryAndFullReadsSampledPerProvider: true },
          comparator: '===',
          pass: providerResults.every((result) => {
            const providerSamples = result.sampleIndexes.map((sampleIndex) => samples[sampleIndex]);
            return (
              providerSamples.length >= 2 &&
              providerSamples.every(
                (sample) => sample?.providerRead?.providerName === result.providerName,
              ) &&
              ['summary', 'full'].every((operation) =>
                providerSamples.some((sample) => sample.providerRead.operation === operation),
              )
            );
          }),
        },
      ]
    : mobileFixture
      ? [
          {
            id: 'fixture-mobile-ingress-authenticated',
            actual: fixture.mobile?.authentication,
            threshold: { bearerAccepted: true, attestVerified: true, readyIssued: true },
            comparator: '===',
            pass:
              fixture.mobile?.authentication?.bearerAccepted === true &&
              fixture.mobile?.authentication?.attestVerified === true &&
              fixture.mobile?.authentication?.readyIssued === true,
          },
          {
            id: 'fixture-scratch-session-observed',
            actual: { outputBytes: fixture.scratchSession.outputBytes },
            threshold: { outputBytes: '> 0' },
            comparator: '>',
            pass: fixture.scratchSession.outputBytes > 0,
          },
        ]
      : [
          {
            id: 'fixture-socket-authenticated',
            actual: fixture.socket,
            threshold: {
              connected: true,
              runtimeTokenVerified: true,
              handshakeTokenPresented: true,
            },
            comparator: '===',
            pass:
              fixture.socket.connected &&
              fixture.socket.runtimeTokenVerified &&
              fixture.socket.handshakeTokenPresented,
          },
          {
            id: 'fixture-scratch-session-observed',
            actual: {
              outputBytes: fixture.scratchSession.outputBytes,
              subscribed: fixture.socket.subscribed,
              seedObserved: fixture.socket.seedObserved,
            },
            threshold: { outputBytes: '> 0', subscribed: true, seedObserved: true },
            comparator: '===',
            pass:
              fixture.scratchSession.outputBytes > 0 &&
              fixture.socket.subscribed &&
              fixture.socket.seedObserved,
          },
        ];
  const checks = [
    {
      id: 'fixture-target-provenance-bound',
      actual: report.target.provenance.method,
      threshold: 'linux-procfs-sha256-v1',
      comparator: '===',
      pass: report.target.provenance.method === 'linux-procfs-sha256-v1',
    },
    {
      id: 'fixture-app-runtime-ready',
      actual: fixture.app,
      threshold: { ready: true, pidMatchesTarget: true },
      comparator: '===',
      pass: fixture.app.ready && fixture.app.pid === report.target.pid,
    },
    ...transportChecks,
    {
      id: 'fixture-memory-sampled',
      actual: {
        sampleCount: samples.length,
        targetPeakRssBytes,
        workloadPeakRssBytes,
      },
      threshold: { minimumSamples: thresholds.minimumSamples, positiveTrees: true },
      comparator: '>=',
      pass:
        samples.length >= thresholds.minimumSamples &&
        samples.every(
          (sample) =>
            sample.system.target.processCount > 0 && sample.system.workload.processCount > 0,
        ),
    },
    {
      id: 'fixture-process-tree-isolation',
      actual: isolation,
      threshold: { samplerAbsentFromTarget: true, treesDisjoint: true },
      comparator: '===',
      pass: isolation.pass,
    },
    ...(plateau
      ? [
          {
            id: 'fixture-two-cycle-rss-plateau',
            actual: { growthBytes: plateau.growthBytes, growthRatio: plateau.growthRatio },
            threshold: {
              maximumGrowthBytes: thresholds.maximumPlateauGrowthBytes,
              maximumGrowthRatio: thresholds.maximumPlateauGrowthRatio,
              rule: 'either bound may establish a plateau',
            },
            comparator: '<=',
            pass: plateau.pass,
          },
        ]
      : []),
    ...(stableStateCheck ? [stableStateCheck, attributionCheck] : []),
    ...(report.correctness
      ? [
          {
            id: 'fixture-scenario-correctness',
            actual: report.correctness,
            threshold: { allExpectedOutcomesPass: true },
            comparator: '===',
            pass: correctnessPassed,
          },
        ]
      : []),
    ...(equivalence
      ? [
          {
            id: 'fixture-terminal-state-equivalence',
            actual: equivalence,
            threshold: { textAndStyledCellsByteIdentical: true },
            comparator: '===',
            pass: terminalEquivalencePassed,
          },
        ]
      : []),
    ...backpressureChecks,
    {
      id: 'fixture-cleanup',
      actual: cleanup,
      threshold: { noSocketProcessTmuxStorageOrPathResidue: true },
      comparator: '===',
      pass: cleanupPassed,
    },
  ];
  return {
    pass: checks.every((check) => check.pass),
    checks,
    summary: {
      targetPeakRssBytes,
      workloadPeakRssBytes,
      isolation,
      cleanupPassed,
      plateau,
      ...(stableState && { stableState, plateauAttribution }),
      correctnessPassed,
      terminalEquivalencePassed,
      backpressurePassed: backpressureChecks.every((check) => check.pass),
    },
  };
}

function evaluateReportUnsafe(report, thresholds) {
  const schema = validateReportSchema(report, thresholds);
  if (!schema.valid) return evaluationRefusal(schema.reason);

  const resolvedThresholds = thresholds ?? report.thresholds;
  if (report.reportKind === 'fixture-scenario') {
    return evaluateFixtureRun(report, resolvedThresholds);
  }
  const samples = report.samples;
  const workloadMetrics = report.workload.sessions;
  const cleanup = report.evaluation.checks.find(
    (check) => check.id === 'isolated-tmux-cleanup',
  ).actual;

  return evaluateRun(samples, workloadMetrics, resolvedThresholds, cleanup);
}

function evaluateReport(report, thresholds) {
  try {
    return evaluateReportUnsafe(report, thresholds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return evaluationRefusal(`internal evaluator failure: ${detail}`);
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  evaluateGeneratorLiveness,
  evaluateIsolation,
  evaluateMetricsFreshness,
  evaluatePlateau,
  evaluateReport,
  evaluateFixtureRun,
  // Pure quantitative seam for contract tests; production callers use evaluateReport.
  evaluateRun,
  median,
  validateReportSchema,
  validateSchemaVersion,
};
