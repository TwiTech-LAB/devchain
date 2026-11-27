import { Test } from '@nestjs/testing';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import {
  GitCoordinatorService,
  GIT_COORDINATOR_TIMINGS,
  DEFAULT_GIT_COORDINATOR_TIMINGS,
  type GitCoordinatorTimings,
} from './git-coordinator.service';
import { GitCoordinatorStore } from './git-coordinator.store';
import { GitCoordinatorIndexService } from './git-coordinator-index.service';
import { GitProcessIdentity } from './git-process-identity';
import type { GitCoordinatorRecord, GitFence } from './git-coordinator.dto';
import { missingBaselineObjects, restoreGitBaseline, type GitBaseline } from './git-checkpoint';

jest.mock('./git-checkpoint', () => ({
  ...jest.requireActual('./git-checkpoint'),
  missingBaselineObjects: jest.fn(),
  restoreGitBaseline: jest.fn(),
}));

// Unit tests exercise admission and timeouts without real processes, sync, or clocks.
const fence: GitFence = { expectedGeneration: 0, transitionId: null };
const hold = { holdId: 'hold', pid: 123, processStartTime: 'boot:10' };
const fresh = (): GitCoordinatorRecord => ({
  owner: 'vm',
  generation: 0,
  homeName: 'my-PC',
  homeWrites: {},
  checkpoint: null,
  vmHolds: {},
  transition: null,
});
const home = (): GitCoordinatorRecord => ({
  ...fresh(),
  owner: 'home',
  checkpoint: { writeId: 'write', generation: 0, refsDigest: 'refs', at: 1 },
});
const baseline: GitBaseline = {
  generation: 0,
  head: 'refs/heads/main',
  refs: [],
  symbolicRefs: {},
  sequencer: [],
  refsDigest: 'baseline',
};
const pendingHome = (): GitCoordinatorRecord => ({
  ...home(),
  homeWrites: { pending: 1 },
  baseline: { generation: 0, refsDigest: baseline.refsDigest },
});

