'use strict';

const HOST_PHASES = [
  { name: 'warmup', baselineMs: 2_000, soakMs: 30_000, workloadMode: 'foreground' },
  { name: 'foreground', baselineMs: 3_000, soakMs: 60_000, workloadMode: 'foreground' },
  { name: 'background', baselineMs: 2_000, soakMs: 30_000, workloadMode: 'background' },
  { name: 'cache-churn-1', baselineMs: 3_000, soakMs: 60_000, workloadMode: 'churn' },
  { name: 'cache-churn-2', baselineMs: 3_000, soakMs: 60_000, workloadMode: 'churn' },
  { name: 'cooldown', baselineMs: 2_000, soakMs: 30_000, workloadMode: 'background' },
];

const DEFAULT_THRESHOLDS = {
  minimumSamples: 20,
  minimumOutputBytesPerSession: 32 * 1024,
  minimumForcedGcCyclesPerSession: 2,
  maximumTargetPeakRssBytes: 1536 * 1024 * 1024,
  maximumWorkloadPeakRssBytes: 512 * 1024 * 1024,
  maximumTargetSwapBytes: 64 * 1024 * 1024,
  maximumMemoryPsiFullAvg10: 5,
  maximumPlateauGrowthBytes: 32 * 1024 * 1024,
  maximumPlateauGrowthRatio: 0.1,
};

const SOCKET_BACKPRESSURE_THRESHOLDS = Object.freeze({
  minimumBackpressureSamples: 10,
  maximumStalledSocketQueueBytes: 5 * 1024 * 1024,
  maximumStalledEngineBufferedPackets: 4,
  maximumCurrentSocketQueueBytes: 1024 * 1024,
  maximumCurrentEngineBufferedPackets: 4,
  maximumCurrentDeliveryLatencyMs: 2_000,
});

const scenarios = [
  {
    id: 'host-burst-plateau',
    title: 'Isolated multi-session burst and memory plateau',
    state: 'active',
    execution: 'tmux-host',
    covers: [
      'defined session count and deterministic output rate',
      'burst shape with warm-up and foreground/background phases',
      'observational GC policy with forced GC in owned workload children',
      'host, cgroup, target-tree, child-process RSS, swap, and memory PSI',
      'RSS plateau across two cache-churn cycles',
      'worktree and tmux-server isolation',
      'oversized Unicode and ANSI output generation',
    ],
    phases: HOST_PHASES,
    thresholds: DEFAULT_THRESHOLDS,
  },
  {
    id: 'many-subscribers-one-session',
    title: 'Many subscribers share one targeted seed capture',
    state: 'active',
    execution: 'socket-fixture',
    activation:
      'Activate when the integration fixture can expose the seed-capture counter while attaching deterministic Socket.IO clients to one scratch application session.',
    expected: ['one server capture', 'all subscribers converge on the same final terminal state'],
  },
  {
    id: 'reconnect-replay-available',
    title: 'Reconnect while requested sequence remains in replay ring',
    state: 'active',
    execution: 'socket-fixture',
    activation:
      'Activate with the scratch application-session fixture; reconnect with a retained lastSequence and assert replay without a fresh seed.',
    expected: ['no fresh seed', 'strictly ordered replay', 'fresh capture equivalence'],
  },
  {
    id: 'reconnect-older-than-ring',
    title: 'Reconnect older than replay ring forces reseed',
    state: 'active',
    execution: 'socket-fixture',
    activation:
      'Activate when the bounded replay ring and explicit forced-reseed response are available.',
    expected: ['forced reseed is explicit', 'fresh capture equivalence after reseed'],
  },
  {
    id: 'zero-web-mobile-activity',
    title: 'Mobile viewport advances with zero web subscribers',
    state: 'active',
    execution: 'mobile-fixture',
    activation:
      'Activate when the harness has an authenticated bridge/mobile viewport fixture for a scratch session.',
    expected: ['viewport advances', 'session activity advances', 'no web socket required'],
  },
  {
    id: 'stalled-and-current-socket',
    title: 'One stalled socket does not delay a current socket',
    state: 'active',
    execution: 'socket-fixture',
    activation:
      'Activate with the application-owned per-socket queue and writable-transport control surface.',
    expected: ['current socket remains bounded', 'stalled socket is bounded or disconnected'],
    thresholds: SOCKET_BACKPRESSURE_THRESHOLDS,
  },
  {
    id: 'oversized-unicode-ansi-chunking',
    title: 'Oversized Unicode and ANSI chunks preserve terminal state',
    state: 'active',
    execution: 'socket-xterm-fixture',
    activation:
      'Activate when a scratch application session can route the active host-burst generator through Socket.IO into headless xterm.',
    expected: ['UTF-8 boundaries intact', 'ANSI state intact', 'fresh tmux capture equivalence'],
  },
  {
    id: 'seed-during-burst',
    title: 'Seed during burst converges after resync completion',
    state: 'active',
    execution: 'socket-xterm-fixture',
    activation:
      'Activate when the resync_complete protocol exists; include output emitted between capture and resync completion.',
    expected: ['headless xterm equals fresh tmux capture', 'no gap during seed window'],
  },
  {
    id: 'lifecycle-cleanup-parity',
    title: 'Stopped, crashed, and dead sessions clean up identically',
    state: 'active',
    execution: 'lifecycle-fixture',
    activation:
      'Activate with disposable application storage and scratch session lifecycle controls.',
    expected: ['PTY cleanup parity', 'listener cleanup parity', 'frame-buffer cleanup parity'],
  },
  {
    id: 'summary-full-provider-parity',
    title: 'Summary and full transcript parity for every provider',
    state: 'active',
    execution: 'provider-fixture',
    activation:
      'Activate when deterministic transcript fixtures for every registered provider can be loaded into disposable storage.',
    expected: ['summary metrics equal full metrics', 'provider coverage matches adapter registry'],
  },
  {
    id: 'eviction-concurrent-transcript-reads',
    title: 'Eviction remains correct during summary, index, and chunk reads',
    state: 'active',
    execution: 'reader-fixture',
    activation:
      'Runs seeded transcript generations through a disposable app with a harness-only cache budget that forces whole-entry eviction.',
    expected: ['no mixed generations', 'summary/index/chunk consistency', 'bounded retained bytes'],
  },
  {
    id: 'engine-write-buffer-bounded',
    title: 'Engine.IO writeBuffer does not grow while transport is unwritable',
    state: 'active',
    execution: 'socket-fixture',
    activation: 'Activate with the application-owned queue and an unwritable-transport test seam.',
    expected: ['Engine.IO writeBuffer stays bounded', 'application queue policy is observable'],
    thresholds: SOCKET_BACKPRESSURE_THRESHOLDS,
  },
];

function getScenario(id) {
  return scenarios.find((scenario) => scenario.id === id);
}

module.exports = {
  DEFAULT_THRESHOLDS,
  HOST_PHASES,
  SOCKET_BACKPRESSURE_THRESHOLDS,
  getScenario,
  scenarios,
};
