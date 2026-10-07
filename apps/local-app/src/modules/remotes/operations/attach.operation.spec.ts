/**
 * The push step's cursor contract: the binding's `hostCursor` must be the
 * host-issued `frozenAt`, never home's clock. Test layer: service unit — a
 * fake host client with a skewed home clock proves the cursor origin without
 * booting two apps.
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { AttachOperation } from './attach.operation';
import { FileSyncHandoff } from './file-sync-handoff';
import { RemoteHostRequestError, type RemoteHostClient } from './remote-host.client';

const HOST_FROZEN_AT = '2026-09-22T10:00:00.000Z';
// Home runs five minutes ahead of the host; a home-made cursor would carry this time.
const HOME_NOW = '2026-09-22T10:05:00.000Z';

const operation: RemoteOperation = {
  id: 'op-retry',
  kind: 'attach',
  remoteId: 'remote-1',
  projectId: 'A',
  state: 'failed',
  steps: [],
  details: {},
  createdAt: HOST_FROZEN_AT,
  updatedAt: HOST_FROZEN_AT,
};

function makeOperation(
  host: Partial<RemoteHostClient>,
  executor = new FakeProcessExecutor(),
): AttachOperation {
  return new AttachOperation(
    { getState: () => ({ online: true, versionMatches: true }) } as never,
    {} as never,
    {
      build: jest.fn().mockResolvedValue({ ok: true, replica: {} }),
    } as never,
    host as RemoteHostClient,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    executor,
    { clear: jest.fn() } as never,
  );
}

async function runStep(
  operationInstance: AttachOperation,
  id: string,
): Promise<Record<string, unknown>> {
  const step = operationInstance.steps.find((definition) => definition.id === id);
  if (!step) throw new Error(`${id} step not found`);
  const details: Record<string, unknown> = {};
  await step.run({
    operation,
    details,
  } as Parameters<typeof step.run>[0]);
  return details;
}

describe('AttachOperation push step cursor', () => {
  let clock: jest.SpyInstance;

  beforeAll(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(HOME_NOW));
  });

  afterAll(() => {
    clock.mockRestore();
  });

  it('takes the cursor from the host freeze answer on a replay (PROJECT_EXISTS)', async () => {
    const host: Partial<RemoteHostClient> = {
      importProject: jest.fn().mockResolvedValue({ imported: false, reason: 'PROJECT_EXISTS' }),
      freeze: jest.fn().mockResolvedValue({ projectId: 'A', frozenAt: HOST_FROZEN_AT }),
    };
    const attach = makeOperation(host);

    const details = await runStep(attach, 'push_replica');

    expect(details.importCursor).toBe(HOST_FROZEN_AT);
    expect(host.freeze).toHaveBeenCalledWith('remote-1', 'A');
  });

  it('prefers the freeze answer over the import result on a first push', async () => {
    const host: Partial<RemoteHostClient> = {
      importProject: jest
        .fn()
        .mockResolvedValue({ imported: true, cursor: '2026-09-22T09:59:00.000Z' }),
      freeze: jest.fn().mockResolvedValue({ projectId: 'A', frozenAt: HOST_FROZEN_AT }),
    };
    const attach = makeOperation(host);

    const details = await runStep(attach, 'push_replica');

    expect(details.importCursor).toBe(HOST_FROZEN_AT);
  });

  it('fails the step when the freeze answer is missing, so no cursor is kept', async () => {
    const host: Partial<RemoteHostClient> = {
      importProject: jest.fn().mockResolvedValue({ imported: true, cursor: 'irrelevant' }),
      freeze: jest.fn().mockRejectedValue(new Error('freeze answer lost')),
    };
    const attach = makeOperation(host);

    await expect(runStep(attach, 'push_replica')).rejects.toThrow('freeze answer lost');
  });
});

describe('AttachOperation preflight home gate', () => {
  function makeAttachWithHealth(
    homePath: string | null,
    ensureAvailable = jest.fn().mockResolvedValue(undefined),
    bindings = {
      get: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    },
    health: { apiKeyRejected?: boolean } = {},
    host: Partial<RemoteHostClient> = { projectExists: jest.fn().mockResolvedValue(false) },
    ensureRepository = jest.fn().mockResolvedValue(false),
  ): AttachOperation {
    return new AttachOperation(
      { getState: () => ({ online: true, versionMatches: true, homePath, ...health }) } as never,
      bindings as never,
      {
        build: jest.fn().mockResolvedValue({ ok: true, replica: {} }),
      } as never,
      host as RemoteHostClient,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { ensureAvailable, ensureRepository } as never,
      {} as never,
      {} as never,
      {} as never,
      new FakeProcessExecutor(),
      { clear: jest.fn() } as never,
    );
  }

  async function runPreflight(attach: AttachOperation): Promise<void> {
    const step = attach.steps.find((definition) => definition.id === 'preflight');
    if (!step) throw new Error('preflight step not found');
    await step.run({ operation, details: {}, progress: async () => undefined } as Parameters<
      typeof step.run
    >[0]);
  }

  // The step boundary verifies durable details and retries before any copy starts.
  it('records repository creation and preserves the note on Retry', async () => {
    const ensureRepository = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const attach = makeAttachWithHealth(
      homedir(),
      undefined,
      undefined,
      {},
      undefined,
      ensureRepository,
    );
    const details: Record<string, unknown> = {};
    const progress = jest.fn(async (patch) => {
      Object.assign(details, patch);
    });
    const preflight = attach.steps.find((step) => step.id === 'preflight')!;
    const run = { operation, details, progress };
    await preflight.run(run);
    await preflight.run(run);
    expect(details.gitInit).toBe('created');
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ gitInit: 'created' }, { durable: true });
  });

  it('fails preflight with the init error and retries initialization', async () => {
    const ensureRepository = jest
      .fn()
      .mockRejectedValueOnce(new Error('fatal: permission denied'))
      .mockResolvedValueOnce(true);
    const attach = makeAttachWithHealth(
      homedir(),
      undefined,
      undefined,
      {},
      undefined,
      ensureRepository,
    );
    const details: Record<string, unknown> = {};
    const run = {
      operation,
      details,
      progress: async (patch: Record<string, unknown>) => {
        Object.assign(details, patch);
      },
    };
    const preflight = attach.steps.find((step) => step.id === 'preflight')!;
    await expect(preflight.run(run)).rejects.toThrow('fatal: permission denied');
    expect(details.gitInit).toBeUndefined();
    await preflight.run(run);
    expect(details.gitInit).toBe('created');
  });

  it('refuses an existing binding before initializing Git', async () => {
    const ensureRepository = jest.fn();
    const attach = makeAttachWithHealth(
      homedir(),
      undefined,
      {
        get: jest.fn().mockResolvedValue({ state: 'remote', remoteId: 'other' }),
        create: jest.fn(),
      },
      {},
      undefined,
      ensureRepository,
    );
    await expect(runPreflight(attach)).rejects.toMatchObject({ code: 'REMOTE_BINDING_EXISTS' });
    expect(ensureRepository).not.toHaveBeenCalled();
  });

  it("refuses a remote whose home folder differs from this PC's", async () => {
    await expect(runPreflight(makeAttachWithHealth('/home/someone-else'))).rejects.toMatchObject({
      code: 'REMOTE_HOME_MISMATCH',
      details: { homePath: '/home/someone-else' },
    });
  });

  it("refuses before any change when home's Syncthing cannot run", async () => {
    const unavailable = new Error('File sync is unavailable: Syncthing was not found on PATH');
    const bindings = { get: jest.fn(), create: jest.fn() };
    const attach = makeAttachWithHealth(
      homedir(),
      jest.fn().mockRejectedValue(unavailable),
      bindings,
    );

    await expect(runPreflight(attach)).rejects.toBe(unavailable);
    expect(bindings.get).not.toHaveBeenCalled();
    expect(bindings.create).not.toHaveBeenCalled();
  });

  it("refuses a remote that rejects this PC's API key before any change", async () => {
    const bindings = { get: jest.fn(), create: jest.fn() };
    const attach = makeAttachWithHealth(homedir(), undefined, bindings, { apiKeyRejected: true });

    await expect(runPreflight(attach)).rejects.toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
    expect(bindings.create).not.toHaveBeenCalled();
  });

  it.each([
    ['releases the copy a cancel left on this remote', 'remote-1', true],
    ['keeps a copy that no failed cancel on this remote recorded', 'remote-2', false],
  ])('%s', async (_name, failedRemoteId, released) => {
    const host = {
      projectExists: jest.fn().mockResolvedValue(true),
      freeze: jest.fn().mockResolvedValue({}),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const bindings = {
      get: jest.fn().mockResolvedValue({ state: 'failed', remoteId: failedRemoteId }),
      create: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const attach = makeAttachWithHealth(homedir(), undefined, bindings, {}, host);

    if (released) {
      await expect(runPreflight(attach)).resolves.toBeUndefined();
      expect(host.release).toHaveBeenCalledWith('remote-1', 'A');
      expect(host.freeze.mock.invocationCallOrder[0]).toBeLessThan(
        host.release.mock.invocationCallOrder[0],
      );
    } else {
      await expect(runPreflight(attach)).rejects.toMatchObject({ code: 'HOST_PROJECT_EXISTS' });
      expect(host.release).not.toHaveBeenCalled();
    }
  });

  it('allows a matching home and a remote that reports none', async () => {
    await expect(runPreflight(makeAttachWithHealth(homedir()))).resolves.toBeUndefined();
    await expect(runPreflight(makeAttachWithHealth(null))).resolves.toBeUndefined();
  });
});

describe('AttachOperation rollback managed exclusions', () => {
  function makeRollbackAttach(
    fileSync: Record<string, jest.Mock>,
    managed: { set: jest.Mock },
    docker: { rollback: jest.Mock } = { rollback: jest.fn().mockResolvedValue({}) },
    freeze: { thaw: jest.Mock } = { thaw: jest.fn() },
    host: Partial<RemoteHostClient> = {
      installGitGuard: jest.fn().mockResolvedValue({ warning: null }),
    },
  ): AttachOperation {
    return new AttachOperation(
      {} as never,
      {} as never,
      {} as never,
      host as RemoteHostClient,
      freeze as never,
      {} as never,
      {} as never,
      {} as never,
      fileSync as never,
      managed as never,
      {} as never,
      docker as never,
      new FakeProcessExecutor(),
      { clear: jest.fn() } as never,
    );
  }

  function rolledBackOperation(
    steps: Array<{ id: string; state: string }>,
    details: Record<string, unknown> = {},
  ): RemoteOperation {
    return { ...operation, steps, details } as RemoteOperation;
  }

  function removalAttempt() {
    const home = new FakeFileSyncService();
    const guarded = { active: true };
    const host = {
      syncFolderExists: jest.fn().mockResolvedValue(false),
      removeGitGuard: jest.fn(async () => ({
        removed: false,
        indexRefreshed: null,
        warning: null,
      })),
      syncDevice: jest.fn().mockRejectedValue(new Error('pair failed')),
      syncRemoveFolder: jest.fn().mockResolvedValue(undefined),
      installGitGuard: jest.fn(async () => {
        guarded.active = true;
        return { warning: null };
      }),
      projectExists: jest.fn().mockResolvedValue(true),
      freeze: jest.fn().mockResolvedValue({}),
      release: jest.fn(async () => {
        expect(guarded.active).toBe(true);
      }),
    };
    const handoff = new FileSyncHandoff(
      home as never,
      host as never,
      { get: () => [] } as never,
      { remove: async () => ({ removed: false, indexRefreshed: null, warning: null }) } as never,
      new FakeProcessExecutor(),
      { get: () => 'vm' } as never,
    );
    const details: Record<string, unknown> = { pushStarted: true };
    const started = { id: 'file_sync_initial', state: 'running', startedAt: HOST_FROZEN_AT };
    const run = {
      operation: rolledBackOperation([started], details),
      details,
      progress: async (patch: Record<string, unknown>) => void Object.assign(details, patch),
    };
    const attach = makeRollbackAttach(
      { removeFolders: jest.fn(handoff.removeFolders.bind(handoff)) },
      { set: jest.fn() },
      undefined,
      undefined,
      host,
    );
    const cancel = (state = 'failed') =>
      attach.rollback({
        ...run.operation,
        steps: [{ ...run.operation.steps[0], state }],
        details: structuredClone(details),
      } as RemoteOperation);
    return { home, guarded, host, handoff, run, cancel };
  }

  // Service-unit wiring proves cleanup from the persisted step snapshot after
  // ambiguous network effects, without filesystem or two-instance fixtures.
  it.each([
    ['DELETE response lost', false],
    ['DELETE response lost', true],
  ] as const)(
    'restores the VM guard after %s (Retry returns absent: %s)',
    async (message, retry) => {
      const { home, guarded, host, handoff, run, cancel } = removalAttempt();
      const ensure = jest.spyOn(home, 'ensureFolder');
      host.removeGitGuard.mockImplementationOnce(async () => {
        expect(run.operation.steps[0].startedAt).toBe(HOST_FROZEN_AT);
        guarded.active = false;
        throw new Error(message);
      });

      await expect(handoff.initial(run, 'A')).rejects.toThrow(message);
      expect(run.details.vmGuardRemoved).toBeUndefined();
      expect(ensure).not.toHaveBeenCalled();
      expect(host.syncDevice).not.toHaveBeenCalled();
      if (retry) {
        await expect(handoff.initial(run, 'A')).rejects.toThrow('pair failed');
        expect(host.removeGitGuard).toHaveBeenCalledTimes(2);
        expect(run.details.vmGuardRemoved).toBeUndefined();
      }

      await cancel(retry ? 'pending' : 'failed');

      expect(host.installGitGuard).toHaveBeenCalledWith('remote-1', 'A', {
        homeName: hostname(),
        reason: 'cancelled-connect',
      });
      expect(host.installGitGuard.mock.invocationCallOrder[0]).toBeLessThan(
        host.release.mock.invocationCallOrder[0],
      );
      expect(guarded.active).toBe(true);
    },
  );

  it.each(['success', 'lost'] as const)(
    'restores the VM guard when cancellation arrives before the removal answer (%s)',
    async (answer) => {
      const { guarded, host, handoff, run, cancel } = removalAttempt();
      let entered!: () => void;
      let resolveAnswer!: (result: {
        removed: boolean;
        indexRefreshed: null;
        warning: null;
      }) => void;
      let rejectAnswer!: (error: Error) => void;
      const requestStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      host.removeGitGuard.mockImplementationOnce(() => {
        guarded.active = false;
        entered();
        return new Promise((resolve, reject) => {
          resolveAnswer = resolve;
          rejectAnswer = reject;
        });
      });
      const initial = handoff.initial(run, 'A');
      await requestStarted;

      handoff.interrupt(run.operation.id);
      if (answer === 'success')
        resolveAnswer({ removed: true, indexRefreshed: null, warning: null });
      else rejectAnswer(new Error('DELETE response lost'));
      await expect(initial).rejects.toThrow(
        answer === 'success' ? 'The Connect was cancelled.' : 'DELETE response lost',
      );
      expect(run.details.vmGuardRemoved).toBe(answer === 'success' ? true : undefined);
      expect(host.syncDevice).not.toHaveBeenCalled();

      await cancel();

      expect(host.installGitGuard).toHaveBeenCalledWith('remote-1', 'A', {
        homeName: hostname(),
        reason: 'cancelled-connect',
      });
      expect(host.installGitGuard.mock.invocationCallOrder[0]).toBeLessThan(
        host.release.mock.invocationCallOrder[0],
      );
      expect(guarded.active).toBe(true);
    },
  );

  // Unit orchestration proves request ordering and best-effort cancellation policy.
  it.each(['installed', 'skipped', 'failed', 'untouched'] as const)(
    'restores the cancelled-Connect VM guard before host release (%s)',
    async (outcome) => {
      const removeFolders = jest.fn().mockResolvedValue(null);
      const host = {
        installGitGuard: jest
          .fn()
          .mockResolvedValue({ warning: outcome === 'skipped' ? 'old git' : null }),
        projectExists: jest.fn().mockResolvedValue(true),
        freeze: jest.fn().mockResolvedValue({}),
        release: jest.fn().mockResolvedValue(undefined),
      };
      if (outcome === 'failed') host.installGitGuard.mockRejectedValueOnce(new Error('VM offline'));
      const attach = makeRollbackAttach(
        { removeFolders },
        { set: jest.fn() },
        undefined,
        undefined,
        host,
      );
      const initialStep = {
        id: 'file_sync_initial',
        state: outcome === 'untouched' ? 'pending' : 'failed',
        startedAt: outcome === 'untouched' ? null : HOST_FROZEN_AT,
      };
      const result = await attach.rollback(
        rolledBackOperation([initialStep], {
          pushStarted: true,
          vmGuardRemoved: outcome !== 'untouched',
        }),
      );
      expect(host.release).toHaveBeenCalledWith('remote-1', 'A');
      if (outcome === 'untouched') {
        expect(host.installGitGuard).not.toHaveBeenCalled();
        expect(removeFolders).not.toHaveBeenCalled();
      } else {
        expect(host.installGitGuard).toHaveBeenCalledWith('remote-1', 'A', {
          homeName: hostname(),
          reason: 'cancelled-connect',
        });
        expect(removeFolders.mock.invocationCallOrder[0]).toBeLessThan(
          host.installGitGuard.mock.invocationCallOrder[0],
        );
        expect(host.installGitGuard.mock.invocationCallOrder[0]).toBeLessThan(
          host.release.mock.invocationCallOrder[0],
        );
      }
      if (outcome === 'skipped') expect(result).toMatchObject({ vmGuardWarning: 'old git' });
      if (outcome === 'failed') expect(result?.vmGuardWarning).toContain('VM offline');
    },
  );

  it('restores the set the attempt replaced, next to the folder removal', async () => {
    const removeFolders = jest.fn().mockResolvedValue(null);
    const managed = { set: jest.fn() };
    const attach = makeRollbackAttach({ removeFolders }, managed);

    await attach.rollback(
      rolledBackOperation([{ id: 'file_sync_initial', state: 'done' }], {
        managedExclusionsBefore: ['/live-data'],
      }),
    );

    expect(removeFolders).toHaveBeenCalledWith('remote-1', 'A');
    expect(managed.set).toHaveBeenCalledWith('A', ['/live-data']);
  });

  it('restores an empty previous set, and leaves an unchanged set alone', async () => {
    const managed = { set: jest.fn() };
    const attach = makeRollbackAttach({ removeFolders: jest.fn() }, managed);

    await attach.rollback(rolledBackOperation([], { managedExclusionsBefore: [] }));
    expect(managed.set).toHaveBeenCalledWith('A', []);

    managed.set.mockClear();
    await attach.rollback(rolledBackOperation([]));
    expect(managed.set).not.toHaveBeenCalled();
  });

  it('finishes the cancel when home containers do not restart, naming them', async () => {
    const removeFolders = jest.fn().mockResolvedValue(null);
    const managed = { set: jest.fn() };
    const freeze = { thaw: jest.fn() };
    const attach = makeRollbackAttach(
      { removeFolders },
      managed,
      { rollback: jest.fn().mockResolvedValue({ dockerNotRestarted: ['app-db-1'] }) },
      freeze,
    );

    const result = await attach.rollback(
      rolledBackOperation(
        [
          { id: 'freeze_home', state: 'done' },
          { id: 'file_sync_initial', state: 'done' },
        ],
        { managedExclusionsBefore: [] },
      ),
    );

    expect(result).toEqual({ dockerNotRestarted: ['app-db-1'] });
    expect(removeFolders).toHaveBeenCalled();
    expect(managed.set).toHaveBeenCalledWith('A', []);
    expect(freeze.thaw).toHaveBeenCalledWith('A');
  });

  it('finishes the cancel when the Docker cleanup itself throws', async () => {
    const freeze = { thaw: jest.fn() };
    const attach = makeRollbackAttach(
      { removeFolders: jest.fn().mockResolvedValue(null) },
      { set: jest.fn() },
      { rollback: jest.fn().mockRejectedValue(new Error('Docker record unreadable')) },
      freeze,
    );

    const result = await attach.rollback(
      rolledBackOperation([{ id: 'freeze_home', state: 'done' }]),
    );

    expect(result).toEqual({ dockerCleanupError: 'Docker record unreadable' });
    expect(freeze.thaw).toHaveBeenCalledWith('A');
  });
});

describe('AttachOperation Docker steps', () => {
  const docker = {
    rollback: jest.fn().mockResolvedValue({ dockerCleanupError: 'VM unreachable' }),
    interrupt: jest.fn(),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  const fileSync = { interrupt: jest.fn() };
  const attach = () => {
    const unused = {} as never;
    return new AttachOperation(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      fileSync as never,
      unused,
      { interrupt: jest.fn() } as never,
      docker as never,
      new FakeProcessExecutor(),
      { clear: jest.fn() } as never,
    );
  };

  it('orders the Docker steps around the handoff and skips them without a selection', () => {
    const steps = attach().steps;
    const ids = steps.map((step) => step.id);
    const after = (id: string, previous: string) =>
      expect(ids.indexOf(id)).toBe(ids.indexOf(previous) + 1);
    after('docker_preflight', 'git_config');
    after('docker_stop_home', 'stop_home_sessions');
    after('docker_push', 'transcripts_push');
    after('docker_create_host', 'file_sync_flip');
    const docker = steps.filter((step) => step.id.startsWith('docker_'));
    expect(docker.every((step) => step.skip?.({}) === true)).toBe(true);
    expect(docker.every((step) => step.skip?.({ dockerSelection: { items: [] } }) === true)).toBe(
      true,
    );
    const selected = { dockerSelection: { items: [{ id: 'c', mode: 'container-and-data' }] } };
    expect(docker.every((step) => step.skip?.(selected) === false)).toBe(true);
  });

  it('aborts Docker transfers on cancel and removes the settings file at the end', async () => {
    const operation = attach();
    await operation.interrupt('op');
    expect(docker.interrupt).toHaveBeenCalledWith('op');
    await operation.completed({ id: 'op' } as RemoteOperation);
    expect(docker.finish).toHaveBeenCalledWith('op');
    operation.forget('op-2');
    expect(docker.finish).toHaveBeenCalledWith('op-2');
  });

  it('aborts the file sync waits on cancel', async () => {
    await attach().interrupt('op');

    expect(fileSync.interrupt).toHaveBeenCalledWith('op');
  });
});

describe('AttachOperation git config step', () => {
  const GLOBAL_LIST = 'user.name\nAlice Example\0user.email\nalice@example.com\0';
  const RENDERED = '[user]\n\tname = "Alice Example"\n\temail = "alice@example.com"\n';

  const acceptingHost = (): Partial<RemoteHostClient> => ({
    applyProviderAuth: jest.fn().mockResolvedValue(undefined),
  });

  it('runs right after preflight', () => {
    const ids = makeOperation({}).steps.map((step) => step.id);
    expect(ids.indexOf('git_config')).toBe(ids.indexOf('preflight') + 1);
  });

  it('sends the rendered global config as ~/.gitconfig and records sent', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: GLOBAL_LIST });
    const host = acceptingHost();

    const details = await runStep(makeOperation(host, executor), 'git_config');

    expect(details.gitConfig).toBe('sent');
    expect(host.applyProviderAuth).toHaveBeenCalledWith('remote-1', {
      env: {},
      files: [
        {
          path: join(homedir(), '.gitconfig'),
          mode: '0600',
          contentBase64: Buffer.from(RENDERED, 'utf8').toString('base64'),
        },
      ],
    });
  });

  it('records not_set_on_pc and sends nothing when this PC has no global config', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'failure', exitCode: 1 });
    const host = acceptingHost();

    const details = await runStep(makeOperation(host, executor), 'git_config');

    expect(details.gitConfig).toBe('not_set_on_pc');
    expect(host.applyProviderAuth).not.toHaveBeenCalled();
  });

  it('records failed with the message and keeps the Connect going when the write fails', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: GLOBAL_LIST });
    const host: Partial<RemoteHostClient> = {
      applyProviderAuth: jest.fn().mockRejectedValue(
        new RemoteHostRequestError('The VM refused the write.', {
          remoteId: 'remote-1',
          path: '/api/host/provider-auth',
          status: 409,
          hostCode: null,
        }),
      ),
    };

    const details = await runStep(makeOperation(host, executor), 'git_config');

    expect(details.gitConfig).toBe('failed');
    expect(details.gitConfigError).toBe('The VM refused the write.');
  });
});
