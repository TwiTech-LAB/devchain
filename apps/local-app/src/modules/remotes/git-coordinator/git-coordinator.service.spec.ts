import { Test } from '@nestjs/testing';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import {
  GitCoordinatorService,
  GIT_COORDINATOR_TIMINGS,
  DEFAULT_GIT_COORDINATOR_TIMINGS,
} from './git-coordinator.service';
import { GitCoordinatorStore } from './git-coordinator.store';
import { GitCoordinatorIndexService } from './git-coordinator-index.service';
import { GitProcessIdentity } from './git-process-identity';
import type { GitCoordinatorRecord, GitFence } from './git-coordinator.dto';

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

describe('GitCoordinatorService admission', () => {
  let service: GitCoordinatorService;
  let records: Map<string, GitCoordinatorRecord>;
  const files = { folderPath: jest.fn(), updateFolder: jest.fn() };
  const guard = { remove: jest.fn() };
  const indexes = {
    sequencer: jest.fn(),
    save: jest.fn(),
    install: jest.fn(),
    cleanup: jest.fn(),
    worktreeBranches: jest.fn(),
  };
  const processes = { read: jest.fn() };
  const executor = { run: jest.fn() };

  beforeEach(async () => {
    jest.useFakeTimers({ now: 100_000 });
    jest.resetAllMocks();
    records = new Map([['p', fresh()]]);
    files.folderPath.mockResolvedValue('/project');
    guard.remove.mockResolvedValue({ removed: true, warning: null });
    indexes.sequencer.mockResolvedValue(null);
    indexes.worktreeBranches.mockResolvedValue([]);
    processes.read.mockResolvedValue('boot:10');
    executor.run.mockResolvedValue({ success: true });
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
          useValue: { ...DEFAULT_GIT_COORDINATOR_TIMINGS, gcMs: Infinity },
        },
      ],
    }).compile();
    service = module.get(GitCoordinatorService);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
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
      return 'admitted';
    });
    expect(value).toBe('admitted');
    expect(files.updateFolder).toHaveBeenCalledWith('git:p', { type: 'sendonly' });
    expect(guard.remove).toHaveBeenCalledWith('p', { refreshIndex: false, failOnReadError: true });
  });

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
