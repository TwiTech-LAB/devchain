import { writeFileSync } from 'node:fs';
import { GitCoordinatorService } from '../git-coordinator/git-coordinator.service';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { HomeGitWriteService } from './home-git-write.service';
import { HomeGitTransitions } from './home-git-transitions';
import {
  startGitOwnership,
  syncthingBinary,
  type GitOwnershipPair,
  type Side,
} from '../../../common/test/git-ownership.fixture';
import { waitForValue } from '../../../common/test/two-instance.fixture';

// Opt-in: DEVCHAIN_GIT_BENCH=1, optionally DEVCHAIN_GIT_BENCH_RUNS and DEVCHAIN_GIT_BENCH_OUT
// (a Markdown report path). Targets are reported, not asserted: timings depend on the machine.
const binary = syncthingBinary();
const enabled = process.env.DEVCHAIN_GIT_BENCH && binary && process.platform === 'linux';
const bench = enabled ? describe : describe.skip;
const RUNS = Number(process.env.DEVCHAIN_GIT_BENCH_RUNS ?? 10);
jest.setTimeout(30 * 60_000);

const TARGETS: Record<string, number> = {
  'read overhead': 10,
  'same-owner write': 500,
  handover: 1_500,
  reclaim: 300,
};

/** Spans the other handover steps, so it is never the slowest step. */
const MOVE = 'the move alone (all steps)';
const BURST = 'burst of 5 writes → all confirmed';
const CONFIRM_BARRIER = 'PC changes reach the VM';

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

