// Four booted graphs and a separate production SQLite importer are the cheapest
// reliable layer for cross-home delivery, occupancy reconciliation and WAL order.
import fs from 'node:fs';
import { SharedVmGuardFixture } from '../../../common/test/shared-vm-guard.fixture';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { RemoteSharedVmService } from '../services/remote-shared-vm.service';
import { RemoteHealthService } from '../services/remote-health.service';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteForcedDetachStore } from '../services/remote-forced-detach.store';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { ProjectReplicaV1 } from '@devchain/shared';
import { replicaSeeder } from '../replica/__fixtures__/replica-seed';

jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  userInfo: () => ({ ...jest.requireActual('node:os').userInfo(), username: 'alice' }),
}));

// Four app graphs and a cold TypeScript worker can exceed Jest's unit-test
// budget under parallel load. The actor gate remains independently bounded.
jest.setTimeout(30_000);

describe('shared VM guard across two homes and two VM instances', () => {
  let fixture: SharedVmGuardFixture;
  beforeEach(async () => {
    fixture = new SharedVmGuardFixture();
    await fixture.start();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  async function replica(): Promise<ProjectReplicaV1> {
    const project = await fixture.bob.home.storage.createProject({
      name: 'Racing import',
      description: null,
      isTemplate: false,
      rootPath: `${fixture.bob.home.dataDir}/racing-project`,
    });
    const built = await fixture.bob.home.app
      .get(ProjectReplicaBuilder)
      .build({ projectIds: [project.id], scope: 'attach' });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    return built.replica;
  }

  async function start(action: 'reset' | 'destroy-vm', payload: Record<string, unknown> = {}) {
    return fixture.alice.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${fixture.aliceRemoteId}/${action}`,
      payload,
    });
  }

  it('counts a pre-fence admitted import that commits after the final roster request starts', async () => {
    const data = await replica();
    let importing!: Awaited<ReturnType<SharedVmGuardFixture['importOnBob']>>;
    fixture.onPull = async () => {
      importing = await fixture.importOnBob(data, true);
      await importing.admitted;
      expect(fixture.importPhases.map(({ phase }) => phase)).toEqual(['ready', 'admitted']);
    };
    const response = await start('destroy-vm');
    expect(response.statusCode).toBe(202);
    const root = response.json<RemoteOperation>();
    await fixture.settle(root.id);
    expect(await importing.done).toMatchObject({ committed: true });
    const last = fixture.alice.home.app
      .get(RemoteSharedVmService)
      .lastRoster(fixture.aliceRemoteId)!;
    expect({
      phases: fixture.importPhases,
      projectIds: last.roster.instances.find(({ user }) => user === 'bob')?.connectedProjectIds,
    }).toMatchObject({ projectIds: [data.tables.projects[0].id] });
    expect(fixture.deletions).toEqual([]);
    const stopped = await fixture.alice.home.storage.getRemoteOperation(root.id);
    expect(stopped.steps.find(({ id }) => id === 'destroy')).toMatchObject({
      state: 'failed',
      error: { code: 'VM_SHARED_PROJECTS_CONNECTED' },
    });
    expect(fs.existsSync(fixture.fenceFile)).toBe(false);
  });

  it('refuses B import when A sets its fence first, so the empty final roster omits no commit', async () => {
    const data = await replica();
    let outcome!: Awaited<ReturnType<SharedVmGuardFixture['importOnBob']>>;
    fixture.onFence = async () => {
      outcome = await fixture.importOnBob(data);
      await outcome.done;
    };
    const response = await start('destroy-vm');
    expect(response.statusCode).toBe(202);
    await fixture.settle(response.json<RemoteOperation>().id);
    expect(await outcome.done).toMatchObject({
      committed: false,
      code: 'VM_DESTROY_PENDING',
      message: expect.stringContaining('alice'),
    });
    await expect(fixture.bob.host.storage.getProject(data.tables.projects[0].id)).rejects.toThrow();
    expect(
      fixture.alice.home.app
        .get(RemoteSharedVmService)
        .lastRoster(fixture.aliceRemoteId)
        ?.roster.instances.find(({ user }) => user === 'bob')?.connectedProjectIds,
    ).toEqual([]);
    expect(fixture.deletions).toHaveLength(1);
  });

  it('returns a bounded unavailable snapshot instead of zero when the admitted writer outlasts lock acquisition', async () => {
    fixture.countDb.pragma('busy_timeout = 30');
    const data = await replica();
    let importing!: Awaited<ReturnType<SharedVmGuardFixture['importOnBob']>>;
    fixture.onPull = async () => {
      importing = await fixture.importOnBob(data, true, 250);
      await importing.admitted;
    };
    const response = await start('destroy-vm');
    expect(response.statusCode).toBe(202);
    await fixture.settle(response.json<RemoteOperation>().id);
    expect(await importing.done).toMatchObject({ committed: true });
    expect(fixture.countStatuses).toContain(503);
    expect(
      fixture.alice.home.app
        .get(RemoteSharedVmService)
        .lastRoster(fixture.aliceRemoteId)
        ?.roster.instances.find(({ user }) => user === 'bob'),
    ).toMatchObject({ connectedCount: 'unknown', connectedProjectIds: 'unknown' });
    expect(fixture.deletions).toEqual([]);
    expect(fs.existsSync(fixture.fenceFile)).toBe(false);
  });

  it.each(['reset', 'destroy-vm'] as const)(
    '%s refuses B work, delivers Notify to B home, and reaches Proxmox only after explicit occupancy force',
    async (action) => {
      replicaSeeder(fixture.bob.host.sqlite).seedProject('bob-project');
      const refused = await start(action);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        code: 'VM_SHARED_PROJECTS_CONNECTED',
        message: expect.stringContaining('bob (1 projects)'),
      });
      const context = await fixture.alice.home.app.inject({
        url: `/api/remotes/${fixture.aliceRemoteId}/shared-vm`,
      });
      const notify = await fixture.alice.home.app.inject({
        method: 'POST',
        url: `/api/remotes/${fixture.aliceRemoteId}/shared-vm/notify`,
        payload: { action: action === 'reset' ? 'reset' : 'destroy', message: 'Save your work' },
      });
      expect(notify.statusCode).toBe(200);
      expect(notify.json()).toEqual({ results: [{ user: 'bob', delivered: true }] });
      await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
      const inbox = await fixture.bob.home.app.inject({ url: '/api/remotes/notices' });
      expect(inbox.json().notices).toEqual([
        expect.objectContaining({
          remoteId: fixture.bobRemoteId,
          fromUser: 'alice',
          action: action === 'reset' ? 'reset' : 'destroy',
          message: 'Save your work',
        }),
      ]);
      const forced = await start(action, {
        forceOccupied: true,
        confirmedOccupancy: context.json().occupancy,
      });
      expect(forced.statusCode).toBe(202);
      await fixture.settle(forced.json<RemoteOperation>().id);
      expect(fixture.deletions).toHaveLength(1);
      await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
      const after = await fixture.bob.home.app.inject({ url: '/api/remotes/notices' });
      expect(after.json().notices).toContainEqual(
        expect.objectContaining({ fromUser: 'alice', action: 'forced' }),
      );
    },
  );

  it.each([
    ['online', 'reset'],
    ['online', 'destroy-vm'],
    ['offline', 'reset'],
    ['offline', 'destroy-vm'],
  ] as const)(
    'reconciles B %s forced Disconnect before admitting A normal %s',
    async (connectivity, action) => {
      replicaSeeder(fixture.bob.host.sqlite).seedProject('bob-disconnect');
      await fixture.bob.bindProject('bob-disconnect', fixture.bobRemoteId);
      await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
      expect((await start(action)).statusCode).toBe(409);
      if (connectivity === 'offline') {
        await fixture.bob.host.close();
        await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
      }
      const detach = await fixture.bob.home.app.inject({
        method: 'POST',
        url: `/api/remotes/${fixture.bobRemoteId}/detach`,
        payload: { projectId: 'bob-disconnect', force: true },
      });
      expect(detach.statusCode).toBe(202);
      const child = detach.json<RemoteOperation>();
      await fixture.bob.home.app.get(RemoteOperationRunner).whenIdle(child.id);
      expect((await fixture.bob.home.storage.getRemoteOperation(child.id)).state).toBe('done');
      if (connectivity === 'offline') {
        expect(fixture.bob.home.app.get(RemoteForcedDetachStore).pending()).toEqual([
          { remoteId: fixture.bobRemoteId, projectId: 'bob-disconnect' },
        ]);
        expect((await start(action)).statusCode).toBe(409);
        await fixture.bob.restartHost();
        await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
      }
      expect(fixture.bob.home.app.get(RemoteForcedDetachStore).pending()).toEqual([]);
      expect(await fixture.bob.host.storage.getProject('bob-disconnect')).toMatchObject({
        id: 'bob-disconnect',
      });
      const allowed = await start(action);
      expect(allowed.statusCode).toBe(202);
      await fixture.settle(allowed.json<RemoteOperation>().id);
      expect(fixture.deletions).toHaveLength(1);
    },
  );

  it('runs Disconnect all through the API with two real children and releases both VM project rows', async () => {
    for (const id of ['first', 'second']) {
      replicaSeeder(fixture.bob.host.sqlite).seedProject(id);
      await fixture.bob.bindProject(id, fixture.bobRemoteId);
    }
    await fixture.bob.home.app.get(RemoteHealthService).refresh(fixture.bobRemoteId);
    const response = await fixture.bob.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${fixture.bobRemoteId}/disconnect-all`,
      payload: { force: false, projects: [{ projectId: 'first' }, { projectId: 'second' }] },
    });
    expect(response.statusCode).toBe(202);
    const parent = response.json<RemoteOperation>();
    await fixture.bob.home.app.get(RemoteOperationRunner).whenIdle(parent.id);
    const done = await fixture.bob.home.storage.getRemoteOperation(parent.id);
    expect(done.steps.find(({ state }) => state === 'failed')?.error).toBeUndefined();
    expect(done.state).toBe('done');
    const children = done.details.projects as Array<{ projectId: string; operationId: string }>;
    expect(children.map(({ projectId }) => projectId)).toEqual(['first', 'second']);
    expect(new Set(children.map(({ operationId }) => operationId)).size).toBe(2);
    for (const child of children) {
      expect(await fixture.bob.home.storage.getRemoteOperation(child.operationId)).toMatchObject({
        kind: 'detach',
        state: 'done',
        projectId: child.projectId,
        details: { parentOperationId: parent.id },
      });
      expect(await fixture.bob.home.storage.getRemoteProjectBinding(child.projectId)).toBeNull();
      await expect(fixture.bob.host.storage.getProject(child.projectId)).rejects.toThrow();
    }
    expect(
      await fixture.alice.home.app
        .get(RemoteSharedVmService)
        .assertAllowed(fixture.aliceRemoteId, {}),
    ).toMatchObject({
      unavailable: false,
      instances: [
        expect.objectContaining({ user: 'bob', connectedCount: 0, connectedProjectIds: [] }),
      ],
    });
  });
});
