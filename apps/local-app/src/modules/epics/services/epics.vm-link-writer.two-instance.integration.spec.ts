/**
 * Home UI link writes of a project a claimed VM of this version owns: the VM is seeded,
 * then writes the epic and link itself, and home's mirror learns them by pull.
 * Test layer: two-instance integration. The seed push, the VM's host routes, its
 * receipts and home's mirror pull meet only in two booted apps.
 */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { IntegrationVmCacheService } from '../../external-integrations/vm-cache/integration-vm-cache.service';
import { HostApiKeyService } from '../../remotes/host/host-api-key.service';
import { HostHelperService } from '../../remotes/host/host-helper.service';
import { RemoteHostClient } from '../../remotes/operations/remote-host.client';
import { T, replicaSeeder } from '../../remotes/replica/__fixtures__/replica-seed';
import { RemoteHealthService } from '../../remotes/services/remote-health.service';
import { RemoteIntegrationPushService } from '../../remotes/services/remote-integration-push.service';
import {
  REMOTE_MIRROR_SYNC_PORT,
  type RemoteMirrorSyncPort,
} from '../../remotes/ports/remote-mirror-sync.port';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import type { Remote, RemoteOperation } from '../../storage/models/domain.models';

const PROJECT = '5a1e0000-0000-4000-8000-0000000000a1';
const STATUS = '5a1e0000-0000-4000-8000-0000000000a2';
const SCOPE = 'acme.atlassian.net';
const TMPFS = 0x01021994;

// Both apps share `process.env`, so a real claim record would also make home a VM;
// these seams claim only the host.
@Injectable()
class ClaimedHelper extends HostHelperService {
  override assertClaimedHost(): void {}
}
@Injectable()
class ClaimedIntegrationCache extends IntegrationVmCacheService {
  override isClaimedHost(): boolean {
    return true;
  }
}
@Injectable()
class KeylessHostApiKey extends HostApiKeyService {
  override allows(request: IncomingMessage, transport: 'http' | 'socket') {
    return super.allows(request, transport, false);
  }
}

type Json = Record<string, unknown>;