bench('Git ownership timings', () => {
  let g: GitOwnershipPair;
  const savedBin = process.env.SYNCTHING_BIN;
  const totals: Record<string, number[]> = {};
  const steps: Record<string, Record<string, number[]>> = {};
  let measuring: string | null = null;

  const record = (bucket: Record<string, number[]>, name: string, ms: number) =>
    (bucket[name] ??= []).push(ms);
  const timed = async (name: string, work: () => Promise<unknown>) => {
    measuring = name;
    const started = performance.now();
    try {
      await work();
    } finally {
      record(totals, name, performance.now() - started);
      measuring = null;
    }
  };
  /** Records each call's duration under the scenario being measured. */
  const timeMethod = <T extends object>(
    target: T,
    method: string,
    label: (args: unknown[]) => string = () => method,
  ) => {
    const original = (target as Record<string, (...args: unknown[]) => Promise<unknown>>)[method];
    jest.spyOn(target as never, method as never).mockImplementation((async (...args: unknown[]) => {
      const started = performance.now();
      try {
        return await original.apply(target, args);
      } finally {
        if (measuring) record((steps[measuring] ??= {}), label(args), performance.now() - started);
      }
    }) as never);
  };
  const ok = async (side: Side, ...args: string[]) => {
    const result = await g.run(side, ...args);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  const stepsDown = () =>
    waitForValue(
      async () => g.homeCache().owner === 'vm' && g.homeCache().generation === g.vm().generation,
      30_000,
      20,
    );

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    g = await startGitOwnership();
    const client = g.pair.home.app.get(RemoteHostClient);
    const handover = g.pair.home.app.get(HomeGitTransitions);
    timeMethod(client, 'handoverBegin', () => 'begin');
    timeMethod(client, 'handoverPhase', (args) => (args[2] as { phase: string }).phase);
    timeMethod(client, 'handoverComplete', () => 'complete');
    timeMethod(client, 'homeWriteBegin', () => 'write-begin');
    timeMethod(client, 'homeWriteEnd', () => 'write-end (VM checks)');
    timeMethod(handover, 'runHandover', () => MOVE);
    timeMethod(handover, 'barrier', () => 'VM changes reach the PC');
    timeMethod(handover, 'finish', () => 'PC install (index, guard)');
    timeMethod(handover, 'runStepDown', () => 'PC step-down');
    timeMethod(g.pair.host.app.get(GitCoordinatorService), 'reclaim', () => 'VM reclaim');
    timeMethod(g.pair.home.app.get(HomeGitWriteService), 'changeBarrier', () => CONFIRM_BARRIER);
    timeMethod(g.pair.home.app.get(FileSyncService), 'rescan', () => 'PC scan (each folder)');
    timeMethod(
      g.pair.home.app.get(FileSyncService),
      'remoteNeedThrough',
      () => 'barrier poll (each)',
    );
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await g?.close();
    if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
    else process.env.SYNCTHING_BIN = savedBin;
  });

  it('measures reads, writes, handovers and reclaims', async () => {
    const burstBarriers: number[] = [];
    for (let i = 0; i < RUNS * 3; i++) {
      for (const [name, bypass] of [
        ['read via shim', false],
        ['read via real git', true],
      ] as const) {
        const started = performance.now();
        const result = await g.start('home', ['status', '--porcelain'], { bypass }).result;
        if (result.code !== 0) throw new Error(result.stderr);
        record(totals, name, performance.now() - started);
      }
    }
    totals['read overhead'] = totals['read via shim'].map(
      (ms, i) => ms - totals['read via real git'][i],
    );

    for (let i = 0; i < RUNS; i++) {
      await timed('handover', () => ok('home', 'tag', '-f', `bench-h${i}`));
      await g.confirmed(30_000, 20);
      await timed('same-owner write', () => ok('home', 'tag', '-f', `bench-s${i}`));
      await timed('write confirmed after the command', () => g.confirmed(30_000, 20));
      const before = steps[BURST]?.[CONFIRM_BARRIER]?.length ?? 0;
      await timed(BURST, async () => {
        for (let k = 0; k < 5; k++) await ok('home', 'tag', '-f', `bench-b${i}-${k}`);
        await g.confirmed(60_000, 20);
      });
      burstBarriers.push((steps[BURST]?.[CONFIRM_BARRIER]?.length ?? 0) - before);
      await timed('reclaim', () => ok('vm', 'tag', '-f', `bench-v${i}`));
      await stepsDown();
    }

    const lines = [
      '| Measure | p50 ms | p95 ms | Target ms | Slowest step (p50 ms) |',
      '| --- | ---: | ---: | ---: | --- |',
    ];
    for (const [name, values] of Object.entries(totals)) {
      const p50 = percentile(values, 50);
      const target = TARGETS[name];
      const slowest = Object.entries(steps[name] ?? {})
        .filter(([step]) => step !== MOVE)
        .map(([step, ms]) => [step, percentile(ms, 50)] as const)
        .sort((a, b) => b[1] - a[1])[0];
      lines.push(
        `| ${name} | ${p50.toFixed(1)} | ${percentile(values, 95).toFixed(1)} | ${
          target === undefined ? '' : `${target}${p50 > target ? ' **missed**' : ''}`
        } | ${slowest ? `${slowest[0]} (${slowest[1].toFixed(1)})` : ''} |`,
      );
    }
    const stepLines = Object.entries(steps).flatMap(([name, byStep]) =>
      Object.entries(byStep).map(
        ([step, ms]) =>
          `| ${name} | ${step} | ${percentile(ms, 50).toFixed(1)} | ${percentile(ms, 95).toFixed(1)} |`,
      ),
    );
    const report = [
      `Runs: ${RUNS} (reads: ${RUNS * 3})`,
      '',
      ...lines,
      '',
      `Barriers per ${BURST}: ${burstBarriers.join(', ')}`,
      '',
      '| Measure | Step | p50 ms | p95 ms |',
      '| --- | --- | ---: | ---: |',
      ...stepLines,
      '',
    ].join('\n');
    if (process.env.DEVCHAIN_GIT_BENCH_OUT)
      writeFileSync(process.env.DEVCHAIN_GIT_BENCH_OUT, report);
    process.stdout.write(`${report}\n`);
    expect(totals.handover).toHaveLength(RUNS);
  });
});
