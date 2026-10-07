import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import type { GitOwner } from '../git-owner.store';
import { join } from 'node:path';
import {
  InvalidManagedExclusionsError,
  type FileSyncManagedExclusionsStore,
} from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService, FileSyncUnavailableError } from '../../file-sync/file-sync.service';
import type { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FileSyncHandoff } from './file-sync-handoff';
import { RemoteHostRequestError, type RemoteHostClient } from './remote-host.client';
import type { RemoteOperationStepRun } from './remote-operation.types';

const operation = { id: 'op-1', remoteId: 'r1', projectId: 'p1' } as RemoteOperation;

/** In-memory stand-in mirroring the store's empty-selection-clears contract. */
class FakeManagedExclusionsStore {
  readonly projects = new Map<string, string[]>();

  get(projectId: string): string[] {
    return this.projects.get(projectId) ?? [];
  }

  set(projectId: string, patterns: string[] | null): string[] {
    if (patterns === null || patterns.length === 0) this.projects.delete(projectId);
    else this.projects.set(projectId, patterns);
    return this.get(projectId);
  }
}

function setup(git = false) {
  const home = new FakeFileSyncService();
  const peer = new FakeFileSyncService();
  if (git) home.gitProjects.add('p1');
  const guard = {
    install: jest.fn(async (): Promise<string | null> => null),
    remove: jest.fn(async () => ({ removed: false, indexRefreshed: null, warning: null })),
    reinstall: jest.fn(async (): Promise<string | null> => null),
  };
  const managed = new FakeManagedExclusionsStore();
  const calls: string[] = [];
  const host = {
    syncFolderExists: jest.fn(async (_r: string, id: string) => peer.folders.has(id)),
    syncRemoteNeed: jest.fn(async (_r: string, id: string, device: string) =>
      peer.remoteNeed(id, device),
    ),
    removeGitGuard: jest.fn(async () => ({ removed: false })),
    installGitGuard: jest.fn(async (): Promise<{ warning: string | null }> => ({ warning: null })),
    syncDevice: jest.fn(async () => peer.device()),
    syncPeer: jest.fn(async (_r: string, device: { deviceId: string }) => {
      await peer.addPeer({ deviceId: device.deviceId, address: 'tcp://home:22000' });
    }),
    syncFolders: jest.fn(async (_r: string, request) => peer.ensureFolder(request)),
    syncForceCopyBackup: jest.fn(async (_r: string, request) => peer.forceCopyBackup(request)),
    syncFolderType: jest.fn(async (_r: string, id: string, patch) => {
      calls.push(`host ${id} ${JSON.stringify(patch)}`);
      await peer.updateFolder(id, patch);
    }),
    syncStatus: jest.fn(async (_r: string, id: string, device?: string) => peer.status(id, device)),
    syncFolderConfiguration: jest.fn(async (_r: string, id: string) =>
      peer.folderConfiguration(id),
    ),
    syncScan: jest.fn(async (_r: string, _id: string): Promise<void> => undefined),
    syncRevert: jest.fn(async (_r: string, id: string) => peer.revertLocalChanges(id)),
    syncOverride: jest.fn(async (_r: string, id: string) => peer.override(id)),
    syncLocalChanges: jest.fn(async (_r: string, id: string) => peer.localChanges(id)),
    syncRemoveFolder: jest.fn(async (_r: string, id: string) => peer.removeFolder(id)),
  };
  const update = home.updateFolder.bind(home);
  const owner = { value: 'vm' as GitOwner };
  jest.spyOn(home, 'updateFolder').mockImplementation(async (id, patch) => {
    calls.push(`home ${id} ${JSON.stringify(patch)}`);
    await update(id, patch);
  });
  const handoff = new FileSyncHandoff(
    home as unknown as FileSyncService,
    host as unknown as RemoteHostClient,
    managed as unknown as FileSyncManagedExclusionsStore,
    guard as unknown as HomeGitGuardService,
    new FakeProcessExecutor(),
    { get: () => owner.value } as never,
  );
  const reports: Record<string, unknown>[] = [];
  const run: RemoteOperationStepRun = {
    operation,
    details: {},
    progress: async (patch) => {
      Object.assign(run.details, patch);
      reports.push(patch);
    },
  };
  return { home, peer, host, handoff, run, calls, reports, managed, guard, owner };
}

