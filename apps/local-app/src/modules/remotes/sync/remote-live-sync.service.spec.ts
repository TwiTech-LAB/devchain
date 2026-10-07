import type { ProjectReplicaChanges } from '@devchain/shared';
import { resetEnvConfig } from '../../../common/config/env.config';
import { ReplicaApplyError } from '../../../common/errors/error-types';
import type { RemoteProjectBinding } from '../../storage/models/domain.models';
import { RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteLiveSyncService } from './remote-live-sync.service';
import { RemoteFileSyncService } from './remote-file-sync.service';

const PROJECT = 'project-1';
const REMOTE = 'remote-1';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function changes(
  cursor: string,
  overrides: { epics?: number; statuses?: string[]; idSets?: string[] } = {},
): ProjectReplicaChanges {
  const epics = Array.from({ length: overrides.epics ?? 0 }, (_, i) => ({ id: `epic-${i}` }));
  return {
    cursor,
    replica: {
      version: 1,
      scope: 'live',
      generatedAt: cursor,
      workspace: { id: 'ws-1', name: 'Team' },
      tables: {
        projects: [{ id: PROJECT }],
        statuses: (overrides.statuses ?? ['New']).map((label) => ({ id: label, label })),
        tags: [],
        providers: [],
        agent_profiles: [],
        profile_provider_configs: [],
        agents: [],
        epics,
        epic_tags: [],
        epic_comments: [],
        epic_relations: [],
        epic_time_segments: [],
      },
    },
    ...(overrides.idSets && {
      idSets: {
        epics: overrides.idSets,
        epic_comments: [],
        epic_relations: [],
        epic_time_segments: [],
      },
    }),
  } as unknown as ProjectReplicaChanges;
}

