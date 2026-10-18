import { sharedVmGuardStub } from '../../../common/test/shared-vm.stub';
/**
 * SQLite integration is the cheapest layer that exercises saved parent/child
 * rows, runner restarts and real detach lifecycle hooks. Only external host,
 * file-sync and Docker effects are replaced; copy-back records use the real store.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { DockerHandoffStore, type DockerCopyBackRecord } from '../docker/docker-handoff.store';
import { DetachOperation } from './detach.operation';
import { DisconnectAllOperation, type DisconnectAllDetails } from './disconnect-all.operation';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteOperationsService } from './remote-operations.service';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import type { RemoteOperationStepRun } from './remote-operation.types';
import { VmOperationsService } from './vm-operations.service';
import type { DisconnectAllData } from './remote-operation.dto';
import { createApiTestApp } from '../../../common/test/api-test-app';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('Disconnect all child lifecycle', () => {
  let sqlite: Database.Database;
  let directory: string;
  let storage: LocalStorageService;
  let runner: RemoteOperationRunner;
  let operations: RemoteOperationsService;
  let records: DockerHandoffStore;
  let remoteId: string;
  let projectIds: string[];
  let heldProject: string | null;
  let heldStep: string;
  let entered: ReturnType<typeof gate>;
  let release: ReturnType<typeof gate>;
  let childInterrupted: ReturnType<typeof gate>;
  let failProject: string | null;
  let failureCode: string;
  let failThaw: string | null;
  let copied: Array<{ id: string; projectId: string; record: DockerCopyBackRecord }>;
  let hostCalls: string[];
  let completed: string[];
  let online: boolean;

  async function pause(step: string, projectId: string): Promise<void> {
    if (heldProject === projectId && heldStep === step) {
      entered.resolve();
      await release.promise;
    }
  }

  function configureRunner(): void {
    const detach = new DetachOperation(
      { getState: () => ({ online, versionMatches: true }) } as never,
      {
        get: (id: string) => storage.getRemoteProjectBinding(id),
        update: (id: string, patch: never) => storage.updateRemoteProjectBinding(id, patch),
        delete: async (id: string) => {
          await pause('unbind', id);
          return storage.deleteRemoteProjectBinding(id);
        },
      } as never,
      { apply: async () => undefined } as never,
      {
        freeze: async () => undefined,
        thaw: async () => undefined,
        stopSessions: async () => undefined,
        settleTime: async () => ({}),
        exportReplica: async () => ({ generatedAt: '2026-10-12T12:00:00.000Z' }),
        release: async (_remote: string, id: string) => {
          hostCalls.push(id);
          await pause('host_release', id);
        },
      } as never,
      {
        thaw: async (projectId: string) => {
          if (failThaw === projectId) throw new Error('home thaw failed');
        },
      } as never,
      { stop: async () => undefined, start: () => undefined } as never,
      {
        final: async ({ operation }: RemoteOperationStepRun) => {
          await pause('file_sync_final', operation.projectId!);
          if (operation.projectId === failProject) {
            failProject = null;
            throw new RemoteOperationStepRefusedError(failureCode, 'copy check failed');
          }
        },
        flipToHome: async () => undefined,
        flipBackToHost: async () => undefined,
        forcedLoss: async () => ({}),
      } as never,
      { copy: async () => undefined, interrupt: () => childInterrupted.resolve() } as never,
      { stopHost: async () => undefined, interrupt: () => undefined } as never,
      {
        prepareHomeCopy: async () => undefined,
        copyHome: async (run: RemoteOperationStepRun) => {
          const id = run.operation.id;
          const record = (await records.readCopyBack(id)) ?? {
            apiVersion: '1.45',
            groups: Object.entries(
              (run.details.dockerCopyBack as { choices: Record<string, 'copy-home' | 'keep-home'> })
                .choices,
            ).map(([key, action]) => ({
              key,
              action,
              label: run.operation.projectId!,
              state: 'both-changed' as const,
              volumes: [run.operation.projectId!],
              bindPaths: [],
              images: [],
              sizeBytes: 1,
            })),
            projectContainers: [],
            started: [],
            verified: {},
            absent: [],
            decidedAt: 'now',
          };
          await records.writeCopyBack(id, record);
          copied.push({ id, projectId: run.operation.projectId!, record });
          await run.progress({ copyRecordReady: true }, { durable: true });
          await pause('docker_copy_home', run.operation.projectId!);
        },
        finish: async (id: string) => {
          completed.push(id);
          await records.remove(id);
        },
        partialGroups: async () => [],
        interrupt: () => undefined,
      } as never,
      { get: () => 'home', clear: () => undefined } as never,
      {
        assertRemoteEmpty: async () => undefined,
        freezeRemoteEmpty: async (
          _remote: string,
          _project: string,
          checkpoint: () => Promise<void>,
        ) => {
          await checkpoint();
          return null;
        },
        thawRemoteAdmission: async () => true,
      } as never,
      { record: async () => undefined, flush: async () => undefined } as never,
    );
    runner = new RemoteOperationRunner(
      storage,
      { broadcastEvent: () => undefined },
      { kind: 'attach', steps: [] } as never,
      detach,
      { kind: 'claim', steps: [] } as never,
      { kind: 'update_host', steps: [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new DisconnectAllOperation(storage),
    );
    operations = new RemoteOperationsService(
      storage,
      runner,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { recordAttach: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'disconnect-all-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(
      database.db,
      new IntegrationCredentialCipher({ secretDirectory: directory }),
    );
    records = new DockerHandoffStore(directory);
    remoteId = (
      await storage.createRemote({
        name: 'VM',
        kind: 'address',
        baseUrl: 'https://vm.example:3000',
      })
    ).id;
    projectIds = [];
    for (const name of ['one', 'two', 'three']) {
      const project = await storage.createProject({
        name,
        description: null,
        rootPath: join(directory, name),
        isTemplate: false,
      });
      projectIds.push(project.id);
      await storage.createRemoteProjectBinding({ projectId: project.id, remoteId });
      await storage.updateRemoteProjectBinding(project.id, { state: 'remote' });
    }
    heldProject = null;
    heldStep = '';
    entered = gate();
    release = gate();
    childInterrupted = gate();
    failProject = null;
    failureCode = 'COPY_CHECK_FAILED';
    failThaw = null;
    copied = [];
    completed = [];
    hostCalls = [];
    online = true;
    configureRunner();
  });

  afterEach(async () => {
    release.resolve();
    for (const operation of await storage.listRemoteOperations())
      await runner.whenIdle(operation.id);
    runner.onApplicationShutdown();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function batchInput(force = false): DisconnectAllData {
    return {
      force,
      projects: projectIds.map((projectId, i) => ({
        projectId,
        dockerCopyBack: { choices: { '0123456789abcdef': i === 0 ? 'copy-home' : 'keep-home' } },
      })),
    };
  }

  function start(force = false) {
    return operations.disconnectAll(remoteId, batchInput(force));
  }

  async function settle(id: string) {
    await runner.whenIdle(id);
    return storage.getRemoteOperation(id);
  }

  async function children(id: string) {
    return (await storage.listRemoteOperations({ remoteId })).filter(
      (child) => child.details.parentOperationId === id,
    );
  }

  it('keeps per-project Docker choices and records separate and completes every child lifecycle', async () => {
    const requested = batchInput();
    const parent = await operations.disconnectAll(remoteId, requested);
    requested.projects[1].dockerCopyBack!.choices['0123456789abcdef'] = 'copy-home';
    requested.projects.pop();
    expect((await settle(parent.id)).state).toBe('done');
    const rows = await children(parent.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.every((row) => row.state === 'done')).toBe(true);
    const history = await operations.list({ state: 'done' });
    expect(
      history.find((row) => row.id === parent.id)?.children?.map((child) => child.projectId),
    ).toEqual(projectIds);
    expect(
      copied.map(({ projectId, record }) => [
        projectId,
        record.groups[0].action,
        record.groups[0].label,
      ]),
    ).toEqual([
      [projectIds[0], 'copy-home', projectIds[0]],
      [projectIds[1], 'keep-home', projectIds[1]],
      [projectIds[2], 'keep-home', projectIds[2]],
    ]);
    expect(completed).toEqual(copied.map((copy) => copy.id));
    for (const row of rows) expect(await records.readCopyBack(row.id)).toBeNull();
    expect(await records.readCopyBack(parent.id)).toBeNull();
    expect(await storage.listRemoteProjectBindings()).toEqual([]);
  });

  it('resumes the second child after reopening SQLite and restarting the runner', async () => {
    heldProject = projectIds[1];
    heldStep = 'docker_copy_home';
    const parent = await start();
    await entered.promise;
    const before = await children(parent.id);
    const second = before.find((child) => child.projectId === projectIds[1])!;
    expect((await records.readCopyBack(second.id))?.groups[0].label).toBe(projectIds[1]);
    runner.onApplicationShutdown();
    release.resolve();
    await runner.whenIdle(parent.id);
    const snapshot = sqlite.serialize();
    sqlite.close();
    sqlite = new Database(snapshot);
    storage = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({ secretDirectory: directory }),
    );
    heldProject = null;
    configureRunner();
    await runner.onApplicationBootstrap();
    expect((await settle(parent.id)).state).toBe('done');
    const after = await children(parent.id);
    expect(after.find((child) => child.projectId === projectIds[1])?.id).toBe(second.id);
    expect(copied.filter((copy) => copy.projectId === projectIds[0])).toHaveLength(1);
    expect(after).toHaveLength(3);
    expect(await storage.listRemoteProjectBindings()).toEqual([]);
  });

  it('pauses on a failed child and Retry continues without repeating done projects', async () => {
    failProject = projectIds[1];
    const parent = await start();
    expect((await settle(parent.id)).state).toBe('failed');
    const paused = await children(parent.id);
    expect(paused.map((row) => row.state).sort()).toEqual(['done', 'failed']);
    expect(await storage.getRemoteProjectBinding(projectIds[2])).toMatchObject({ state: 'remote' });
    await operations.retry(parent.id);
    expect((await settle(parent.id)).state).toBe('done');
    expect(copied.filter((copy) => copy.projectId === projectIds[0])).toHaveLength(1);
    expect((await children(parent.id)).map((row) => row.state)).toEqual(['done', 'done', 'done']);
  });

  it.each(['done', 'cancelled'] as const)(
    'Retry accepts a failed child that has since become %s',
    async (state) => {
      failProject = projectIds[1];
      const parent = await start();
      await settle(parent.id);
      const failed = (await children(parent.id)).find((row) => row.state === 'failed')!;
      if (state === 'done') {
        await runner.retry(failed.id);
        await runner.whenIdle(failed.id);
      } else await runner.cancel(failed.id);
      await operations.retry(parent.id);
      expect((await settle(parent.id)).state).toBe('done');
      expect((await storage.getRemoteOperation(failed.id)).state).toBe(state);
      expect(await storage.getRemoteProjectBinding(projectIds[2])).toBeNull();
    },
  );

  it.each(['file_sync_final', 'host_release', 'unbind'])(
    'Cancel at %s stops queued projects and follows the active child rules',
    async (step) => {
      heldProject = projectIds[1];
      heldStep = step;
      const parent = await start(step === 'unbind');
      await entered.promise;
      const savedCancellation = gate();
      const update = storage.updateRemoteOperation.bind(storage);
      jest.spyOn(storage, 'updateRemoteOperation').mockImplementation(async (id, patch) => {
        const saved = await update(id, patch);
        if (id === parent.id && saved.details.cancelRequested) savedCancellation.resolve();
        return saved;
      });
      const cancelled = operations.cancel(parent.id);
      await (step === 'file_sync_final' ? childInterrupted.promise : savedCancellation.promise);
      release.resolve();
      expect((await cancelled).state).toBe('cancelled');
      const rows = await children(parent.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.projectId === projectIds[0])?.state).toBe('done');
      expect(rows.find((row) => row.projectId === projectIds[1])?.state).toBe(
        step === 'file_sync_final' ? 'cancelled' : 'done',
      );
      expect(await storage.getRemoteProjectBinding(projectIds[2])).toMatchObject({
        state: 'remote',
      });
      expect(await storage.getRemoteProjectBinding(projectIds[1])).toEqual(
        step === 'file_sync_final' ? expect.objectContaining({ state: 'remote' }) : null,
      );
    },
  );

  it('persists cancellation during an irreversible child so restart finishes it without starting queued projects', async () => {
    heldProject = projectIds[1];
    heldStep = 'host_release';
    const parent = await start();
    await entered.promise;
    const cancellationSaved = gate();
    const update = storage.updateRemoteOperation.bind(storage);
    jest.spyOn(storage, 'updateRemoteOperation').mockImplementation(async (id, patch) => {
      const saved = await update(id, patch);
      if (id === parent.id && saved.details.cancelRequested) cancellationSaved.resolve();
      return saved;
    });
    const cancelling = operations.cancel(parent.id);
    await cancellationSaved.promise;
    runner.onApplicationShutdown();
    release.resolve();
    await cancelling.catch(() => undefined);
    heldProject = null;
    configureRunner();
    await runner.onApplicationBootstrap();
    expect((await settle(parent.id)).state).toBe('cancelled');
    expect((await children(parent.id)).find((row) => row.projectId === projectIds[1])?.state).toBe(
      'done',
    );
    expect(await storage.getRemoteProjectBinding(projectIds[2])).toMatchObject({ state: 'remote' });
  });

  it('uses forced detaches without Docker copy-back when the VM is offline', async () => {
    online = false;
    const parent = await start(true);
    expect((await settle(parent.id)).state).toBe('done');
    expect(copied).toEqual([]);
    expect(hostCalls).toEqual([]);
    expect(
      (await children(parent.id)).every(
        (child) => child.details.force === true && child.details.dockerCopyBack === undefined,
      ),
    ).toBe(true);
    expect(await storage.listRemoteProjectBindings()).toEqual([]);
  });

  it('Retry finishes a failed cancellation without disconnecting queued projects', async () => {
    failThaw = projectIds[1];
    const parent = await start(true);
    expect((await settle(parent.id)).state).toBe('failed');
    await expect(operations.cancel(parent.id)).rejects.toMatchObject({
      details: { code: 'DISCONNECT_ALL_CHILD_UNFINISHED' },
    });
    expect((await storage.getRemoteOperation(parent.id)).details.cancelRequested).toBe(true);
    failThaw = null;
    await operations.retry(parent.id);
    expect((await settle(parent.id)).state).toBe('cancelled');
    expect((await children(parent.id)).every((child) => child.state === 'done')).toBe(true);
    expect(await storage.getRemoteProjectBinding(projectIds[2])).toMatchObject({ state: 'remote' });
  });

  it('keeps a stale Docker choice paused on Retry until Cancel and a fresh batch', async () => {
    failProject = projectIds[1];
    failureCode = 'DOCKER_COPY_BACK_CHOICE_REQUIRED';
    const parent = await start();
    await settle(parent.id);
    const failed = (await children(parent.id)).find((child) => child.state === 'failed')!;
    await operations.retry(parent.id);
    expect((await settle(parent.id)).state).toBe('failed');
    expect((await storage.getRemoteOperation(failed.id)).state).toBe('failed');
    await operations.cancel(parent.id);
    projectIds = projectIds.slice(1);
    expect((await settle((await start()).id)).state).toBe('done');
  });

  it.each(['running', 'failed'] as const)(
    'refuses user operations and child controls while a batch is %s',
    async (state) => {
      heldProject = projectIds[0];
      heldStep = 'file_sync_final';
      if (state === 'failed') failProject = projectIds[0];
      const parent = await start();
      await entered.promise;
      if (state === 'failed') {
        release.resolve();
        await settle(parent.id);
      }
      for (const action of [
        () => operations.attach(remoteId, projectIds[2]),
        () => operations.detach(remoteId, projectIds[2], true),
        () => operations.updateHost(remoteId),
        () => operations.updateLogins(remoteId, { force: false, providerAuth: {} }),
        () => start(),
      ])
        await expect(action()).rejects.toMatchObject({
          details: { code: 'REMOTE_OPERATION_IN_PROGRESS' },
        });
      const child = (await children(parent.id))[0];
      for (const action of [() => operations.retry(child.id), () => operations.cancel(child.id)])
        await expect(action()).rejects.toMatchObject({
          details: { code: 'REMOTE_OPERATION_OWNED_BY_PARENT' },
        });
      release.resolve();
    },
  );

  it.each(['this VM', 'another VM'])(
    'refuses a bound project operation targeting %s before starting any children',
    async (target) => {
      const targetId =
        target === 'this VM'
          ? remoteId
          : (
              await storage.createRemote({
                name: 'other',
                kind: 'address',
                baseUrl: 'https://other.example:3000',
              })
            ).id;
      await storage.createRemoteOperation({
        kind: 'attach',
        remoteId: targetId,
        projectId: projectIds[1],
        details: {},
        steps: [],
      });
      const parent = await start();
      const failed = await settle(parent.id);
      expect(failed.steps[0].error?.code).toBe('DISCONNECT_ALL_PROJECT_OPERATION_OPEN');
      expect(await children(parent.id)).toEqual([]);
    },
  );

  it('refuses changed bindings instead of disconnecting a partial snapshot', async () => {
    const parent = await operations.disconnectAll(remoteId, {
      force: false,
      projects: [{ projectId: projectIds[0] }],
    });
    expect((await settle(parent.id)).steps[0].error?.code).toBe('DISCONNECT_ALL_BINDINGS_CHANGED');
    expect(await children(parent.id)).toEqual([]);
  });

  it('Destroy cannot take over a failed batch after its last binding has been removed', async () => {
    const connection = await storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'Lab',
      apiUrl: 'https://proxmox.example',
      node: 'node',
      pool: 'pool',
      storage: 'local',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 200,
      namePrefix: 'dc-',
      tag: 'devchain',
      sslFingerprint: '0'.repeat(64),
      tokenId: 'devchain@pve!agent',
      tokenSecret: 'secret',
    });
    remoteId = (
      await storage.createRemote({
        name: 'managed',
        baseUrl: 'https://vm.example:3000',
        kind: 'proxmox',
        vmProviderConnectionId: connection.id,
        vmIdentity: 'vm-100',
        vmSpec: { cores: 2, memory: 4096, disk: 30 },
      })
    ).id;
    for (const projectId of projectIds) {
      await storage.deleteRemoteProjectBinding(projectId);
      await storage.createRemoteProjectBinding({ projectId, remoteId });
      await storage.updateRemoteProjectBinding(projectId, { state: 'remote' });
    }
    failThaw = projectIds[2];
    const parent = await start(true);
    await settle(parent.id);
    expect(await storage.listRemoteProjectBindings()).toEqual([]);
    const destroy = new VmOperationsService(
      storage,
      runner,
      operations,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sharedVmGuardStub(),
    );
    await expect(destroy.destroy(remoteId, { force: false })).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS' },
    });
    expect((await storage.getRemoteOperation(parent.id)).state).toBe('failed');
  });
});

// Booted app integration covers the HTTP validation and DI wiring together.
it('POST disconnect-all persists a forced batch through the real controller and module', async () => {
  const fixture = await createApiTestApp();
  try {
    const remote = await fixture.storage.createRemote({
      name: 'offline',
      kind: 'address',
      baseUrl: 'https://127.0.0.1:1',
    });
    const project = await fixture.storage.createProject({
      name: 'project',
      description: null,
      rootPath: fixture.rootDir,
      isTemplate: false,
    });
    await fixture.storage.createRemoteProjectBinding({
      projectId: project.id,
      remoteId: remote.id,
    });
    await fixture.storage.updateRemoteProjectBinding(project.id, { state: 'remote' });
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/remotes/${remote.id}/disconnect-all`,
      payload: { force: true, projects: [{ projectId: project.id }] },
    });
    expect(response.statusCode).toBe(202);
    const parent = response.json<RemoteOperation>();
    expect(parent.kind).toBe('disconnect_all');
    expect((parent.details as unknown as DisconnectAllDetails).projects[0].operationId).not.toBe(
      parent.id,
    );
    await fixture.app.get(RemoteOperationRunner).whenIdle(parent.id);
    expect((await fixture.storage.getRemoteOperation(parent.id)).state).toBe('done');
  } finally {
    await fixture.close();
  }
});
