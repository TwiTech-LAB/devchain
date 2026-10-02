import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidManagedExclusionsError,
  type FileSyncManagedExclusionsStore,
} from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService, FileSyncUnavailableError } from '../../file-sync/file-sync.service';
import type { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { FileSyncHandoff } from './file-sync-handoff';
import type { RemoteHostClient } from './remote-host.client';
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
    remove: jest.fn(async () => undefined),
    reinstall: jest.fn(async (): Promise<string | null> => null),
  };
  const managed = new FakeManagedExclusionsStore();
  const calls: string[] = [];
  const host = {
    syncDevice: jest.fn(async () => peer.device()),
    syncPeer: jest.fn(async (_r: string, device: { deviceId: string }) => {
      await peer.addPeer({ deviceId: device.deviceId, address: 'tcp://home:22000' });
    }),
    syncFolders: jest.fn(async (_r: string, request) => peer.ensureFolder(request)),
    syncFolderType: jest.fn(async (_r: string, id: string, patch) => {
      calls.push(`host ${id} ${JSON.stringify(patch)}`);
      await peer.updateFolder(id, patch);
    }),
    syncStatus: jest.fn(async (_r: string, id: string, device?: string) => peer.status(id, device)),
    syncScan: jest.fn(async () => undefined),
    syncRevert: jest.fn(async () => undefined),
    syncRemoveFolder: jest.fn(async (_r: string, id: string) => peer.removeFolder(id)),
  };
  const update = home.updateFolder.bind(home);
  jest.spyOn(home, 'updateFolder').mockImplementation(async (id, patch) => {
    calls.push(`home ${id} ${JSON.stringify(patch)}`);
    await update(id, patch);
  });
  const handoff = new FileSyncHandoff(
    home as unknown as FileSyncService,
    host as unknown as RemoteHostClient,
    managed as unknown as FileSyncManagedExclusionsStore,
    guard as unknown as HomeGitGuardService,
  );
  const reports: Record<string, unknown>[] = [];
  const run: RemoteOperationStepRun = {
    operation,
    details: {},
    progress: async (patch) => void reports.push(patch),
  };
  return { home, peer, host, handoff, run, calls, reports, managed, guard };
}

describe('FileSyncHandoff', () => {
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
    guard.remove.mockClear();

    await handoff.flipToHome(run, 'p1', true);

    expect(host.syncFolderType).not.toHaveBeenCalled();
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
      {} as RemoteHostClient,
      new FakeManagedExclusionsStore() as unknown as FileSyncManagedExclusionsStore,
      {} as HomeGitGuardService,
    );
    const { run } = setup();

    const error = await handoff.initial(run, 'p1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileSyncUnavailableError);
    expect((error as Error).message).toContain(reason);
  });
});

// Unit orchestration owns the per-kind direction order, rollback and failure policies.
describe('split git handoffs', () => {
  it('installs distinct ignore lists and changes git receiver first before installing the guard', async () => {
    const { home, peer, handoff, run, calls, guard, managed } = setup(true);
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

  it('restores each kind and reinstalls the guard after cancelled disconnect, then removes both on rollback', async () => {
    const { home, peer, handoff, run, guard } = setup(true);
    await handoff.initial(run, 'p1');
    await handoff.flipToHost(run, 'p1');
    await handoff.flipToHome(run, 'p1', false);
    expect(guard.remove).toHaveBeenCalledWith('p1', { refreshIndex: true });
    await handoff.flipBackToHost('r1', 'p1', false);
    expect(home.folders.get('git:p1')).toMatchObject({ type: 'receiveonly', paused: false });
    expect(peer.folders.get('git:p1')).toMatchObject({ type: 'sendonly', paused: false });
    for (const side of [home, peer])
      expect(side.folders.get('code:p1')).toMatchObject({ type: 'sendreceive', paused: false });
    expect(guard.reinstall).toHaveBeenCalledWith('p1', 'r1');
    await handoff.removeFolders('r1', 'p1');
    expect(home.folders.size).toBe(0);
    expect(peer.folders.size).toBe(0);
    expect(guard.remove).toHaveBeenCalledTimes(2);
    // A cancelled Connect keeps home's own index: the VM never owned git.
    expect(guard.remove).toHaveBeenLastCalledWith('p1', { refreshIndex: false });
  });

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