describe('RemoteLiveSyncService', () => {
  let binding: RemoteProjectBinding;
  let online: boolean;
  let apiKeyRejected: boolean;
  let homeEpicIds: string[];
  let bindings: { list: jest.Mock; get: jest.Mock; update: jest.Mock };
  let host: { changes: jest.Mock; exportReplica: jest.Mock };
  let applier: { apply: jest.Mock };
  let builder: { build: jest.Mock };
  let service: RemoteLiveSyncService;
  let files: { tick: jest.Mock; forget: jest.Mock };

  beforeEach(() => {
    process.env.REMOTES_SYNC_INTERVAL_MS = '1000';
    process.env.REMOTES_RECONCILE_INTERVAL_MS = '60000';
    resetEnvConfig();
    binding = {
      projectId: PROJECT,
      remoteId: REMOTE,
      state: 'remote',
      hostCursor: '2026-09-22T10:00:00.000Z',
      syncError: null,
      syncFailedAt: null,
      createdAt: 't',
      updatedAt: 't',
    };
    online = true;
    apiKeyRejected = false;
    homeEpicIds = [];
    bindings = {
      list: jest.fn(async () => [binding]),
      get: jest.fn(async () => ({ ...binding })),
      update: jest.fn(async (_projectId: string, data: Partial<RemoteProjectBinding>) => {
        binding = { ...binding, ...data };
        return binding;
      }),
    };
    host = {
      changes: jest.fn(async () => changes('2026-09-22T10:00:05.000Z')),
      exportReplica: jest.fn(async () => ({ generatedAt: '2026-09-22T10:01:00.000Z' })),
    };
    applier = { apply: jest.fn(async () => []) };
    builder = {
      build: jest.fn(async () => ({
        ok: true,
        idSets: {
          epics: homeEpicIds,
          epic_comments: [],
          epic_relations: [],
          epic_time_segments: [],
        },
      })),
    };
    const health = { getState: jest.fn(() => ({ online, apiKeyRejected })) };
    files = { tick: jest.fn(async () => undefined), forget: jest.fn() };
    service = new RemoteLiveSyncService(
      health as never,
      bindings as never,
      host as never,
      applier as never,
      builder as never,
      files as never,
    );
  });

  afterEach(async () => {
    await service.onApplicationShutdown();
    jest.useRealTimers();
    delete process.env.REMOTES_SYNC_INTERVAL_MS;
    delete process.env.REMOTES_RECONCILE_INTERVAL_MS;
    resetEnvConfig();
  });

  it.each(
    (['force_sync', 'git_owner'] as const).flatMap((kind) =>
      (['running', 'failed'] as const).map((state) => ({ kind, state })),
    ),
  )(
    'retains the $state $kind hold after restarting live sync while DB pulls continue',
    async ({ kind, state }) => {
      const storage = {
        listRemoteOperations: jest.fn(async () => [{ kind, state }]),
      };
      const fileBoundary = {
        ensureFolder: jest.fn(),
        device: jest.fn(),
        revertLocalChanges: jest.fn(),
      };
      const index = { refreshIndexFromHead: jest.fn() };
      for (let boot = 0; boot < 2; boot++) {
        await service.onApplicationShutdown();
        const health = { getState: () => ({ online: true, versionMatches: true }) };
        const upkeep = new RemoteFileSyncService(
          fileBoundary as never,
          host as never,
          bindings as never,
          health as never,
          {} as never,
          index as never,
          {} as never,
          storage as never,
          {} as never,
          {} as never,
          {} as never,
        );
        service = new RemoteLiveSyncService(
          health as never,
          bindings as never,
          host as never,
          applier as never,
          builder as never,
          upkeep,
        );
        await service.onApplicationBootstrap();
        await service.syncNow(PROJECT);
      }
      expect(host.changes).toHaveBeenCalledTimes(2);
      expect(applier.apply).toHaveBeenCalledTimes(2);
      expect(storage.listRemoteOperations).toHaveBeenCalledWith({
        projectId: PROJECT,
        kinds: ['force_sync', 'git_owner'],
        states: ['running', 'failed'],
        limit: 1,
      });
      expect(fileBoundary.ensureFolder).not.toHaveBeenCalled();
      expect(fileBoundary.device).not.toHaveBeenCalled();
      expect(fileBoundary.revertLocalChanges).not.toHaveBeenCalled();
      expect(index.refreshIndexFromHead).not.toHaveBeenCalled();
    },
  );

  it('pulls since the binding cursor, applies live, then advances the cursor', async () => {
    host.changes.mockResolvedValueOnce(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);

    expect(host.changes).toHaveBeenCalledWith(REMOTE, PROJECT, {
      since: '2026-09-22T10:00:00.000Z',
      full: false,
    });
    expect(applier.apply).toHaveBeenCalledWith(expect.objectContaining({ scope: 'live' }), {
      mode: 'live',
      remoteId: REMOTE,
      cursor: '2026-09-22T10:00:05.000Z',
      idSets: undefined,
    });
    expect(binding.hostCursor).toBe('2026-09-22T10:00:05.000Z');
  });

  it('skips the apply and the cursor write when a pull changes nothing', async () => {
    service.start(PROJECT, REMOTE);
    await service.syncNow(PROJECT);
    applier.apply.mockClear();
    bindings.update.mockClear();

    await service.syncNow(PROJECT);

    expect(applier.apply).not.toHaveBeenCalled();
    expect(bindings.update).not.toHaveBeenCalled();
  });

  it('applies when a whole-arriving table changed even with no epic rows', async () => {
    service.start(PROJECT, REMOTE);
    await service.syncNow(PROJECT);
    applier.apply.mockClear();
    host.changes.mockResolvedValueOnce(
      changes('2026-09-22T10:00:06.000Z', { statuses: ['New', 'Done'] }),
    );

    await service.syncNow(PROJECT);

    expect(applier.apply).toHaveBeenCalledTimes(1);
  });

  it('never moves the cursor backwards', async () => {
    host.changes.mockResolvedValueOnce(changes('2026-09-22T09:00:00.000Z', { epics: 1 }));
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);

    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(binding.hostCursor).toBe('2026-09-22T10:00:00.000Z');
    expect(bindings.update).not.toHaveBeenCalled();
  });

  it('starts from a full reconcile at startup and passes the ID sets to the applier', async () => {
    host.changes.mockResolvedValueOnce(
      changes('2026-09-22T10:00:05.000Z', { idSets: ['epic-kept'] }),
    );
    homeEpicIds = ['epic-kept', 'epic-deleted-on-host'];
    await service.onApplicationBootstrap();

    await service.syncNow(PROJECT);
    await service.syncNow(PROJECT);

    expect(host.changes.mock.calls.map(([, , options]) => options.full)).toEqual([true, false]);
    expect(applier.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idSets: expect.objectContaining({ epics: ['epic-kept'] }) }),
    );
  });

  it('skips a full reconcile whose ID sets already match home', async () => {
    homeEpicIds = ['b', 'a'];
    service.start(PROJECT, REMOTE);
    await service.syncNow(PROJECT);
    applier.apply.mockClear();
    host.changes.mockResolvedValueOnce(changes('2026-09-22T10:00:07.000Z', { idSets: ['a', 'b'] }));
    service.start(PROJECT, REMOTE, { full: true });

    await service.syncNow(PROJECT);

    expect(host.changes).toHaveBeenLastCalledWith(
      REMOTE,
      PROJECT,
      expect.objectContaining({ full: true }),
    );
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it('pulls nothing while the remote is offline and reconciles fully once it is back', async () => {
    service.start(PROJECT, REMOTE);
    online = false;
    await service.syncNow(PROJECT);
    await service.syncNow(PROJECT);
    expect(host.changes).not.toHaveBeenCalled();

    online = true;
    await service.syncNow(PROJECT);
    await service.syncNow(PROJECT);

    expect(host.changes.mock.calls.map(([, , options]) => options.full)).toEqual([true, false]);
  });

  it("pulls nothing while the VM rejects this PC's API key and reconciles fully after", async () => {
    service.start(PROJECT, REMOTE);
    apiKeyRejected = true;
    await service.syncNow(PROJECT);
    expect(host.changes).not.toHaveBeenCalled();

    apiKeyRejected = false;
    await service.syncNow(PROJECT);

    expect(host.changes.mock.calls.map(([, , options]) => options.full)).toEqual([true]);
  });

  it('treats an unreachable host as a skipped tick', async () => {
    host.changes.mockRejectedValueOnce(
      new RemoteHostRequestError('down', {
        remoteId: REMOTE,
        path: '/',
        status: null,
        hostCode: null,
      }),
    );
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);

    expect(applier.apply).not.toHaveBeenCalled();
    expect(bindings.update).not.toHaveBeenCalled();
  });

  it('records a failed apply, re-snapshots with home env kept, then clears the failure', async () => {
    host.changes.mockResolvedValueOnce(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
    applier.apply.mockRejectedValueOnce(new ReplicaApplyError('epics', 'epic-0', 'boom'));
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);

    expect(bindings.update.mock.calls.map(([, data]) => data)).toEqual([
      { syncError: 'Replica apply failed at epics row epic-0: boom' },
      { syncError: null, hostCursor: '2026-09-22T10:01:00.000Z' },
    ]);
    expect(host.exportReplica).toHaveBeenCalledWith(REMOTE, PROJECT, 'attach');
    expect(applier.apply).toHaveBeenLastCalledWith(
      { generatedAt: '2026-09-22T10:01:00.000Z' },
      {
        mode: 'full',
        remoteId: REMOTE,
        cursor: '2026-09-22T10:01:00.000Z',
        keepInstanceConfig: true,
      },
    );
    expect(binding.state).toBe('remote');
    expect(binding.syncError).toBeNull();
  });

  it('keeps the failure and waits a reconcile interval before retrying a failed re-snapshot', async () => {
    host.changes.mockResolvedValueOnce(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
    applier.apply.mockRejectedValueOnce(new ReplicaApplyError('epics', 'epic-0', 'boom'));
    host.exportReplica.mockRejectedValueOnce(new Error('export failed'));
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);
    await service.syncNow(PROJECT);

    expect(binding.syncError).toBe('Replica apply failed at epics row epic-0: boom');
    expect(host.exportReplica).toHaveBeenCalledTimes(1);
    expect(host.changes).toHaveBeenCalledTimes(1);
  });

  it('resumes a persisted failure with a re-snapshot after a restart, not an incremental pull', async () => {
    // The previous process recorded the failure and its re-snapshot never succeeded.
    binding = { ...binding, syncError: 'Replica apply failed at epics row epic-0: boom' };
    await service.onApplicationBootstrap();

    await service.syncNow(PROJECT);

    expect(host.changes).not.toHaveBeenCalled();
    expect(host.exportReplica).toHaveBeenCalledWith(REMOTE, PROJECT, 'attach');
    expect(bindings.update.mock.calls.map(([, data]) => data)).toEqual([
      { syncError: null, hostCursor: '2026-09-22T10:01:00.000Z' },
    ]);
    expect(binding.syncError).toBeNull();
  });

  it('runs one pull per project at a time', async () => {
    let release!: () => void;
    host.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
        }),
    );
    jest.useFakeTimers();
    await service.onApplicationBootstrap();

    const first = service.syncNow(PROJECT);
    const second = service.syncNow(PROJECT);
    try {
      await jest.advanceTimersByTimeAsync(2_000);
      expect(host.changes).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await Promise.all([first, second]);

    expect(host.changes).toHaveBeenCalledTimes(1);
  });

  it('pullNow runs a fresh pull after one already in flight', async () => {
    let release!: () => void;
    host.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
        }),
    );
    service.start(PROJECT, REMOTE);
    const inFlight = service.syncNow(PROJECT);
    await new Promise((resolve) => setImmediate(resolve));

    const fresh = service.pullNow(PROJECT);
    release();
    await Promise.all([inFlight, fresh]);

    expect(host.changes).toHaveBeenCalledTimes(2);
    expect(host.changes).toHaveBeenLastCalledWith(REMOTE, PROJECT, {
      since: '2026-09-22T10:00:05.000Z',
      full: false,
    });
  });

  it('pullNow does nothing for a project without live sync', async () => {
    await service.pullNow('home-owned');

    expect(host.changes).not.toHaveBeenCalled();
  });

  it('drains the active file tick before stop allows a handoff and cancels the remaining pull', async () => {
    let release!: () => void;
    let active!: () => boolean;
    files.tick.mockImplementationOnce(
      (_project: string, _remote: string, isActive: () => boolean) => {
        active = isActive;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    service.start(PROJECT, REMOTE);
    const first = service.syncNow(PROJECT);
    const concurrent = service.syncNow(PROJECT);
    await Promise.resolve();
    expect(files.tick).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = service.stop(PROJECT).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(active()).toBe(false);
    release();
    await Promise.all([first, concurrent, stop]);
    expect(files.forget).toHaveBeenCalledWith(PROJECT);
    expect(host.changes).not.toHaveBeenCalled();
  });

  // Unit tests observe queue ordering through the runner's public callbacks, with deterministic gates.
  it('serializes exclusive saves behind ticks and retains the last queued owner', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    const events: string[] = [];
    const [tickGate, saveGate, tickReady, saveReady] = [
      deferred(),
      deferred(),
      deferred(),
      deferred(),
    ];
    files.tick.mockImplementationOnce(async () => {
      events.push('tick');
      tickReady.resolve();
      await tickGate.promise;
    });
    const tick = service.syncNow(PROJECT);
    await tickReady.promise;
    const first = service.runExclusive(PROJECT, async (active) => {
      expect(active()).toBe(true);
      events.push('first-save');
      saveReady.resolve();
      await saveGate.promise;
      return 'applied';
    });
    const second = service.runExclusive(PROJECT, async () => {
      events.push('second-save');
    });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(events).toEqual(['tick']);
    tickGate.resolve();
    await saveReady.promise;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(files.tick).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['tick', 'first-save']);
    saveGate.resolve();
    await expect(first).resolves.toBe('applied');
    await Promise.all([tick, second]);
    expect(events).toEqual(['tick', 'first-save', 'second-save']);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(files.tick).toHaveBeenCalledTimes(2);
  });

  it('drains queued work on stop and gives it an inactive lifecycle', async () => {
    service.start(PROJECT, REMOTE);
    const [gate, ready] = [deferred(), deferred()];
    const first = service.runExclusive(PROJECT, async () => {
      ready.resolve();
      await gate.promise;
    });
    await ready.promise;
    const second = service.runExclusive(PROJECT, async (active) => active());
    const stop = service.stop(PROJECT);
    expect(service.isRunning(PROJECT)).toBe(false);
    expect(files.forget).not.toHaveBeenCalled();
    gate.resolve();
    await expect(second).resolves.toBe(false);
    await Promise.all([first, stop]);
    expect(files.forget).toHaveBeenCalledWith(PROJECT);
  });

  it('continues queued work after an exclusive callback rejects', async () => {
    service.start(PROJECT, REMOTE);
    const failed = service.runExclusive(PROJECT, async () => {
      throw new Error('save failed');
    });
    const next = service.runExclusive(PROJECT, async () => 'saved');
    await expect(failed).rejects.toThrow('save failed');
    await expect(next).resolves.toBe('saved');
    await service.syncNow(PROJECT);
    expect(host.changes).toHaveBeenCalledTimes(1);
  });

  it('pullNow still pulls when another exclusive save is queued while it waits', async () => {
    service.start(PROJECT, REMOTE);
    const gate = deferred();
    const first = service.runExclusive(PROJECT, async () => {
      await gate.promise;
    });
    const pull = service.pullNow(PROJECT);
    const later = service.runExclusive(PROJECT, async () => 'saved');
    gate.resolve();
    await Promise.all([first, pull, later]);
    expect(host.changes).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a pull that finishes after stop', async () => {
    let release!: () => void;
    host.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(changes('2026-09-22T10:00:05.000Z', { epics: 1 }));
        }),
    );
    service.start(PROJECT, REMOTE);
    const pull = service.syncNow(PROJECT);
    await new Promise((resolve) => setImmediate(resolve));

    const stopped = service.stop(PROJECT);
    release();
    await Promise.all([pull, stopped]);

    expect(service.isRunning(PROJECT)).toBe(false);
    expect(applier.apply).not.toHaveBeenCalled();
    expect(bindings.update).not.toHaveBeenCalled();
  });

  it('does not pull a project whose binding is no longer remote', async () => {
    binding = { ...binding, state: 'detaching' };
    service.start(PROJECT, REMOTE);

    await service.syncNow(PROJECT);

    expect(host.changes).not.toHaveBeenCalled();
  });
});