describe('FileSyncHandoff', () => {
  // Injected statuses and fake timers exercise the unsafe boundary without a daemon.
  it.each(['files', 'directories', 'sender busy', 'receiver busy'] as const)(
    'does not Revert during reset until the barrier holds (%s)',
    async (gap) => {
      jest.useFakeTimers();
      try {
        const { home, peer, host, handoff, run } = setup();
        let ready = false;
        const homeStatus = home.status.bind(home);
        jest.spyOn(home, 'status').mockImplementation(async (id, device) => ({
          ...(await homeStatus(id, device)),
          ...(!ready && gap === 'sender busy' && { state: 'scanning' }),
        }));
        host.syncStatus.mockImplementation(async (_r, id, device) => ({
          ...(await peer.status(id, device)),
          receiveOnlyChangedFiles: 1,
          ...(!ready && gap === 'files' && { globalFiles: 0 }),
          ...(!ready && gap === 'directories' && { globalDirectories: 0 }),
          ...(!ready && gap === 'receiver busy' && { state: 'scanning' }),
        }));
        const copy = handoff.initial(run, 'p1');
        await jest.advanceTimersByTimeAsync(0);
        expect(host.syncStatus).toHaveBeenCalled();
        expect(host.syncRevert).not.toHaveBeenCalled();
        ready = true;
        await jest.advanceTimersByTimeAsync(10);
        await copy;
        expect(host.syncRevert).toHaveBeenCalledWith('r1', 'code:p1');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  // The in-memory service retains actual records; spies cover only durable/network boundaries.
  it.each(['home', 'vm'] as const)(
    'rebuilds both kinds from %s, recording backups and replacements before destructive effects',
    async (source) => {
      const { home, peer, host, handoff, run, managed, guard } = setup();
      const loser = source === 'home' ? peer : home;
      const winner = source === 'home' ? home : peer;
      run.details.forceSync = { source, kinds: ['code', 'git'], custom: 'preserved' };
      managed.set('p1', ['(?d)/generated']);
      home.setIgnores('p1', ['(?d)/logs']);
      loser.receiveOnlyChanges.set('code:p1', {
        count: 201,
        sample: Array.from({ length: 200 }, (_, i) => `code-${i}`),
      });
      loser.receiveOnlyChanges.set('git:p1', { count: 2, sample: ['HEAD', 'refs/heads/main'] });
      const progress = run.progress;
      run.progress = jest.fn(async (patch, options) => {
        if (patch.forceSync) expect(options).toEqual({ durable: true });
        await progress(patch);
      });
      const remove = home.removeFolder.bind(home);
      jest.spyOn(home, 'removeFolder').mockImplementation(async (id) => {
        expect(run.details.forceSync).toMatchObject({
          verified: false,
          backups: [
            {
              side: source === 'home' ? 'vm' : 'home',
              kind: 'code',
              path: expect.stringContaining('/op-1/code'),
            },
            {
              side: source === 'home' ? 'vm' : 'home',
              kind: 'git',
              path: expect.stringContaining('/op-1/git'),
            },
          ],
        });
        expect(guard.remove).toHaveBeenCalledWith('p1', { refreshIndex: false });
        expect(host.removeGitGuard).toHaveBeenCalledWith('r1', 'p1');
        await remove(id);
      });
      const revert = loser.revertLocalChanges.bind(loser);
      jest.spyOn(loser, 'revertLocalChanges').mockImplementation(async (id) => {
        expect(run.details.forceSync).toMatchObject({
          replaced: { count: 203, sample: expect.arrayContaining(['code-0']) },
        });
        expect(source === 'home' ? home.override : host.syncOverride).toHaveBeenCalled();
        await revert(id);
      });
      jest.spyOn(home, 'override');
      const initialFolders = jest.spyOn(home, 'initialFolders');
      await handoff.forceCopy(run, 'p1', source, ['code', 'git']);
      expect(initialFolders).not.toHaveBeenCalled();
      expect(run.details.forceSync).toMatchObject({
        source,
        custom: 'preserved',
        verified: true,
        replaced: { count: 203 },
      });
      expect(
        (run.details.forceSync as { replaced: { sample: string[] } }).replaced.sample,
      ).toHaveLength(200);
      for (const kind of ['code', 'git']) {
        expect(winner.folders.get(`${kind}:p1`)).toMatchObject({ type: 'sendonly', paused: false });
        expect(winner.folders.get(`${kind}:p1`)?.backupPath).toBeUndefined();
        expect(loser.folders.get(`${kind}:p1`)).toMatchObject({
          type: 'receiveonly',
          paused: false,
          backupPath: expect.stringContaining(`/op-1/${kind}`),
        });
        expect(winner.folders.get(`${kind}:p1`)?.ignores).toEqual(
          kind === 'code' ? ['/.git', '(?d)/generated', '(?d)/logs'] : ['*.lock'],
        );
      }
    },
  );

  it('waits for the source index before Override in a force copy', async () => {
    jest.useFakeTimers();
    try {
      const { home, peer, host, handoff, run } = setup();
      let indexed = false;
      host.syncStatus.mockImplementation(async (_r, id, device) => ({
        ...(await peer.status(id, device)),
        globalFiles: indexed ? 1 : 0,
      }));
      const override = jest.spyOn(home, 'override');
      const copy = handoff.forceCopy(run, 'p1', 'home', ['code']);
      await jest.advanceTimersByTimeAsync(0);
      expect(host.syncStatus).toHaveBeenCalled();
      expect(override).not.toHaveBeenCalled();
      expect(host.syncRevert).not.toHaveBeenCalled();
      indexed = true;
      await jest.advanceTimersByTimeAsync(500);
      await copy;
      expect(override).toHaveBeenCalledWith('code:p1');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['backups', 'replaced'] as const)(
    'fails a durable %s checkpoint before its destructive effects',
    async (checkpoint) => {
      const { home, host, handoff, run, guard } = setup();
      const remove = jest.spyOn(home, 'removeFolder');
      const progress = run.progress;
      run.progress = async (patch, options) => {
        if (patch.forceSync && checkpoint in (patch.forceSync as object)) {
          expect(options).toEqual({ durable: true });
          throw new Error('details unavailable');
        }
        await progress(patch);
      };
      await expect(handoff.forceCopy(run, 'p1', 'home', ['code'])).rejects.toThrow(
        'details unavailable',
      );
      if (checkpoint === 'backups') {
        expect(remove).not.toHaveBeenCalled();
        expect(host.syncRemoveFolder).not.toHaveBeenCalled();
        expect(guard.remove).not.toHaveBeenCalled();
      }
      expect(host.syncRevert).not.toHaveBeenCalled();
    },
  );

  it('repeats the entire rebuild on Retry and tolerates missing records', async () => {
    const { home, host, handoff, run } = setup();
    const remove = jest.spyOn(home, 'removeFolder');
    host.syncRemoveFolder.mockRejectedValueOnce(
      new RemoteHostRequestError('missing', {
        remoteId: 'r1',
        path: '/folders',
        status: 404,
        hostCode: null,
      }),
    );
    host.syncOverride.mockRejectedValueOnce(new Error('lost answer'));
    await expect(handoff.forceCopy(run, 'p1', 'vm', ['code'])).rejects.toThrow('lost answer');
    expect(run.details.forceSync).toMatchObject({ verified: false });
    await handoff.forceCopy(run, 'p1', 'vm', ['code']);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(host.syncRemoveFolder).toHaveBeenCalledTimes(2);
    expect(host.syncScan).toHaveBeenCalledTimes(3);
    expect(run.details.forceSync).toMatchObject({ verified: true });
  });

  // One failed folder must stop the other before the step fails, or its Revert overlaps Retry.
  it('drains every folder before a failed force copy returns', async () => {
    const { home, host, handoff, run } = setup();
    home.receiveOnlyChanges.set('code:p1', { count: 1, sample: ['loser-only.txt'] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let statusHeld!: () => void;
    const holding = new Promise<void>((resolve) => (statusHeld = resolve));
    const scans = new Map<string, number>();
    host.syncScan.mockImplementation(async (_r: string, id: string) => {
      scans.set(id, (scans.get(id) ?? 0) + 1);
      if (id !== 'git:p1' || scans.get(id) !== 2) return;
      await holding;
      throw new Error('lost git scan answer');
    });
    const status = home.status.bind(home);
    let heldOnce = false;
    jest.spyOn(home, 'status').mockImplementation(async (id, device, options) => {
      const value = await status(id, device, options);
      // The code receiver poll inside the wait, after its second scan.
      if (id === 'code:p1' && !options && scans.get('code:p1') === 2 && !heldOnce) {
        heldOnce = true;
        statusHeld();
        await held;
      }
      return value;
    });
    const revert = jest.spyOn(home, 'revertLocalChanges');
    let settled = false;
    const copy = handoff.forceCopy(run, 'p1', 'vm', ['code', 'git']).finally(() => {
      settled = true;
    });
    await holding;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(copy).rejects.toThrow();
    expect(revert).not.toHaveBeenCalled();
    expect(run.details.forceSync).toMatchObject({ verified: false });
  });

  // A Revert already sent cannot be stopped; its poll must still end before the step fails.
  it('waits for a Revert in flight when the same poll loses its sender read', async () => {
    const { home, host, handoff, run } = setup();
    home.receiveOnlyChanges.set('code:p1', { count: 1, sample: ['loser-only.txt'] });
    let reverting!: () => void;
    const revertStarted = new Promise<void>((resolve) => (reverting = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const scans = new Map<string, number>();
    host.syncScan.mockImplementation(async (_r: string, id: string) => {
      scans.set(id, (scans.get(id) ?? 0) + 1);
      if (id !== 'git:p1' || scans.get(id) !== 2) return;
      await revertStarted;
      throw new Error('lost git scan answer');
    });
    const status = host.syncStatus.getMockImplementation()!;
    let senderFailed = false;
    host.syncStatus.mockImplementation(async (r: string, id: string, device?: string) => {
      // The code sender read inside the wait; it fails after the Git lane has failed.
      if (id === 'code:p1' && device && scans.get('code:p1') === 2 && !senderFailed) {
        senderFailed = true;
        await revertStarted;
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('lost sender status');
      }
      return status(r, id, device);
    });
    const revert = home.revertLocalChanges.bind(home);
    jest.spyOn(home, 'revertLocalChanges').mockImplementation(async (id) => {
      events.push('revert started');
      reverting();
      await held;
      await revert(id);
      events.push('revert completed');
    });
    let settled = false;
    const copy = handoff.forceCopy(run, 'p1', 'vm', ['code', 'git']).finally(() => {
      settled = true;
      events.push('force copy ended');
    });
    await revertStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(senderFailed).toBe(true);
    expect(settled).toBe(false);
    release();
    await expect(copy).rejects.toThrow();
    expect(events).toEqual(['revert started', 'revert completed', 'force copy ended']);
  });

  it('keeps the earlier replacement report when Retry finds the loser converged', async () => {
    const { home, handoff, run } = setup();
    home.receiveOnlyChanges.set('code:p1', { count: 2, sample: ['a.txt', 'b.txt'] });
    const status = home.status.bind(home);
    let finalReads = 0;
    jest.spyOn(home, 'status').mockImplementation(async (id, device, options) => {
      if (options?.allErrors && ++finalReads === 1) throw new Error('lost final status');
      return status(id, device, options);
    });
    await expect(handoff.forceCopy(run, 'p1', 'vm', ['code'])).rejects.toThrow('lost final status');
    expect(home.receiveOnlyChanges.has('code:p1')).toBe(false);
    await handoff.forceCopy(run, 'p1', 'vm', ['code']);
    expect(run.details.forceSync).toMatchObject({
      verified: true,
      replaced: { count: 2, sample: ['a.txt', 'b.txt'] },
    });
  });

  it.each([
    'receiver files',
    'sender files',
    'folder error',
    'receive-only changes',
    'incomplete',
    'other folder fails',
    'transient',
  ] as const)('checks %s after the force-copy wait', async (failure) => {
    const { home, peer, host, handoff, run } = setup();
    let afterWait = false;
    const wait = home.waitForComplete.bind(home);
    jest.spyOn(home, 'waitForComplete').mockImplementation(async (id, options) => {
      const result = await wait(id, options);
      afterWait = true;
      return result;
    });
    const failures = Array.from({ length: 4 }, (_, i) => ({
      path: `failed-${i}`,
      error: 'disk full',
    }));
    host.syncStatus.mockImplementation(async (_r, id, device) => ({
      ...(await peer.status(id, device)),
      ...(afterWait && failure === 'receiver files' && { errors: 4, fileErrors: failures }),
      ...(afterWait && failure === 'folder error' && { error: 'folder path missing' }),
      ...(afterWait && failure === 'receive-only changes' && { receiveOnlyChangedFiles: 1 }),
      ...(afterWait && failure === 'incomplete' && { localFiles: 0 }),
      ...(afterWait && failure === 'other folder fails' && id === 'code:p1' && { localFiles: 0 }),
      ...(afterWait &&
        failure === 'other folder fails' &&
        id === 'git:p1' && { errors: 4, fileErrors: failures }),
      ...(afterWait &&
        failure === 'transient' && {
          errors: 1,
          fileErrors: [
            { path: 'changing', error: 'file modified but not rescanned; will try again later' },
          ],
        }),
    }));
    const status = home.status.bind(home);
    jest.spyOn(home, 'status').mockImplementation(async (id, device) => ({
      ...(await status(id, device)),
      ...(afterWait && failure === 'sender files' && { errors: 4, fileErrors: failures }),
    }));
    const copy = handoff.forceCopy(
      run,
      'p1',
      'home',
      failure === 'other folder fails' ? ['code', 'git'] : ['code'],
    );
    if (failure === 'transient') {
      await copy;
      expect(run.details.forceSync).toMatchObject({ verified: true });
    } else {
      const error = await copy.catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'FORCE_SYNC_INCOMPLETE' });
      if (failure === 'receiver files' || failure === 'other folder fails') {
        expect((error as Error).message).toContain('failed-2: disk full');
        expect((error as Error).message).not.toContain('failed-3');
      }
      expect(run.details.forceSync).toMatchObject({ verified: false });
    }
  });

  it.each(['home', 'vm'] as const)(
    're-creates missing connected records after a verified copy from %s',
    async (source) => {
      const { home, peer, handoff, run, guard } = setup();
      await expect(handoff.restoreConnected(run, 'p1', ['code', 'git'])).rejects.toMatchObject({
        code: 'FORCE_SYNC_NOT_VERIFIED',
      });
      await handoff.forceCopy(run, 'p1', source, ['code', 'git']);
      home.folders.clear();
      peer.folders.clear();
      guard.install.mockResolvedValueOnce('guard unsupported');
      await handoff.restoreConnected(run, 'p1', ['code', 'git']);
      for (const side of [home, peer]) {
        expect(side.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
        expect(side.folders.get('git:p1')).toMatchObject({
          type: side === home ? 'receiveonly' : 'sendonly',
          paused: false,
          ignores: ['*.lock', '/hooks', '/index'],
        });
        for (const folder of side.folders.values()) expect(folder.backupPath).toBeUndefined();
      }
      expect(run.details.guardWarning).toBe('guard unsupported');
    },
  );

  it('excludes saved home/VM conflicts, counts an old-mtime new copy and reuses the baseline after transfer Retry', async () => {
    const { home, peer, host, handoff, run } = setup();
    record(home, 'sendonly');
    record(peer, 'receiveonly');
    const root = mkdtempSync(join(tmpdir(), 'devchain-merge-baseline-'));
    const homeOld = 'home.sync-conflict-old.txt';
    const vmOld = 'vm.sync-conflict-old.txt';
    const newCopy = 'new.sync-conflict-local-time.txt';
    try {
      home.codeRoots.set('p1', root);
      writeFileSync(join(root, homeOld), 'before Connect');
      peer.remoteNeeds.set('code:p1', {
        total: 2,
        deleted: 0,
        sample: [],
        conflictPaths: [vmOld],
        conflictsOverCap: false,
      });
      const baseline = jest.spyOn(home, 'conflictBaseline');
      const complete = home.waitForComplete.bind(home);
      jest.spyOn(home, 'waitForComplete').mockImplementation(async (id, options) => {
        expect(run.details.fileSyncConflictBaseline).toEqual({
          baselineOverCap: false,
          paths: expect.arrayContaining([homeOld, vmOld]),
        });
        for (const name of [vmOld, newCopy]) {
          writeFileSync(join(root, name), 'transferred');
          utimesSync(join(root, name), 1, 1);
        }
        return complete(id, options);
      });
      const conflicts = jest
        .spyOn(home, 'conflicts')
        .mockRejectedValueOnce(new Error('after transfer'));
      await expect(handoff.initial(run, 'p1')).rejects.toThrow('after transfer');
      const retry: RemoteOperationStepRun = {
        ...run,
        details: structuredClone(run.details),
        progress: async (patch) => void Object.assign(retry.details, patch),
      };
      await handoff.initial(retry, 'p1');
      expect(retry.details.fileSyncConflicts).toEqual({ total: 1, sample: [newCopy] });
      expect(baseline).toHaveBeenCalledTimes(1);
      expect(host.syncRemoteNeed).toHaveBeenCalledTimes(1);
      expect(conflicts).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['home', 'VM', 'union', 'overlap'] as const)(
    'records a complete or over-cap %s baseline without truncation',
    async (source) => {
      const { home, peer, handoff, run } = setup();
      record(home, 'sendonly');
      record(peer, 'receiveonly');
      jest.spyOn(home, 'conflictBaseline').mockResolvedValue(
        source === 'home'
          ? { baselineOverCap: true }
          : {
              baselineOverCap: false,
              paths:
                source === 'union' || source === 'overlap'
                  ? Array.from({ length: 600 }, (_, index) => `home-${index}`)
                  : [],
            },
      );
      peer.remoteNeeds.set('code:p1', {
        total: 0,
        deleted: 0,
        sample: [],
        conflictPaths:
          source === 'union' || source === 'overlap'
            ? Array.from(
                { length: 600 },
                (_, index) => `${source === 'overlap' ? 'home' : 'vm'}-${index}`,
              )
            : [],
        conflictsOverCap: source === 'VM',
      });
      await handoff.initial(run, 'p1');
      if (source === 'overlap') {
        expect(run.details.fileSyncConflictBaseline).toMatchObject({ baselineOverCap: false });
        expect((run.details.fileSyncConflictBaseline as { paths: string[] }).paths).toHaveLength(
          600,
        );
      } else {
        expect(run.details.fileSyncConflictBaseline).toEqual({ baselineOverCap: true });
        expect(run.details.fileSyncConflicts).toMatchObject({ baselineOverCap: true });
      }
    },
  );

  function record(side: FakeFileSyncService, type: 'sendonly' | 'receiveonly') {
    side.folders.set('code:p1', { type, paused: true, peerDeviceId: 'peer', ignores: [] });
  }

  it.each([
    [false, false, 'reset'],
    [true, false, 'reset'],
    [false, true, 'reset'],
    [true, true, 'merge'],
  ] as const)(
    'selects %s/%s pre-existing records as %s, before changing folders',
    async (homeExists, hostExists, mode) => {
      const { home, peer, host, handoff, run } = setup();
      if (homeExists) record(home, 'sendonly');
      if (hostExists) record(peer, 'receiveonly');
      const progress = run.progress;
      run.progress = jest.fn(async (patch, options) => {
        if (patch.fileSyncMode) {
          expect(options).toEqual({ durable: true });
          expect(host.syncFolders).not.toHaveBeenCalled();
          expect(home.folders.has('code:p1')).toBe(homeExists);
          expect(peer.folders.has('code:p1')).toBe(hostExists);
        }
        await progress(patch);
      });
      const wait = jest.spyOn(home, 'waitForComplete');
      await handoff.initial(run, 'p1');
      expect(run.details.fileSyncMode).toBe(mode);
      expect(home.folders.get('code:p1')?.type).toBe(mode === 'merge' ? 'sendreceive' : 'sendonly');
      expect(peer.folders.get('code:p1')?.type).toBe(
        mode === 'merge' ? 'sendreceive' : 'receiveonly',
      );
      expect(wait).toHaveBeenCalledWith(
        'code:p1',
        expect.objectContaining({ symmetric: mode === 'merge' }),
      );
    },
  );

  it('fails existence errors without saving a mode or changing folders', async () => {
    const { home, host, handoff, run } = setup();
    host.syncFolderExists.mockRejectedValueOnce(new Error('host status 502'));
    const ensure = jest.spyOn(home, 'ensureFolder');
    await expect(handoff.initial(run, 'p1')).rejects.toThrow('host status 502');
    expect(run.details.fileSyncMode).toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
    expect(host.syncFolders).not.toHaveBeenCalled();
  });

  it.each(['merge', 'reset'] as const)(
    'reverts only receive-only folders in initial %s mode',
    async (mode) => {
      const { home, peer, host, handoff, run } = setup(true);
      if (mode === 'merge') {
        record(home, 'sendonly');
        record(peer, 'receiveonly');
      }
      host.syncStatus.mockImplementation(async (_remote, id, device) => ({
        ...(await peer.status(id, device)),
        receiveOnlyChangedFiles: 1,
      }));
      await handoff.initial(run, 'p1');
      expect(host.syncRevert.mock.calls.map((call) => call[1]).sort()).toEqual(
        mode === 'merge' ? ['git:p1'] : ['code:p1', 'git:p1'],
      );
    },
  );

  it.each(['mode', 'vmEdits'] as const)(
    'fails the %s checkpoint before its folder effects',
    async (checkpoint) => {
      const { home, peer, host, handoff, run } = setup();
      record(home, 'sendonly');
      record(peer, 'receiveonly');
      const progress = run.progress;
      run.progress = jest.fn(async (patch, options) => {
        if (patch[checkpoint === 'mode' ? 'fileSyncMode' : 'vmEdits']) {
          expect(options).toEqual({ durable: true });
          throw new Error('details storage failed');
        }
        await progress(patch);
      });
      const ensure = jest.spyOn(home, 'ensureFolder');
      await expect(handoff.initial(run, 'p1')).rejects.toThrow('details storage failed');
      expect(ensure).not.toHaveBeenCalled();
      expect(home.folders.get('code:p1')).toMatchObject({ type: 'sendonly', paused: true });
      if (checkpoint === 'mode') expect(host.syncFolders).not.toHaveBeenCalled();
      else expect(host.syncRemoteNeed).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['scan', 'after transfer'] as const)(
    'Retry after %s reuses mode and the original VM-edit report',
    async (failure) => {
      const { home, peer, host, handoff, run } = setup(true);
      record(home, 'sendonly');
      record(peer, 'receiveonly');
      const report = {
        total: 3,
        deleted: 1,
        sample: [{ path: 'gone.txt', deleted: true }],
        conflictPaths: [],
        conflictsOverCap: false,
      };
      peer.remoteNeeds.set('code:p1', report);
      host.syncScan.mockImplementationOnce(async () => {
        expect(peer.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
        expect(home.folders.get('code:p1')).toMatchObject({ type: 'sendonly', paused: true });
        if (failure === 'scan') throw new Error('after VM scan');
      });
      const need = host.syncRemoteNeed.getMockImplementation()!;
      host.syncRemoteNeed.mockImplementation(async (...args) => {
        expect(home.folders.get('code:p1')?.paused).toBe(true);
        expect(host.syncScan).toHaveBeenCalled();
        return need(...args);
      });
      const conflicts = jest.spyOn(home, 'conflicts');
      if (failure === 'after transfer')
        conflicts.mockRejectedValueOnce(new Error('conflict walk failed'));
      await expect(handoff.initial(run, 'p1')).rejects.toThrow(
        failure === 'scan' ? 'after VM scan' : 'conflict walk failed',
      );
      expect(run.details.fileSyncMode).toBe('merge');
      const baseline = run.details.fileSyncConflictBaseline;
      host.syncFolderExists.mockRejectedValue(new Error('must not reselect'));
      if (failure === 'after transfer')
        peer.remoteNeeds.set('code:p1', {
          total: 0,
          deleted: 0,
          sample: [],
          conflictPaths: [],
          conflictsOverCap: false,
        });
      const retryRun: RemoteOperationStepRun = {
        ...run,
        details: structuredClone(run.details),
        progress: async (patch) => void Object.assign(retryRun.details, patch),
      };
      await handoff.initial(retryRun, 'p1');
      expect(retryRun.details.vmEdits).toEqual(report);
      expect(retryRun.details.fileSyncConflictBaseline).toEqual(
        baseline ?? { baselineOverCap: false, paths: [] },
      );
      expect(host.syncFolderExists).toHaveBeenCalledTimes(1);
      expect(host.syncRemoteNeed).toHaveBeenCalledTimes(1);
      expect(home.folders.get('git:p1')).toMatchObject({ type: 'sendonly' });
      expect(peer.folders.get('git:p1')).toMatchObject({ type: 'receiveonly' });
      expect(retryRun.details.fileSyncConflicts).toEqual({ total: 0, sample: [] });
    },
  );

  // The host calls and fake folder state prove ordering without running Syncthing.
  it('removes the VM guard before folder changes and keeps the removal across Retry', async () => {
    const { home, host, handoff, run } = setup(true);
    host.removeGitGuard.mockResolvedValueOnce({ removed: true });
    host.syncDevice.mockRejectedValueOnce(new Error('pair failed'));
    const ensure = jest.spyOn(home, 'ensureFolder');

    await expect(handoff.initial(run, 'p1')).rejects.toThrow('pair failed');
    expect(run.details.vmGuardRemoved).toBe(true);
    expect(ensure).not.toHaveBeenCalled();

    await handoff.initial(run, 'p1');
    expect(host.removeGitGuard).toHaveBeenCalledWith('r1', 'p1');
    expect(run.details.vmGuardRemoved).toBe(true);
    expect(host.removeGitGuard.mock.invocationCallOrder[1]).toBeLessThan(
      ensure.mock.invocationCallOrder[0],
    );
  });

  it('fails initial before any folder change when guard removal fails, and can Retry', async () => {
    const { home, host, handoff, run } = setup(true);
    host.removeGitGuard.mockRejectedValueOnce(new Error('hooks are read-only'));
    const ensure = jest.spyOn(home, 'ensureFolder');

    await expect(handoff.initial(run, 'p1')).rejects.toThrow('hooks are read-only');
    expect(host.syncDevice).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(run.details.vmGuardRemoved).toBeUndefined();

    await handoff.initial(run, 'p1');
    expect(home.folders.get('git:p1')).toMatchObject({ paused: false });
  });

  it.each([null, 'VM git guard skipped: core.hooksPath is set'])(
    'installs the VM guard after both copies are paused and records warning %p',
    async (warning) => {
      const { home, peer, host, handoff, run } = setup(true);
      await handoff.initial(run, 'p1');
      host.installGitGuard.mockImplementationOnce(async () => {
        for (const id of ['code:p1', 'git:p1']) {
          expect(peer.folders.get(id)).toMatchObject({ type: 'receiveonly', paused: true });
          expect(home.folders.get(id)).toMatchObject({ type: 'sendonly', paused: true });
        }
        return { warning };
      });

      await handoff.flipToHome(run, 'p1', false);

      expect(host.installGitGuard).toHaveBeenCalledWith('r1', 'p1', {
        homeName: hostname(),
        reason: 'disconnect',
      });
      expect(run.details).toMatchObject({
        vmGuardWarning: warning,
        vmGuardInstalled: warning === null,
      });
    },
  );

  it('keeps cleanup ownership when VM guard installation fails after a partial write', async () => {
    const { host, handoff, run } = setup(true);
    await handoff.initial(run, 'p1');
    const progress = jest.spyOn(run, 'progress');
    host.installGitGuard.mockImplementationOnce(async () => {
      // A throttled marker could be lost if home stops here, so it must be durable first.
      expect(progress).toHaveBeenLastCalledWith({ vmGuardInstalled: true }, { durable: true });
      throw new Error('second hook failed');
    });

    await expect(handoff.flipToHome(run, 'p1', false)).rejects.toThrow('second hook failed');
    expect(run.details.vmGuardInstalled).toBe(true);
  });

  it('shares every folder paused, unpauses the receiver first and reports completion', async () => {
    const { home, peer, handoff, run, calls, reports } = setup();

    await handoff.initial(run, 'p1');

    for (const id of ['code:p1']) {
      expect(home.folders.get(id)).toMatchObject({ type: 'sendonly', paused: false });
      expect(peer.folders.get(id)).toMatchObject({ type: 'receiveonly', paused: false });
    }
    expect(calls).toEqual(['host code:p1 {"paused":false}', 'home code:p1 {"paused":false}']);
    expect(reports.at(-1)).toEqual({
      fileSync: {
        folders: {
          'code:p1': { completion: 100, needItems: 0, needBytes: 0 },
        },
      },
    });
  });

  it('makes code two-way while connected and pauses the home-owned layout on disconnect', async () => {
    const { handoff, run, calls } = setup();
    await handoff.initial(run, 'p1');
    calls.length = 0;

    await handoff.flipToHost(run, 'p1');
    await handoff.flipToHome(run, 'p1', false);

    expect(calls).toEqual([
      'host code:p1 {"type":"sendreceive"}',
      'home code:p1 {"type":"sendreceive"}',
      'host code:p1 {"type":"receiveonly","paused":true}',
      'home code:p1 {"type":"sendonly","paused":true}',
    ]);
  });

  it('changes only home on a forced flip', async () => {
    const { handoff, run, host, calls, guard } = setup();
    await handoff.initial(run, 'p1');
    calls.length = 0;
    host.syncFolderType.mockClear();
    host.removeGitGuard.mockClear();
    guard.remove.mockClear();

    await handoff.flipToHome(run, 'p1', true);

    expect(host.syncFolderType).not.toHaveBeenCalled();
    expect(host.installGitGuard).not.toHaveBeenCalled();
    expect(host.removeGitGuard).not.toHaveBeenCalled();
    expect(run.details.vmGuardSkipped).toContain('VM guard skipped');
    expect(calls).toEqual(['home code:p1 {"type":"sendonly","paused":true}']);
    // A forced disconnect also drops the ownership guard, home only.
    expect(guard.remove).toHaveBeenCalledWith('p1', { refreshIndex: true });
  });

  it('deletes leftover syncthing temp files at home on a normal and a forced disconnect', async () => {
    const { home, handoff, run } = setup();
    const root = mkdtempSync(join(tmpdir(), 'devchain-flip-home-'));
    try {
      writeFileSync(join(root, '.syncthing.app.ts.tmp'), 'partial');
      writeFileSync(join(root, 'app.ts'), 'kept');
      mkdirSync(join(root, '.git', 'objects'), { recursive: true });
      writeFileSync(join(root, '.git', '.syncthing.index.tmp'), 'partial');
      home.codeRoots.set('p1', root);
      await handoff.initial(run, 'p1');

      await handoff.flipToHome(run, 'p1', false);

      expect(existsSync(join(root, '.syncthing.app.ts.tmp'))).toBe(false);
      expect(existsSync(join(root, '.git', '.syncthing.index.tmp'))).toBe(false);

      writeFileSync(join(root, '~syncthing~forced.tmp'), 'partial');

      await handoff.flipToHome(run, 'p1', true);

      expect(existsSync(join(root, '~syncthing~forced.tmp'))).toBe(false);
      expect(existsSync(join(root, 'app.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never fails the flip when the temp-file cleanup cannot even start', async () => {
    const { home, handoff, run, guard } = setup();
    await handoff.initial(run, 'p1');
    // The cleanup absorbs its own walk errors; only a failed root lookup reaches the flip.
    jest.spyOn(home, 'folderPath').mockRejectedValue(new Error('project root unknown'));

    await expect(handoff.flipToHome(run, 'p1', true)).resolves.toBeUndefined();

    expect(guard.remove).toHaveBeenCalledWith('p1', { refreshIndex: true });
  });

  it('reports a guard skip warning from the connect flip in the operation details', async () => {
    const { handoff, run, guard, reports } = setup(true);
    guard.install.mockResolvedValueOnce('Git guard skipped: core.hooksPath is set');
    await handoff.initial(run, 'p1');

    await handoff.flipToHost(run, 'p1');

    expect(reports).toContainEqual({ guardWarning: 'Git guard skipped: core.hooksPath is set' });
  });

  it('reports no guard warning when the guard installs cleanly', async () => {
    const { handoff, run, reports } = setup(true);
    await handoff.initial(run, 'p1');

    await handoff.flipToHost(run, 'p1');

    expect(reports).not.toContainEqual(
      expect.objectContaining({ guardWarning: expect.anything() }),
    );
  });

  it('stops sharing at home even when the remote cannot be reached, and says why', async () => {
    const { home, handoff, run, host } = setup();
    await handoff.initial(run, 'p1');
    host.syncRemoveFolder.mockRejectedValue(new Error('remote offline'));

    await expect(handoff.removeFolders('r1', 'p1')).resolves.toBe('remote offline');
    expect(home.folders.size).toBe(0);
  });

  it('installs the union of the user ignores and the managed exclusions on both sides', async () => {
    const { home, peer, handoff, run, managed } = setup();
    home.setIgnores('p1', ['(?d)venv']);
    managed.set('p1', ['/state/db', '/state/uploads']);

    await handoff.initial(run, 'p1');

    const expected = ['/.git', '/state/db', '/state/uploads', '(?d)venv'];
    expect(home.folders.get('code:p1')?.ignores).toEqual(expected);
    expect(peer.folders.get('code:p1')?.ignores).toEqual(expected);
    expect(home.getIgnores('p1')).toEqual(['(?d)venv']);
  });

  it('does not duplicate a managed pattern the user already ignores', async () => {
    const { home, peer, handoff, run, managed } = setup();
    home.setIgnores('p1', ['/state/db']);
    managed.set('p1', ['/state/db']);

    await handoff.initial(run, 'p1');

    expect(home.folders.get('code:p1')?.ignores).toEqual(['/.git', '/state/db']);
    expect(peer.folders.get('code:p1')?.ignores).toEqual(['/.git', '/state/db']);
  });

  it('re-installs the union on both sides paused before the final sync unpauses', async () => {
    const { home, peer, handoff, run, calls, managed } = setup();
    await handoff.initial(run, 'p1');
    managed.set('p1', ['/state/db']);
    await handoff.flipToHost(run, 'p1');
    calls.length = 0;

    await handoff.final(run, 'p1');

    const expected = ['/.git', '/state/db', ...home.getIgnores('p1')];
    expect(home.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
    expect(peer.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
    expect(home.folders.get('code:p1')?.ignores).toEqual(expected);
    expect(peer.folders.get('code:p1')?.ignores).toEqual(expected);
    expect(calls).toEqual(['host code:p1 {"paused":false}', 'home code:p1 {"paused":false}']);
  });

  it('records that final paused the folders before pausing them, so a cancel can unpause', async () => {
    const { home, peer, host, handoff, run, reports } = setup();
    await handoff.initial(run, 'p1');
    await handoff.flipToHost(run, 'p1');
    reports.length = 0;
    host.syncFolderType.mockRejectedValueOnce(new Error('unpause failed'));

    await expect(handoff.final(run, 'p1')).rejects.toThrow('unpause failed');

    expect(reports[0]).toEqual({ fileSyncPaused: true });
    expect(peer.folders.get('code:p1')).toMatchObject({ paused: true });
    expect(home.folders.get('code:p1')).toMatchObject({ paused: true });
  });

  // Unit orchestration is enough to prove failure precedes all sync side effects.
  it.each(['initial', 'final'] as const)(
    '%s refuses corrupt exclusions before pairing or sharing',
    async (phase) => {
      const { home, host, handoff, run, managed, calls } = setup();
      const ensure = jest.spyOn(home, 'ensureFolder');
      jest.spyOn(managed, 'get').mockImplementation(() => {
        throw new InvalidManagedExclusionsError();
      });

      await expect(handoff[phase](run, 'p1')).rejects.toMatchObject({
        code: 'FILE_SYNC_MANAGED_EXCLUSIONS_INVALID',
      });
      expect(ensure).not.toHaveBeenCalled();
      expect(host.syncDevice).not.toHaveBeenCalled();
      expect(host.syncFolders).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );

  it('fails the step with the missing-binary reason when Syncthing is not running', async () => {
    const reason = 'Syncthing was not found on PATH or in ~/.devchain/bin.';
    const fileSync = new FileSyncService(
      { getConnection: () => null, getState: () => ({ error: reason }) } as never,
      {} as never,
      {} as never,
      { get: () => [] } as never,
    );
    const handoff = new FileSyncHandoff(
      fileSync,
      {
        removeGitGuard: async () => ({ removed: false }),
        syncFolderExists: async () => false,
      } as unknown as RemoteHostClient,
      new FakeManagedExclusionsStore() as unknown as FileSyncManagedExclusionsStore,
      {} as HomeGitGuardService,
      new FakeProcessExecutor(),
      { get: () => 'vm' } as never,
    );
    const { run } = setup();

    const error = await handoff.initial(run, 'p1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileSyncUnavailableError);
    expect((error as Error).message).toContain(reason);
  });
});

// Unit orchestration owns the per-kind direction order, rollback and failure policies.
describe('split git handoffs', () => {
  it.each(['vm', 'home'] as const)(
    'settles guarded %s Git only after the advertised copy arrives, then waits for receiver changes to clear',
    async (source) => {
      jest.useFakeTimers();
      try {
        const { home, peer, host, handoff, run } = setup(true);
        await handoff.initial(run, 'p1');
        const sender = source === 'home' ? home : peer;
        const receiver = source === 'home' ? peer : home;
        await receiver.setFolderType('git:p1', 'receiveonly');
        await sender.setFolderType('git:p1', 'sendonly');
        let arrived = false;
        let reverted = false;
        let clear = false;
        const senderRead = sender.status.bind(sender);
        jest.spyOn(sender, 'status').mockImplementation(async (id, device) => ({
          ...(await senderRead(id, device)),
          peer: device
            ? {
                deviceId: device,
                completion: arrived ? 100 : 90,
                needItems: arrived ? 0 : 1,
                needBytes: 0,
                remoteState: 'valid',
              }
            : null,
        }));
        const receiverRead = receiver.status.bind(receiver);
        jest.spyOn(receiver, 'status').mockImplementation(async (id, device) => ({
          ...(await receiverRead(id, device)),
          receiveOnlyChangedFiles: clear ? 0 : 1,
          localFiles: clear || reverted ? 1 : 2,
        }));
        const discard = jest.spyOn(receiver, 'revertLocalChanges').mockImplementation(async () => {
          reverted = true;
        });
        host.syncStatus.mockImplementation((_r, id, device) => peer.status(id, device));
        host.syncRevert.mockImplementation((_r, id) => peer.revertLocalChanges(id));
        let finished = false;
        const wait = handoff.settleGit(run, 'p1', source).then(() => {
          finished = true;
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(discard).not.toHaveBeenCalled();
        arrived = true;
        await jest.advanceTimersByTimeAsync(20);
        expect(reverted).toBe(true);
        expect(finished).toBe(false);
        clear = true;
        await jest.advanceTimersByTimeAsync(10);
        await wait;
        expect(finished).toBe(true);
      } finally {
        jest.useRealTimers();
        jest.restoreAllMocks();
      }
    },
  );

  it('installs distinct ignore lists and changes git receiver first before installing the guard', async () => {
    const { home, peer, handoff, run, calls, guard, managed, owner } = setup(true);
    owner.value = 'home';
    home.setIgnores('p1', ['!/.git', '!/data', 'node_modules']);
    managed.set('p1', ['/data']);
    await handoff.initial(run, 'p1');
    expect(home.folders.get('code:p1')?.ignores).toEqual([
      '/.git',
      '/data',
      '!/.git',
      '!/data',
      'node_modules',
    ]);
    expect(peer.folders.get('git:p1')?.ignores).toEqual(['*.lock']);
    expect(home.folders.get('git:p1')?.ignores).toEqual(['*.lock']);
    expect(guard.install).not.toHaveBeenCalled();
    calls.length = 0;
    await handoff.flipToHost(run, 'p1');
    expect(calls.slice(-2)).toEqual([
      'home git:p1 {"type":"receiveonly","ignores":["*.lock","/hooks","/index"]}',
      'host git:p1 {"type":"sendonly","ignores":["*.lock","/hooks","/index"]}',
    ]);
    for (const side of [home, peer]) expect(side.folders.get('code:p1')?.type).toBe('sendreceive');
    expect(guard.install).toHaveBeenCalledWith('p1', 'r1');
  });

  it('scans both code copies, never reverts code, and uses symmetric peer completion on final', async () => {
    const { home, host, handoff, run } = setup(true);
    await handoff.initial(run, 'p1');
    await handoff.flipToHost(run, 'p1');
    const scan = jest.spyOn(home, 'rescan');
    const revert = jest.spyOn(home, 'revertLocalChanges');
    const wait = jest.spyOn(home, 'waitForComplete');
    const original = home.status.bind(home);
    jest.spyOn(home, 'status').mockImplementation(async (id, device) => ({
      ...(await original(id, device)),
      receiveOnlyChangedFiles: 1,
    }));
    host.syncScan.mockClear();
    await handoff.final(run, 'p1');
    // The Disconnect path scans home without a cancel signal.
    expect(scan).toHaveBeenCalledWith('code:p1', undefined);
    expect(host.syncScan).toHaveBeenCalledWith('r1', 'code:p1');
    expect(revert).not.toHaveBeenCalledWith('code:p1');
    expect(revert).toHaveBeenCalledWith('git:p1');
    expect(wait).toHaveBeenCalledWith('code:p1', expect.objectContaining({ symmetric: true }));
    expect(home.status).toHaveBeenCalledWith('code:p1', expect.any(String));
  });

  it.each(['vm', 'home'] as const)(
    'restores %s Git ownership after cancelled disconnect, then removes both on rollback',
    async (value) => {
      const { home, peer, handoff, run, guard, host, owner } = setup(true);
      await handoff.initial(run, 'p1');
      await handoff.flipToHost(run, 'p1');
      owner.value = value;
      guard.install.mockClear();
      await handoff.flipToHome(run, 'p1', false);
      expect(guard.remove).toHaveBeenCalledWith('p1', { refreshIndex: value === 'vm' });
      await handoff.flipBackToHost('r1', 'p1', false);
      expect(home.folders.get('git:p1')).toMatchObject({
        type: value === 'home' ? 'sendonly' : 'receiveonly',
        paused: false,
      });
      expect(peer.folders.get('git:p1')).toMatchObject({
        type: value === 'vm' ? 'sendonly' : 'receiveonly',
        paused: false,
      });
      for (const side of [home, peer])
        expect(side.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
      if (value === 'vm') expect(guard.reinstall).toHaveBeenCalledWith('p1', 'r1');
      else {
        expect(host.installGitGuard).toHaveBeenLastCalledWith('r1', 'p1', {
          homeName: hostname(),
          reason: 'pc-git',
        });
        expect(guard.reinstall).not.toHaveBeenCalled();
        expect(guard.install).not.toHaveBeenCalled();
      }
      await handoff.removeFolders('r1', 'p1');
      expect(home.folders.size).toBe(0);
      expect(peer.folders.size).toBe(0);
      expect(guard.remove).toHaveBeenCalledTimes(2);
      // A cancelled Connect keeps home's own index: the VM never owned git.
      expect(guard.remove).toHaveBeenLastCalledWith('p1', { refreshIndex: false });
    },
  );

  it('tolerates disappeared shares in every flip but propagates other errors', async () => {
    const { home, peer, handoff, run, host } = setup(true);
    await handoff.initial(run, 'p1');
    peer.folders.delete('git:p1');
    await handoff.flipToHost(run, 'p1');
    await handoff.flipToHome(run, 'p1', false);
    await handoff.flipBackToHost('r1', 'p1', false);
    host.syncFolderType.mockRejectedValueOnce(new Error('unavailable'));
    await expect(handoff.flipToHost(run, 'p1')).rejects.toThrow('unavailable');
    home.folders.delete('git:p1');
    await expect(handoff.flipToHome(run, 'p1', true)).resolves.toBeUndefined();
  });

  // A cancel must reach every wait of a running Connect; the abort wiring is
  // proven here against the fake, one wait at a time.
  describe('interrupt', () => {
    /** Resolves once a condition flips true; a bounded tick loop is enough for the in-memory fake. */
    async function until(condition: () => boolean): Promise<void> {
      for (let i = 0; i < 1_000 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    /**
     * A rescan that ends on the cancel signal the way the REST-backed one does,
     * and otherwise waits for the test's release — so a step can be held inside
     * its scan.
     */
    function gatedRescan(home: FakeFileSyncService) {
      const releases: Array<() => void> = [];
      const spy = jest.spyOn(home, 'rescan').mockImplementation(
        (_folderId: string, signal?: AbortSignal) =>
          new Promise<void>((resolve, reject) => {
            // A scan starting after the cancel must end with it, like the real client.
            signal?.throwIfAborted();
            let settled = false;
            const settle = (finish: () => void) => {
              if (settled) return;
              settled = true;
              finish();
            };
            signal?.addEventListener('abort', () => settle(() => reject(signal.reason)), {
              once: true,
            });
            releases.push(() => settle(resolve));
          }),
      );
      return { spy, release: (index: number) => releases[index]?.() };
    }

    it('ends initial while its home rescan is still pending, which settles only afterwards', async () => {
      const { home, handoff, run } = setup(true);
      const rescan = gatedRescan(home);
      const initial = handoff.initial(run, 'p1');
      await until(() => rescan.spy.mock.calls.length >= 2);

      handoff.interrupt('op-1');

      await expect(initial).rejects.toThrow('The Connect was cancelled.');
      // The scans never finished on their own; their gates settle after the step ended.
      rescan.release(0);
      rescan.release(1);
    });

    it('ends initial during the completion wait with the cancel reason', async () => {
      const { home, peer, handoff, run } = setup();
      // The receiver never becomes complete, so the wait would outlive the test.
      peer.need.set('code:p1', { needItems: 2, needBytes: 2048 });
      const realWait = home.waitForComplete.bind(home);
      let waiting!: () => void;
      const waitStarted = new Promise<void>((resolve) => (waiting = resolve));
      jest
        .spyOn(home, 'waitForComplete')
        .mockImplementation((folderId, options) => (waiting(), realWait(folderId, options)));
      const initial = handoff.initial(run, 'p1');
      await waitStarted;

      handoff.interrupt('op-1');

      await expect(initial).rejects.toThrow('The Connect was cancelled.');
    });

    it('ends initial during the pairing wait with the cancel reason', async () => {
      const { home, handoff, run } = setup();
      const connected = jest.spyOn(home, 'isConnected').mockResolvedValue(false);
      const initial = handoff.initial(run, 'p1');
      await until(() => connected.mock.calls.length >= 1);

      handoff.interrupt('op-1');

      await expect(initial).rejects.toThrow('The Connect was cancelled.');
    });

    it('does not let a superseded run drop the newer controller of the same operation', async () => {
      const { home, handoff, run } = setup();
      const rescan = gatedRescan(home);
      const first = handoff.initial(run, 'p1');
      await until(() => rescan.spy.mock.calls.length >= 1);
      const second = handoff.initial(run, 'p1');
      await until(() => rescan.spy.mock.calls.length >= 2);

      // The first run finishes late; only the second controller may be interrupted.
      rescan.release(0);
      await expect(first).resolves.toBeUndefined();

      handoff.interrupt('op-1');
      await expect(second).rejects.toThrow('The Connect was cancelled.');
      rescan.release(1);
    });
  });
});

// A temporary root and fake process boundary prove init decisions and Retry without Syncthing.
describe('FileSyncHandoff.ensureRepository', () => {
  /** The layout `git init` leaves behind: HEAD, objects/ and refs/. */
  const usableGitDirectory = (root: string) => {
    for (const folder of ['objects', 'refs'])
      mkdirSync(join(root, '.git', folder), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  };
  const handoffAt = (root: string, executor: ProcessExecutor) =>
    new FileSyncHandoff(
      { folderPath: async () => root } as unknown as FileSyncService,
      {} as RemoteHostClient,
      {} as FileSyncManagedExclusionsStore,
      {} as HomeGitGuardService,
      executor,
      { get: () => 'vm' } as never,
    );

  it.each(['missing', 'empty', 'repository', 'worktree'] as const)(
    'initializes only a missing repository (%s), then Retry leaves it alone',
    async (layout) => {
      const root = mkdtempSync(join(tmpdir(), 'handoff-repository-'));
      const executor = new FakeProcessExecutor();
      const handoff = handoffAt(root, executor);
      try {
        if (layout === 'empty' || layout === 'repository') mkdirSync(join(root, '.git'));
        if (layout === 'repository') usableGitDirectory(root);
        if (layout === 'worktree') writeFileSync(join(root, '.git'), 'gitdir: /other/worktree');
        const created = layout === 'missing' || layout === 'empty';
        expect(await handoff.ensureRepository('p1')).toBe(created);
        expect(executor.calls).toEqual(
          created
            ? [expect.objectContaining({ argv: ['git', 'init'], cwd: root, mode: 'pipe' })]
            : [],
        );
        if (created) usableGitDirectory(root);
        expect(await handoff.ensureRepository('p1')).toBe(false);
        expect(executor.calls).toHaveLength(created ? 1 : 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Real Git is the only layer that reproduces an init that writes HEAD and then fails.
  it('completes a partial .git from a failed init on the next attempt, with no saved state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-partial-init-'));
    const handoff = handoffAt(root, new ChildProcessExecutor());
    try {
      // A stale config.lock makes git init write HEAD and refs/, then exit 128 before objects/.
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'config.lock'), '');
      await expect(handoff.ensureRepository('p1')).rejects.toMatchObject({
        code: 'GIT_INIT_FAILED',
      });
      expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true);
      rmSync(join(root, '.git', 'config.lock'));

      // A Retry and a new Connect after Cancel both start from this same state.
      expect(await handoff.ensureRepository('p1')).toBe(true);
      expect(spawnSync('git', ['-C', root, 'status', '--porcelain']).status).toBe(0);
      expect(await handoff.ensureRepository('p1')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the Git error and runs init again on Retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-init-failure-'));
    const executor = new FakeProcessExecutor();
    executor.enqueueResponse(
      { type: 'failure', stderr: 'fatal: permission denied' },
      { type: 'success' },
    );
    const handoff = handoffAt(root, executor);
    try {
      await expect(handoff.ensureRepository('p1')).rejects.toMatchObject({
        code: 'GIT_INIT_FAILED',
        message: 'fatal: permission denied',
      });
      expect(await handoff.ensureRepository('p1')).toBe(true);
      expect(executor.calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