describe('GitCoordinatorService admission', () => {
  let service: GitCoordinatorService;
  let records: Map<string, GitCoordinatorRecord>;
  const files = {
    folderPath: jest.fn(),
    updateFolder: jest.fn(),
    device: jest.fn(),
    folderConfiguration: jest.fn(),
    isConnected: jest.fn(),
  };
  const guard = { remove: jest.fn() };
  const indexes = {
    sequencer: jest.fn(),
    save: jest.fn(),
    install: jest.fn(),
    cleanup: jest.fn(),
    worktreeBranches: jest.fn(),
    readBaseline: jest.fn(),
  };
  const processes = { read: jest.fn() };
  const executor = { run: jest.fn() };

  /** The PC's unconfirmed write changed the ref storage after the VM saved its baseline. */
  const reftable = () =>
    executor.run.mockImplementation(async ({ argv }: { argv: string[] }) => ({
      success: true,
      stdout: argv.includes('config') ? 'extensions.refstorage\nreftable\0' : '',
    }));
  /** What Git does when it cannot read `.git/config`: --get exits 1 as for an absent setting. */
  const unreadableConfig = () =>
    executor.run.mockImplementation(async ({ argv }: { argv: string[] }) =>
      argv.includes('config')
        ? { success: false, exitCode: argv.includes('--get') ? 1 : 128, stdout: '', stderr: '' }
        : { success: true, stdout: '' },
    );

  async function startCoordinator(
    timings: Partial<GitCoordinatorTimings> = {},
  ): Promise<GitCoordinatorService> {
    const module = await Test.createTestingModule({
      providers: [
        GitCoordinatorService,
        {
          provide: GitCoordinatorStore,
          useValue: {
            read: (id: string) => structuredClone(records.get(id) ?? fresh()),
            write: (id: string, value: GitCoordinatorRecord) =>
              records.set(id, structuredClone(value)),
            delete: (id: string) => records.delete(id),
            projects: () => [...records.keys()],
          },
        },
        { provide: FileSyncService, useValue: files },
        { provide: HomeGitGuardService, useValue: guard },
        { provide: GitCoordinatorIndexService, useValue: indexes },
        { provide: GitProcessIdentity, useValue: processes },
        { provide: ProcessExecutor, useValue: executor },
        {
          provide: GIT_COORDINATOR_TIMINGS,
          useValue: { ...DEFAULT_GIT_COORDINATOR_TIMINGS, gcMs: Infinity, ...timings },
        },
      ],
    }).compile();
    return module.get(GitCoordinatorService);
  }

  beforeEach(async () => {
    jest.useFakeTimers({ now: 100_000 });
    jest.resetAllMocks();
    records = new Map([['p', fresh()]]);
    files.folderPath.mockResolvedValue('/project');
    files.device.mockReturnValue({ deviceId: 'VM' });
    files.folderConfiguration.mockResolvedValue({
      devices: [{ deviceID: 'VM' }, { deviceID: 'PC' }],
    });
    files.isConnected.mockResolvedValue(false);
    guard.remove.mockResolvedValue({ removed: true, warning: null });
    indexes.sequencer.mockResolvedValue(null);
    indexes.worktreeBranches.mockResolvedValue([]);
    indexes.readBaseline.mockResolvedValue(baseline);
    jest.mocked(missingBaselineObjects).mockResolvedValue([]);
    jest.mocked(restoreGitBaseline).mockResolvedValue(undefined);
    processes.read.mockResolvedValue('boot:10');
    executor.run.mockResolvedValue({ success: true, stdout: '' });
    service = await startCoordinator();
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('refreshes the home deadline on home activity and restores one grace period on first read after restart', async () => {
    const deadline = (id: string) => service['homeLeaseDeadlines'].get(id);
    const graceMs = 300_000;
    const moving = { ...fence, transitionId: 'handover' };
    await service.beginHandover('p', { ...fence, id: 'handover', homeName: 'PC' });
    expect(deadline('p')).toBeUndefined();

    jest.setSystemTime(101_000);
    await service.renewHandover('p', moving);
    expect(deadline('p')).toBe(101_000 + graceMs);

    jest.setSystemTime(102_000);
    const flipped = await service.handoverPhase('p', { ...moving, phase: 'vm-receiving' });
    expect(deadline('p')).toBe(102_000 + graceMs);
    await service.handoverPhase('p', { ...moving, phase: 'home-sending' });
    await service.handoverPhase('p', { ...moving, phase: 'published', writeId: 'first' });
    await service.handoverComplete('p', { ...moving, expectedGeneration: 1 });

    const owned = { ...fence, expectedGeneration: 1 };
    jest.setSystemTime(103_000);
    await service.homeWriteBegin('p', { ...owned, writeId: 'second', homeName: 'PC' });
    expect(deadline('p')).toBe(103_000 + graceMs);

    jest.setSystemTime(104_000);
    expect(await service.homeRenew('p', owned)).toEqual(records.get('p'));
    expect(deadline('p')).toBe(104_000 + graceMs);

    await service.onModuleDestroy();
    service = await startCoordinator();
    records.set('flipped', flipped);
    expect(deadline('p')).toBeUndefined();
    expect(deadline('flipped')).toBeUndefined();
    jest.setSystemTime(110_000);
    await service.status('p');
    await service.status('flipped');
    expect(deadline('p')).toBe(110_000 + graceMs);
    expect(deadline('flipped')).toBe(110_000 + graceMs);

    jest.setSystemTime(111_000);
    await service.status('p');
    expect(deadline('p')).toBe(110_000 + graceMs);
    await service.forget('p');
    expect(deadline('p')).toBeUndefined();
  });

  it.each([false, 'boot:11'])(
    'drops an exited or reused PID on the next one-second poll (%s)',
    async (identity) => {
      await service.acquireVmHold('p', hold);
      expect(records.get('p')?.vmHolds.hold).toMatchObject({
        pid: 123,
        processStartTime: 'boot:10',
      });
      service.onApplicationBootstrap();
      processes.read.mockResolvedValue(identity);
      await jest.advanceTimersByTimeAsync(1000);
      expect(records.get('p')?.vmHolds).toEqual({});
    },
  );

  it('keeps an unverifiable persisted hold and closes VM admission', async () => {
    await service.acquireVmHold('p', hold);
    processes.read.mockResolvedValue(null);
    const result = expect(service.withVmPermit('p', async () => 'unsafe')).rejects.toThrow(
      'cannot be verified',
    );
    await jest.advanceTimersByTimeAsync(90_000);
    await result;
    expect(records.get('p')?.vmHolds.hold.pid).toBe(123);
  });

  it('returns the forced reclaim notice only to the first admitted VM hold', async () => {
    records.set('p', {
      ...fresh(),
      forcedReclaim: { at: 100_000, fromGeneration: 0, homeName: 'my-PC' },
    });
    const first = await service.acquireVmHold('p', hold);
    expect(first.notice).toBe(
      "git: this VM took Git back from PC 'my-PC' at 1970-01-01T00:01:40.000Z. Files that the PC changed can show here as uncommitted changes. Do not commit them as your own work.",
    );
    await service.onModuleDestroy();
    service = await startCoordinator();

    const second = await service.acquireVmHold('p', { ...hold, holdId: 'next', pid: 124 });
    expect(second.notice).toBeUndefined();
  });

  it('refuses to release a live process or grant a mismatched process identity', async () => {
    await service.acquireVmHold('p', hold);
    await expect(service.releaseVmHold('p', hold)).rejects.toThrow('has not exited');
    await expect(
      service.acquireVmHold('p', { ...hold, processStartTime: 'boot:other' }),
    ).rejects.toThrow('cannot be verified');
    processes.read.mockResolvedValue(false);
    await service.releaseVmHold('p', hold);
    expect(records.get('p')?.vmHolds).toEqual({});
  });

  it.each(['write', 'checkpoint', 'sequencer', 'hold'])(
    'waits 90 seconds and names the PC and blocker (%s)',
    async (blocker) => {
      const record = home();
      if (blocker === 'write') record.homeWrites.write = 1;
      if (blocker === 'checkpoint') record.checkpoint = null;
      if (blocker === 'sequencer') indexes.sequencer.mockResolvedValue('MERGE_HEAD');
      if (blocker === 'hold')
        record.vmHolds.hold = { pid: 123, processStartTime: 'boot:10', startedAt: 1 };
      records.set('p', record);
      let error: unknown;
      const acquisition = service
        .withVmPermit('p', async () => 'unsafe')
        .catch((value: unknown) => {
          error = value;
        });
      await jest.advanceTimersByTimeAsync(89_999);
      expect(error).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await acquisition;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /my-PC.*(unconfirmed|checkpoint|middle of a merge|active)/,
      );
      expect((error as Error).message).not.toMatch(/[\r\n]/);
      expect(files.updateFolder).not.toHaveBeenCalled();
    },
  );

  it('journals reclaim and publishes VM ownership before admitting an operation', async () => {
    records.set('p', home());
    indexes.install.mockImplementation(async () => {
      expect(records.get('p')?.transition).toMatchObject({ kind: 'reclaim', phase: 'index' });
    });
    const value = await service.withVmPermit('p', async () => {
      expect(records.get('p')).toMatchObject({ owner: 'vm', generation: 1, transition: null });
      expect(service['homeLeaseDeadlines'].has('p')).toBe(false);
      return 'admitted';
    });
    expect(value).toBe('admitted');
    expect(files.updateFolder).toHaveBeenCalledWith('git:p', { type: 'sendonly' });
    expect(guard.remove).toHaveBeenCalledWith('p', { refreshIndex: false, failOnReadError: true });
  });

  it.each([
    ['connected PC', 'a home Git write is unconfirmed'],
    ['unexpired lease', 'a home Git write is unconfirmed'],
    ['live VM hold', 'VM Git processes are still active'],
    ['unknown VM hold', 'a persisted Git process cannot be verified'],
    ['sequencer in the baseline', 'Git there is in the middle of a merge'],
    ['different baseline digest', 'a home Git write is unconfirmed'],
    ['missing baseline metadata', 'a home Git write is unconfirmed'],
    ['missing baseline object', 'a home Git write is unconfirmed'],
    ['multiple configured peers', 'a home Git write is unconfirmed'],
    ['unavailable Syncthing', 'a home Git write is unconfirmed'],
    ['a ref store that the PC changed to reftable', 'a home Git write is unconfirmed'],
    ['a Git config that the VM cannot read', 'a home Git write is unconfirmed'],
  ])('rejects a forced reclaim with %s', async (blockedBy, reason) => {
    const record = pendingHome();
    if (blockedBy === 'a ref store that the PC changed to reftable') reftable();
    if (blockedBy === 'a Git config that the VM cannot read') unreadableConfig();
    if (blockedBy === 'connected PC') files.isConnected.mockResolvedValue(true);
    if (blockedBy === 'live VM hold' || blockedBy === 'unknown VM hold')
      record.vmHolds.hold = { ...hold, startedAt: 1 };
    if (blockedBy === 'unknown VM hold') processes.read.mockResolvedValue(null);
    if (blockedBy === 'sequencer in the baseline')
      indexes.readBaseline.mockResolvedValue({ ...baseline, sequencer: ['MERGE_HEAD'] });
    if (blockedBy === 'different baseline digest')
      indexes.readBaseline.mockResolvedValue({ ...baseline, refsDigest: 'different' });
    if (blockedBy === 'missing baseline metadata') delete record.baseline;
    if (blockedBy === 'missing baseline object')
      jest.mocked(missingBaselineObjects).mockResolvedValue(['a'.repeat(40)]);
    if (blockedBy === 'multiple configured peers')
      files.folderConfiguration.mockResolvedValue({
        devices: [{ deviceID: 'PC' }, { deviceID: 'OTHER' }],
      });
    if (blockedBy === 'unavailable Syncthing')
      files.isConnected.mockRejectedValue(new Error('offline API'));

    records.set('p', record);
    await service.status('p');
    // Keep the PC-connected and sequencer rows inside the grace window to check their message.
    if (!['unexpired lease', 'connected PC', 'sequencer in the baseline'].includes(blockedBy))
      jest.setSystemTime(400_000);
    const outcome = service
      .withVmPermit('p', async () => 'admitted')
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(90_000);
    const normalMessage = `Git is on PC 'my-PC': ${reason}.`;
    const takeBackTime = new Date(400_000).toTimeString().slice(0, 8);
    const retryMessage = ` This is temporary: this VM takes Git back at ${takeBackTime} (in 210 s) if the PC stays away. Wait until then and run the same command again. Do not stop your task.`;
    expect(await outcome).toMatchObject({
      code: 'GIT_VM_ACQUIRE_TIMEOUT',
      message: normalMessage + (blockedBy === 'unexpired lease' ? retryMessage : ''),
    });
    expect(files.updateFolder).not.toHaveBeenCalled();
    expect(records.get('p')?.transition).toBeNull();
  });

  it('journals supersession before changing direction and admits a waiting VM operation after expiry', async () => {
    records.set('p', {
      ...pendingHome(),
      generation: 3,
      transition: { kind: 'handover', id: 'active', phase: 'published', lease: 1 },
      supersededWrites: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [`write-${i}`, { generation: 0, at: i }]),
      ),
      supersededHandovers: Array.from({ length: 32 }, (_, i) => `handover-${i}`),
    });
    files.updateFolder.mockImplementation(async () => {
      const record = records.get('p');
      expect(record).toMatchObject({
        homeWrites: {},
        supersededWrites: { pending: { generation: 3, at: expect.any(Number) } },
        transition: { kind: 'reclaim', forced: true, phase: 'sending' },
      });
      expect(Object.keys(record?.supersededWrites ?? {})).toHaveLength(32);
      expect(record?.supersededWrites?.['write-0']).toBeUndefined();
      expect(record?.supersededHandovers).toEqual([
        ...Array.from({ length: 31 }, (_, i) => `handover-${i + 1}`),
        'active',
      ]);
    });
    await service.status('p');
    jest.setSystemTime(399_500);
    const operation = jest.fn(async () => 'admitted');
    const result = service.withVmPermit('p', operation);
    await jest.advanceTimersByTimeAsync(0);
    expect(operation).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('admitted');
    expect(records.get('p')).toMatchObject({ owner: 'vm', generation: 4, transition: null });
    expect(indexes.install).not.toHaveBeenCalled();
  });

  it.each(['sending', 'unguarding', 'rollback', 'publishing'] as const)(
    'resumes a forced reclaim from the journal in %s even with an unconfirmed sequencer marker',
    async (phase) => {
      records.set('p', {
        ...pendingHome(),
        homeWrites: {},
        transition: { kind: 'reclaim', id: 'forced', phase, forced: true, lease: null },
      });
      indexes.sequencer.mockResolvedValue('MERGE_HEAD');
      guard.remove.mockImplementation(async () => {
        expect(records.get('p')?.transition?.phase).toBe('unguarding');
        return { warning: null };
      });
      jest.mocked(restoreGitBaseline).mockImplementation(async () => {
        expect(records.get('p')?.transition?.phase).toBe(
          phase === 'publishing' ? phase : 'rollback',
        );
      });

      await service.poll();
      expect(restoreGitBaseline).toHaveBeenCalledWith(executor, '/project', baseline);
      expect(files.updateFolder).toHaveBeenCalledTimes(phase === 'sending' ? 1 : 0);
      expect(guard.remove).toHaveBeenCalledTimes(
        phase === 'sending' || phase === 'unguarding' ? 1 : 0,
      );
      expect(indexes.install).not.toHaveBeenCalled();
      expect(records.get('p')).toMatchObject({
        owner: 'vm',
        generation: 1,
        transition: null,
        forcedReclaim: { at: 100_000, fromGeneration: 0, homeName: 'my-PC' },
      });
    },
  );

  it.each(['a restore that fails', 'a ref store that changed to reftable'])(
    'keeps admission closed when a journaled rollback meets %s',
    async (failure) => {
      service = await startCoordinator({ acquireMs: 0 });
      records.set('p', {
        ...pendingHome(),
        transition: { kind: 'reclaim', id: 'forced', phase: 'rollback', forced: true, lease: null },
      });
      if (failure === 'a restore that fails')
        jest.mocked(restoreGitBaseline).mockRejectedValue(new Error('digest mismatch'));
      else reftable();
      await expect(service.withVmPermit('p', async () => 'admitted')).rejects.toMatchObject({
        code: 'GIT_VM_ACQUIRE_TIMEOUT',
        message: "Git is on PC 'my-PC': the VM could not return to the last confirmed Git state.",
      });
      expect(records.get('p')).toMatchObject({ owner: 'home', transition: { phase: 'rollback' } });
      expect(restoreGitBaseline).toHaveBeenCalledTimes(failure === 'a restore that fails' ? 1 : 0);
    },
  );

  it('keeps waiting when a reclaim step fails once, and resumes the journal on the next poll', async () => {
    records.set('p', home());
    files.updateFolder.mockRejectedValueOnce(new Error('Syncthing REST 503'));
    const value = service.withVmPermit('p', async () => 'admitted');
    await jest.advanceTimersByTimeAsync(1000);
    await expect(value).resolves.toBe('admitted');
    expect(files.updateFolder).toHaveBeenCalledTimes(2);
    expect(records.get('p')).toMatchObject({ owner: 'vm', generation: 1, transition: null });
  });

  it('blocks new holds during a leased handover, then cleans the guard before admitting them', async () => {
    await service.beginHandover('p', { ...fence, id: 'handover', homeName: 'my-PC' });
    const acquisition = service.acquireVmHold('p', hold);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(records.get('p')?.vmHolds).toEqual({});
    guard.remove.mockImplementation(async () => {
      expect(records.get('p')?.transition?.id).toBe('handover');
      return { warning: null };
    });
    await jest.advanceTimersByTimeAsync(1);
    expect((await acquisition).transition).toBeNull();
    expect(records.get('p')?.vmHolds.hold.pid).toBe(123);
  });

  it('retries an existing hold and handover without creating a new admission', async () => {
    await service.acquireVmHold('p', hold);
    const request = { ...fence, id: 'handover', homeName: 'my-PC' };
    await service.beginHandover('p', request);
    expect((await service.beginHandover('p', request)).transition?.id).toBe('handover');
    expect((await service.acquireVmHold('p', hold)).vmHolds.hold.startedAt).toBe(100_000);
  });

  it('keeps polling other projects while one project has a long permit', async () => {
    records.set('other', {
      ...fresh(),
      vmHolds: { hold: { pid: 123, processStartTime: 'boot:10', startedAt: 1 } },
    });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = service.withVmPermit('p', () => blocked);
    service.onApplicationBootstrap();
    processes.read.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(2000);
    expect(records.get('other')?.vmHolds).toEqual({});
    finish();
    await operation;
  });

  it('renews the pre-flip lease and keeps admission closed if abort cleanup fails', async () => {
    await service.beginHandover('p', { ...fence, id: 'handover', homeName: 'my-PC' });
    await jest.advanceTimersByTimeAsync(10_000);
    const transitionFence = { expectedGeneration: 0, transitionId: 'handover' };
    await service.renewHandover('p', transitionFence);
    await jest.advanceTimersByTimeAsync(6000);
    expect((await service.status('p')).transition).toMatchObject({ lease: 125_000 });
    guard.remove.mockRejectedValue(new Error('guard unreadable'));
    await jest.advanceTimersByTimeAsync(9000);
    await expect(service.status('p')).rejects.toThrow('guard unreadable');
    expect(records.get('p')?.transition?.id).toBe('handover');
    guard.remove.mockResolvedValue({ warning: null });
    expect((await service.status('p')).transition).toBeNull();
  });

  it('never aborts a post-flip handover by lease expiry', async () => {
    records.set('p', {
      ...fresh(),
      transition: { kind: 'handover', id: 'h', phase: 'vm-receiving', lease: 0 },
    });
    await expect(
      service.abortHandover('p', { expectedGeneration: 0, transitionId: 'h' }),
    ).rejects.toThrow('finish forward');
    expect((await service.status('p')).transition?.phase).toBe('vm-receiving');
    expect(guard.remove).not.toHaveBeenCalled();
  });

  it('fences both generation and transition before any host Git effect', async () => {
    records.set('p', { ...fresh(), generation: 4 });
    const effect = jest.fn().mockResolvedValue('unsafe');
    await expect(service.withHostMutation('p', fence, effect)).rejects.toThrow('changed');
    await expect(
      service.withHostMutation('p', { expectedGeneration: 4, transitionId: 'old' }, effect),
    ).rejects.toThrow('changed');
    expect(effect).not.toHaveBeenCalled();
    expect(
      await service.withHostMutation(
        'p',
        { expectedGeneration: 4, transitionId: null },
        async () => 'current',
      ),
    ).toBe('current');
  });

  it('serializes the generation check with the entire host operation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = service.withHostMutation('p', fence, async () => {
      await pending;
      records.set('p', { ...fresh(), generation: 1 });
    });
    const second = expect(
      service.withHostMutation('p', fence, async () => 'unsafe'),
    ).rejects.toThrow('changed');
    finish();
    await first;
    await second;
  });

  it.each(['home', 'hold', 'transition', 'idle'])(
    'only runs foreground VM gc when idle (%s)',
    async (state) => {
      const record = state === 'home' ? home() : fresh();
      if (state === 'hold')
        record.vmHolds.hold = { pid: 123, processStartTime: 'boot:10', startedAt: 1 };
      if (state === 'transition')
        record.transition = { kind: 'handover', id: 'h', phase: 'draining', lease: 200_000 };
      records.set('p', record);
      expect(await service.idleGc('p')).toBe(state === 'idle');
      if (state === 'idle')
        expect(executor.run).toHaveBeenCalledWith(
          expect.objectContaining({ argv: ['git', '-c', 'gc.autoDetach=false', 'gc', '--auto'] }),
        );
      else expect(executor.run).not.toHaveBeenCalled();
    },
  );

  it('admits nothing new while a Disconnect has closed Git, then admits again after reopen', async () => {
    records.set('p', home());
    await service.close('p');
    for (const attempt of [
      () => service.withVmPermit('p', async () => 'unsafe'),
      () => service.homeWriteBegin('p', { ...fence, writeId: 'write', homeName: 'my-PC' }),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'GIT_PROJECT_DISCONNECTING' });
    expect(records.get('p')).toMatchObject({ owner: 'home', generation: 0, closed: true });
    await service.reopen('p');
    expect(
      (await service.homeWriteBegin('p', { ...fence, writeId: 'write', homeName: 'my-PC' }))
        .homeWrites.write,
    ).toEqual(expect.any(Number));
  });

  it('refuses a handover while closed and starts a forgotten project VM-owned at generation 0', async () => {
    records.set('p', { ...home(), generation: 4 });
    await service.forget('p');
    expect(records.has('p')).toBe(false);
    await service.close('p');
    await expect(
      service.beginHandover('p', { ...fence, id: 'handover', homeName: 'my-PC' }),
    ).rejects.toMatchObject({ code: 'GIT_PROJECT_DISCONNECTING' });
    expect(records.get('p')).toMatchObject({ owner: 'vm', generation: 0, transition: null });
  });
});