describe('home UI link writes on a claimed VM of this version', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let home: TestInstance;
  let host: TestInstance;

  async function api<R = Json>(
    instance: TestInstance,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: R }> {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as R };
  }

  const importTask = (taskId: string) =>
    api<{ epic: { id: string }; created: boolean }>(
      home,
      'POST',
      '/api/epics/import-external-task',
      {
        projectId: PROJECT,
        statusId: STATUS,
        agentId: null,
        title: `Imported ${taskId}`,
        description: null,
        remote: {
          provider: 'jira',
          scopeKey: SCOPE,
          taskId,
          remoteKey: taskId,
          title: `Remote ${taskId}`,
          description: null,
          webUrl: `https://${SCOPE}/browse/${taskId}`,
          workAreaId: '42',
          workAreaName: 'Delivery',
          statusName: 'To Do',
        },
      },
    );

  const links = (instance: TestInstance, taskId: string) =>
    instance.sqlite
      .prepare(
        'SELECT id, epic_id FROM external_task_links WHERE project_id = ? AND remote_task_id = ?',
      )
      .all(PROJECT, taskId) as { id: string; epic_id: string }[];

  const version = (instance: TestInstance, epicId: string) =>
    (
      instance.sqlite.prepare('SELECT version FROM epics WHERE id = ?').get(epicId) as {
        version: number;
      }
    ).version;

  const pullHome = () =>
    home.app.get<RemoteMirrorSyncPort>(REMOTE_MIRROR_SYNC_PORT).pullNow(PROJECT);

  const linkOnVm = (epicId: string, remoteTaskId: string) =>
    host.storage.setEpicExternalTaskLink(
      epicId,
      {
        connectionId: 'connection-jira',
        connectionGeneration: 1,
        provider: 'jira',
        remoteScopeKey: SCOPE,
        remoteTaskId,
        sourceSnapshot: { remoteKey: remoteTaskId },
      },
      undefined,
      { vmHosted: true },
    );

  const epicOnVm = (title: string) =>
    host.storage.createEpic({
      projectId: PROJECT,
      statusId: STATUS,
      title,
      description: null,
      parentId: null,
      agentId: null,
      data: null,
      skillsRequired: null,
      tags: [],
    });

  /** A pending estimate operation of the task in `instance`'s ledger. */
  const pendingEstimate = (instance: TestInstance, remoteTaskId: string) =>
    instance.sqlite
      .prepare(
        `INSERT INTO external_estimate_log_states (
           project_id, provider, remote_scope_key, remote_task_id,
           pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
           pending_started_at, pending_connection_id, pending_connection_generation,
           pending_phase, pending_activity_date, created_at, updated_at)
         VALUES (?, 'jira', ?, ?, ?, 30, 30, ?, 'connection-jira', 1, 'prepared', '2026-01-01', ?, ?)`,
      )
      .run(PROJECT, SCOPE, remoteTaskId, `op-${remoteTaskId}`, T, T, T);

  const unlink = (epicId: string, linkId: string) =>
    api<{ code: string }>(home, 'DELETE', `/api/epics/${epicId}/external-sources/${linkId}`);

  const hostEpicCount = () =>
    (
      host.sqlite.prepare('SELECT COUNT(*) AS n FROM epics WHERE project_id = ?').get(PROJECT) as {
        n: number;
      }
    ).n;

  beforeAll(async () => {
    instances = await startTwoInstances({
      syncIntervalMs: 600_000,
      reconcileIntervalMs: 600_000,
      configureModule: (builder, instance, dataDir) => {
        if (instance !== 'host') return builder;
        const runtimeDir = join(dataDir, 'run');
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        return builder
          .overrideProvider(HostHelperService)
          .useClass(ClaimedHelper)
          .overrideProvider(IntegrationVmCacheService)
          .useClass(ClaimedIntegrationCache)
          .overrideProvider(HostApiKeyService)
          .useClass(KeylessHostApiKey)
          .overrideProvider(RUNTIME_DIRECTORY_HOST)
          .useValue({
            ...systemRuntimeDirectoryHost(join(dataDir, 'devchain.db')),
            env: () => ({ RUNTIME_DIRECTORY: runtimeDir }),
            fileSystemType: async () => TMPFS,
          });
      },
    });
    home = instances.home;
    host = instances.host;
    const { insert } = replicaSeeder(home.sqlite);
    insert('projects', {
      id: PROJECT,
      workspace_id: '0defa017-0000-4000-8000-000000000001',
      name: 'VM links',
      description: null,
      root_path: '/tmp/vm-links',
      is_template: 0,
      is_private: 0,
      created_at: T,
      updated_at: T,
    });
    insert('statuses', {
      id: STATUS,
      project_id: PROJECT,
      label: 'New',
      color: '#fff',
      position: 0,
      mcp_hidden: 0,
      created_at: T,
      updated_at: T,
    });
    insert('integration_connections', {
      id: 'connection-jira',
      project_id: PROJECT,
      provider: 'jira',
      credential_ciphertext: 'home-only-ciphertext',
      created_at: T,
      updated_at: T,
    });

    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: { online: boolean }[] }>(home, 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);
    const { body: started } = await api<RemoteOperation>(
      home,
      'POST',
      `/api/remotes/${remote.id}/attach`,
      { projectId: PROJECT },
    );
    await waitForValue(async () => {
      const { body } = await api<RemoteOperation>(
        home,
        'GET',
        `/api/remotes/operations/${started.id}`,
      );
      if (body.state === 'failed') throw new Error(JSON.stringify(body.steps));
      return body.state === 'done';
    }, 15_000);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  it('returns the epic an agent on the VM linked, creating no second one', async () => {
    await home.app.get(RemoteIntegrationPushService).seedConfirmed(remote.id, PROJECT);
    const agentEpic = await epicOnVm('Agent epic');
    const { link } = await linkOnVm(agentEpic.id, 'ENG-1');
    const before = hostEpicCount();
    expect(links(home, 'ENG-1')).toEqual([]);

    const imported = await importTask('ENG-1');

    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ epic: { id: agentEpic.id }, created: false });
    expect(hostEpicCount()).toBe(before);
    expect(links(home, 'ENG-1')).toEqual([{ id: link.id, epic_id: agentEpic.id }]);
  });

  it("follows the VM when home's mirror still links the task to an earlier epic", async () => {
    const earlier = await epicOnVm('Earlier epic');
    const later = await epicOnVm('Later epic');
    const first = await linkOnVm(earlier.id, 'ENG-5');
    await pullHome();
    expect(links(home, 'ENG-5')).toEqual([{ id: first.link.id, epic_id: earlier.id }]);
    // An agent moves the link on the VM; home has not pulled since.
    await host.storage.deleteExternalTaskLink(earlier.id, first.link.id, undefined, {
      vmHosted: true,
    });
    const moved = await linkOnVm(later.id, 'ENG-5');

    const imported = await importTask('ENG-5');

    expect(imported.body).toMatchObject({ epic: { id: later.id }, created: false });
    expect(links(home, 'ENG-5')).toEqual([{ id: moved.link.id, epic_id: later.id }]);
  });

  it('creates the epic and link on the VM once, however often the import is sent', async () => {
    const first = await importTask('ENG-2');
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const [vmLink] = links(host, 'ENG-2');
    expect(vmLink.epic_id).toBe(first.body.epic.id);
    expect(links(home, 'ENG-2')).toEqual([vmLink]);

    // A retry whose answer was lost reaches the VM again.
    const client = home.app.get(RemoteHostClient);
    const resent = await client.importExternalTask(remote.id, PROJECT, {
      idempotencyKey: `import:jira:${SCOPE}:ENG-2`,
      epic: { statusId: STATUS, title: 'Imported ENG-2', description: null },
      link: {
        connectionId: 'connection-jira',
        connectionGeneration: 1,
        provider: 'jira',
        remoteScopeKey: SCOPE,
        remoteTaskId: 'ENG-2',
        sourceSnapshot: {},
      },
    });
    const again = await importTask('ENG-2');

    expect(resent).toEqual({ epicId: vmLink.epic_id, linkId: vmLink.id, created: false });
    expect(again.body).toMatchObject({ epic: { id: vmLink.epic_id }, created: false });
    expect(links(host, 'ENG-2')).toEqual([vmLink]);
  });

  it('unlinks exactly the link on the VM, and a later import makes a new epic', async () => {
    const first = await importTask('ENG-3');
    const epicId = first.body.epic.id;
    const [vmLink] = links(host, 'ENG-3');
    const before = version(host, epicId);

    const unlinked = await unlink(epicId, vmLink.id);

    expect(unlinked.status).toBe(204);
    expect(links(host, 'ENG-3')).toEqual([]);
    expect(links(home, 'ENG-3')).toEqual([]);
    expect(version(host, epicId)).toBe(before + 1);
    expect(version(home, epicId)).toBe(before + 1);
    const relinked = await importTask('ENG-3');
    expect(relinked.body.created).toBe(true);
    expect(relinked.body.epic.id).not.toBe(first.body.epic.id);
  });

  it('answers 409 EXTERNAL_TASK_LINK_STALE for a link the VM no longer has', async () => {
    const first = await importTask('ENG-4');
    const before = version(host, first.body.epic.id);

    const stale = await unlink(first.body.epic.id, 'not-the-link');

    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('EXTERNAL_TASK_LINK_STALE');
    expect(links(host, 'ENG-4')).toHaveLength(1);
    expect(version(host, first.body.epic.id)).toBe(before);
  });

  it.each([
    ['home, where the ledger of a remote-owned project stays', 'ENG-6', () => home],
    ['the VM', 'ENG-7', () => host],
  ])(
    'refuses the unlink while %s holds a pending estimate of the task',
    async (_where, taskId, ledger) => {
      const first = await importTask(taskId);
      const [vmLink] = links(host, taskId);
      const before = version(host, first.body.epic.id);
      pendingEstimate(ledger(), taskId);

      const refused = await unlink(first.body.epic.id, vmLink.id);

      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('EXTERNAL_TASK_ESTIMATE_PENDING');
      expect(links(host, taskId)).toEqual([vmLink]);
      expect(version(host, first.body.epic.id)).toBe(before);
    },
  );

  it('refuses imports of the seeded VM during version skew, whatever it reports later and after a home restart, still revokes its connections, and forgets the owner with the binding', async () => {
    await home.app.get(RemoteIntegrationPushService).seedConfirmed(remote.id, PROJECT);
    type FetchJson = (url: string, ...rest: unknown[]) => Promise<Json>;
    const proto = RemoteHealthService.prototype as unknown as { fetchJson: FetchJson };
    const fetchJson = proto.fetchJson;
    let integrations: 'kept' | 'absent' | 'unreadable' = 'kept';
    // Home is updated first: the VM now reports an older version, and later loses or
    // garbles its integrations report.
    const skew = jest.spyOn(proto, 'fetchJson').mockImplementation(async function (
      this: unknown,
      url,
      ...rest
    ) {
      const body = await fetchJson.call(this, url, ...rest);
      if (!url.endsWith('/api/runtime')) return body;
      const { integrations: report, ...runtime } = body;
      return {
        ...runtime,
        version: '0.0.0-older',
        ...(integrations === 'kept' && { integrations: report }),
        ...(integrations === 'unreadable' && { integrations: { appliedRevision: 7 } }),
      };
    });
    const poll = async () =>
      expect(await home.app.get(RemoteHealthService).refresh(remote.id)).toMatchObject({
        online: true,
        versionMatches: false,
      });
    const vmConnections = () =>
      host.sqlite
        .prepare('SELECT id FROM integration_connections WHERE project_id = ?')
        .all(PROJECT);
    const expectRefused = async (taskId: string) => {
      const epicsBefore = hostEpicCount();
      const refused = await importTask(taskId);
      await pullHome();
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ details: { code: 'REMOTE_UPDATE_REQUIRED' } });
      expect(links(home, taskId)).toEqual([]);
      expect(links(host, taskId)).toEqual([]);
      expect(hostEpicCount()).toBe(epicsBefore);
    };
    try {
      await poll();
      await expectRefused('ENG-9');
      integrations = 'absent';
      await poll();
      await expectRefused('ENG-10');
      integrations = 'unreadable';
      await poll();
      await expectRefused('ENG-11');
      // Home restarts while the VM reports nothing: the binding still names the owner.
      integrations = 'absent';
      home = await instances.restartHome();
      await poll();
      await expectRefused('ENG-12');

      // A disconnect at home still reaches a VM cache that reports its status.
      integrations = 'kept';
      await poll();
      expect(vmConnections()).toEqual([{ id: 'connection-jira' }]);
      await home.storage.disconnectIntegrationConnection({ projectId: PROJECT, provider: 'jira' });
      await poll();
      await waitForValue(async () => vmConnections().length === 0, 10_000);

      // The owner record goes with the binding: a new binding to a VM that reports no
      // integrations (a legacy VM) leaves the links to home.
      const push = home.app.get(RemoteIntegrationPushService);
      const old = (await home.storage.getRemoteProjectBinding(PROJECT))!;
      await home.storage.deleteRemoteProjectBinding(PROJECT);
      await home.storage.createRemoteProjectBinding({ projectId: PROJECT, remoteId: remote.id });
      await home.storage.updateRemoteProjectBinding(PROJECT, { state: 'remote' });
      integrations = 'absent';
      await poll();
      // A push that read the old binding before the detach marks nothing on the new one.
      expect(await home.storage.markVmLinkOwners([old])).toEqual([]);
      expect(await home.storage.getVmLinkOwnerSince(PROJECT)).toBeNull();
      expect(await push.linkWriter(remote.id, PROJECT)).toBe('home');
    } finally {
      skew.mockRestore();
      await home.app.get(RemoteHealthService).refresh(remote.id);
    }
  }, 60_000);
});
