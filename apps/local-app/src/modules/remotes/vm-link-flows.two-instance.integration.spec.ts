/**
 * VM agents link epics to Jira tasks on a claimed VM while home keeps managed subtask
 * sync: no sequence of VM link writes, deletions, recovery or detach makes either
 * instance delete a remote subtask, and only home ever calls the vendor for subtasks.
 * Test layer: two-instance integration. Receipts, the seed, home's mirror apply and the
 * durable managed-sync subscriber meet only in two booted apps; the Jira site is one
 * recording fake that both apps call.
 */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { IntegrationVmCacheService } from '../external-integrations/vm-cache/integration-vm-cache.service';
import {
  JIRA_SITE,
  recordingVendor,
  type RecordingVendor,
  type VendorCallFilter,
} from '../external-integrations/testing/recording-vendor.fixture';
import { MANAGED_SUBTASK_DELIVERY_KEY } from '../external-integrations/subscribers/external-subtask-sync.subscriber';
import { McpService } from '../mcp/services/mcp.service';
import { EpicsService } from '../epics/services/epics.service';
import {
  RUNTIME_DIRECTORY_HOST,
  systemRuntimeDirectoryHost,
} from '../runtime-directory/runtime-directory';
import type { Remote, RemoteOperation } from '../storage/models/domain.models';
import { HostApiKeyService } from './host/host-api-key.service';
import { HostHelperService } from './host/host-helper.service';
import {
  REMOTE_MIRROR_SYNC_PORT,
  type RemoteMirrorSyncPort,
} from './ports/remote-mirror-sync.port';
import { RemoteLiveSyncService } from './sync/remote-live-sync.service';
import { RemoteHostClient } from './operations/remote-host.client';
import { ManagedProjectionLock } from '../external-integrations/subscribers/managed-projection-lock';
import { ensureProvider, replicaSeeder } from './replica/__fixtures__/replica-seed';

const TMPFS = 0x01021994;
const EMAIL = 'agent@example.com';
const TOKEN = 'canary-vm-link-flows-4c1d';
const RECONNECTED = 'canary-vm-link-reconnected-8e2a';

// The host plays a claimed VM. Both apps share `process.env`, so a real claim record
// would also make home a VM; these seams claim only the host.
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

interface McpResult<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: { code: string; message?: string };
}

interface VmProject {
  /** A UUID status, as the import route requires. */
  importStatusId: string;
  id: string;
  session: string;
}

describe('VM link flows and managed subtasks', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let vendor: RecordingVendor;
  let provider: string;

  const home = (): TestInstance => instances.home;
  const host = (): TestInstance => instances.host;

  async function runOperation(kind: 'attach' | 'detach', projectId: string): Promise<void> {
    const started = await fetch(`${home().url}/api/remotes/${remote.id}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as RemoteOperation;
    await waitForValue(async () => {
      const response = await fetch(`${home().url}/api/remotes/operations/${id}`);
      const body = (await response.json()) as RemoteOperation;
      if (body.state === 'failed') throw new Error(`${kind} failed: ${JSON.stringify(body.steps)}`);
      return body.state === 'done';
    }, 15_000);
  }

  /** A home project with one agent and a Jira connection that syncs subtasks, attached to the VM. */
  async function attachedProject(): Promise<VmProject> {
    const id = randomUUID();
    const { seedProject, seedProfile, seedAgent } = replicaSeeder(home().sqlite);
    seedProject(id);
    seedProfile(`${id}-profile`, id, provider);
    const agentId = randomUUID();
    seedAgent(agentId, id, `${id}-profile`);
    const importStatusId = randomUUID();
    home()
      .sqlite.prepare(
        `INSERT INTO statuses (id, project_id, label, color, position, mcp_hidden, created_at, updated_at)
         VALUES (?, ?, 'Imported', '#fff', 1, 0, 'T', 'T')`,
      )
      .run(importStatusId, id);
    await home().storage.replaceIntegrationConnection(
      {
        projectId: id,
        provider: 'jira',
        credentials: { provider: 'jira', siteUrl: JIRA_SITE, email: EMAIL, token: TOKEN },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await runOperation('attach', id);
    const session = randomUUID();
    host()
      .sqlite.prepare(
        `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
         VALUES (?, ?, 'running', 'T', 'T', 'T')`,
      )
      .run(session, agentId);
    await waitForValue(
      async () => (await host().app.get(IntegrationVmCacheService).status()).cacheReady,
      10_000,
    );
    return { id, session, importStatusId };
  }

  /** A VM agent's MCP call; `success: false` fails the test unless `allowFailure`. */
  async function vm<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpResult<T>> {
    const response = (await host().app.get(McpService).handleToolCall(tool, args)) as McpResult<T>;
    for (const token of [TOKEN, RECONNECTED]) expect(JSON.stringify(response)).not.toContain(token);
    return response;
  }

  async function vmOk<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await vm<T>(tool, args);
    if (!response.success) throw new Error(`${tool} failed: ${JSON.stringify(response.error)}`);
    return response.data as T;
  }

  /** The vendor calls of one VM read of `key` (a get, or the read before a link). */
  const taskRead = (key: string, token = TOKEN) =>
    [
      `GET /rest/api/3/issue/${key}`,
      `GET /rest/api/3/issue/${key}/transitions`,
      'GET /rest/api/3/configuration',
    ].map((op) => ({ instance: 'host', op, token: `${EMAIL}:${token}` }));

  function task(key: string): { ref: string; provider: 'jira' } {
    vendor.issues.add(key);
    return { ref: key, provider: 'jira' };
  }

  async function createOnVm(
    project: VmProject,
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number }> {
    return vmOk<{ id: string; version: number }>('devchain_create_epic', {
      sessionId: project.session,
      title,
      ...extra,
    });
  }

  async function versionOnVm(epicId: string): Promise<number> {
    return (await host().storage.getEpic(epicId)).version;
  }

  const pull = (projectId: string) =>
    home().app.get<RemoteMirrorSyncPort>(REMOTE_MIRROR_SYNC_PORT).pullNow(projectId);

  /** Home's managed rows of the project, in any phase. */
  const projections = (projectId: string) =>
    home()
      .sqlite.prepare(
        `SELECT epic_id_snapshot AS epicId, remote_task_id AS remoteTaskId,
                operation_phase AS phase
         FROM external_managed_subtask_links
         WHERE connection_id_snapshot IN
           (SELECT id FROM integration_connections WHERE project_id = ?)
         ORDER BY epic_id_snapshot`,
      )
      .all(projectId) as { epicId: string; remoteTaskId: string | null; phase: string }[];

  /** Waits until home's managed sync has handled every event committed so far. */
  const settled = () =>
    waitForValue(
      async () =>
        (
          home()
            .sqlite.prepare(
              `SELECT COUNT(*) AS n FROM event_handlers
               WHERE delivery_key = ? AND status <> 'delivered'`,
            )
            .get(MANAGED_SUBTASK_DELIVERY_KEY) as { n: number }
        ).n === 0,
      15_000,
    );

  /** Pulls the project home and waits for managed sync to finish with it. */
  async function pullAndSettle(projectId: string, { full = false } = {}): Promise<void> {
    if (full) home().app.get(RemoteLiveSyncService).start(projectId, remote.id, { full: true });
    await pull(projectId);
    await settled();
  }

  const homeEpicIds = (projectId: string) =>
    (
      home().sqlite.prepare('SELECT id FROM epics WHERE project_id = ?').all(projectId) as {
        id: string;
      }[]
    ).map((row) => row.id);

  const syncError = (projectId: string) =>
    (
      home()
        .sqlite.prepare(
          'SELECT sync_error AS error FROM remote_project_bindings WHERE project_id = ?',
        )
        .get(projectId) as { error: string | null }
    ).error;

  const homeConnectionId = (projectId: string) =>
    (
      home()
        .sqlite.prepare('SELECT id FROM integration_connections WHERE project_id = ?')
        .get(projectId) as { id: string }
    ).id;

  const vmConnectionIds = (projectId: string) =>
    (
      host()
        .sqlite.prepare('SELECT id FROM integration_connections WHERE project_id = ?')
        .all(projectId) as { id: string }[]
    ).map((row) => row.id);

  async function waitOnline(): Promise<void> {
    await waitForValue(async () => {
      const response = await fetch(`${home().url}/api/remotes`);
      const { items } = (await response.json()) as { items: { online: boolean }[] };
      return items[0]?.online === true;
    }, 10_000);
  }

  const homeLinks = (projectId: string) =>
    home()
      .sqlite.prepare(
        `SELECT epic_id AS epicId, remote_task_id AS remoteTaskId, connection_id AS connectionId
         FROM external_task_links
         WHERE project_id = ? AND json_extract(source_snapshot, '$.managedProjectionId') IS NULL
         ORDER BY remote_task_id`,
      )
      .all(projectId) as { epicId: string; remoteTaskId: string; connectionId: string | null }[];

  /** A Board import from the home UI; for an attached project the VM creates the epic. */
  async function importAtHome(
    project: VmProject,
    key: string,
  ): Promise<{ epic: { id: string }; created: boolean }> {
    vendor.issues.add(key);
    const response = await fetch(`${home().url}/api/epics/import-external-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        statusId: project.importStatusId,
        agentId: null,
        title: `Imported ${key}`,
        description: null,
        remote: {
          provider: 'jira',
          scopeKey: new URL(JIRA_SITE).host,
          taskId: key,
          remoteKey: key,
          title: `Remote ${key}`,
          description: null,
          webUrl: `${JIRA_SITE}/browse/${key}`,
          workAreaId: '42',
          workAreaName: 'Delivery',
          statusName: 'To Do',
        },
      }),
    });
    const body = (await response.json()) as { epic: { id: string }; created: boolean };
    if (response.status >= 300) throw new Error(`import failed: ${JSON.stringify(body)}`);
    return body;
  }

  /** Links `parent` on the VM, adds `children` sub-epics, and waits until home projects them. */
  async function managedTree(project: VmProject, key: string, children: string[]) {
    const parent = await createOnVm(project, `Parent ${key}`, { externalTask: task(key) });
    const childIds: string[] = [];
    for (const title of children) {
      childIds.push((await createOnVm(project, title, { parentId: parent.id })).id);
    }
    const creates = calls({ op: 'subtask:create' }).length;
    await pullAndSettle(project.id);
    expect(projections(project.id)).toEqual(
      [...childIds].sort().map((epicId) => ({
        epicId,
        remoteTaskId: expect.any(String),
        phase: 'confirmed',
      })),
    );
    expect(calls({ instance: 'home', op: 'subtask:create' }).length).toBe(
      creates + children.length,
    );
    return { parent, childIds };
  }

  beforeAll(async () => {
    vendor = recordingVendor();
    instances = await startTwoInstances({
      // No background pulls: each test pulls itself, incrementally unless it asks for a
      // full reconcile, the only pull that carries VM deletions.
      syncIntervalMs: 600_000,
      reconcileIntervalMs: 600_000,
      configureModule: (builder, instance, dataDir) => {
        const routed = vendor.configure(builder, instance);
        if (instance !== 'host') return routed;
        const runtimeDir = join(dataDir, 'run');
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        return routed
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
    provider = ensureProvider(home().sqlite, 'prov-claude', 'claude', null);
    for (const instance of [home(), host()]) {
      // With the built-in skill source on, Connect makes the host download it from GitHub.
      instance.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES ('skill-switches', 'skills.sources', ?, 'T', 'T')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(JSON.stringify({ microsoft: false }));
    }
    ensureProvider(host().sqlite, 'host-claude', 'claude', null);
    remote = await instances.registerRemote('vm-1');
    await waitOnline();
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  let baseline = 0;
  /** This test's vendor calls matching `filter`. */
  const calls = (filter?: VendorCallFilter) => vendor.callsAfter(baseline, filter);

  beforeEach(() => {
    baseline = vendor.calls.length;
  });

  afterEach(() => {
    // Only home ever talks to the vendor about managed subtasks; the VM only reads tasks.
    expect(calls({ instance: 'host', opPrefix: 'subtask:' })).toEqual([]);
    expect(calls({ instance: 'host' }).filter((call) => !call.op.startsWith('GET '))).toEqual([]);
  });

  it('1: VM unlinks the parent, deletes its tree and links its task to another epic; home pulls and deletes no subtask', async () => {
    const project = await attachedProject();
    const { parent, childIds } = await managedTree(project, 'ENG-11', ['Child 1', 'Child 2']);
    const before = new Map(vendor.subtasks);

    await vmOk('devchain_update_epic', {
      sessionId: project.session,
      id: parent.id,
      version: await versionOnVm(parent.id),
      externalTask: { clear: true },
    });
    await vmOk('devchain_delete_epic', { sessionId: project.session, id: parent.id });
    const replacement = await createOnVm(project, 'Replacement', { externalTask: task('ENG-11') });
    // The ordinary pull replays the unlink's receipt; the full pull brings the deletions.
    await pullAndSettle(project.id);
    expect(projections(project.id)).toEqual([]);
    await pullAndSettle(project.id, { full: true });

    expect(homeEpicIds(project.id).filter((id) => [parent.id, ...childIds].includes(id))).toEqual(
      [],
    );
    expect(projections(project.id)).toEqual([]);
    expect(calls({ op: 'subtask:delete' }).length).toBe(0);
    expect(vendor.subtasks).toEqual(before);
    expect(homeLinks(project.id)).toEqual([
      expect.objectContaining({ epicId: replacement.id, remoteTaskId: 'ENG-11' }),
    ]);
  }, 60_000);

  // Case 2 linked a managed child through `devchain_update_epic`. The epic tools now refuse a
  // link on a sub-epic, so the case is gone. The other cases keep their numbers for the docs.

  it("3: as 1, when home's first contact after the VM writes is a recovery re-snapshot", async () => {
    const project = await attachedProject();
    const { parent, childIds } = await managedTree(project, 'ENG-31', ['Child 1', 'Child 2']);
    const before = new Map(vendor.subtasks);

    await vmOk('devchain_update_epic', {
      sessionId: project.session,
      id: parent.id,
      version: await versionOnVm(parent.id),
      externalTask: { clear: true },
    });
    await vmOk('devchain_delete_epic', { sessionId: project.session, id: parent.id });
    // A persisted sync failure makes the next pull a full attach-scope re-snapshot.
    home()
      .sqlite.prepare('UPDATE remote_project_bindings SET sync_error = ? WHERE project_id = ?')
      .run('forced by the test', project.id);
    await pullAndSettle(project.id);

    expect(syncError(project.id)).toBeNull();
    expect(homeEpicIds(project.id).filter((id) => [parent.id, ...childIds].includes(id))).toEqual(
      [],
    );
    expect(projections(project.id)).toEqual([]);
    expect(calls({ op: 'subtask:delete' }).length).toBe(0);
    expect(vendor.subtasks).toEqual(before);
  }, 60_000);

  it('4: VM moves a task from one epic to another between pulls; the apply succeeds', async () => {
    const project = await attachedProject();
    const first = await createOnVm(project, 'First', { externalTask: task('ENG-41') });
    const second = await createOnVm(project, 'Second');
    await pullAndSettle(project.id);
    expect(homeLinks(project.id)).toEqual([
      expect.objectContaining({ epicId: first.id, remoteTaskId: 'ENG-41' }),
    ]);
    const from = vendor.calls.length;

    await vmOk('devchain_update_epic', {
      sessionId: project.session,
      id: first.id,
      version: await versionOnVm(first.id),
      externalTask: { clear: true },
    });
    await vmOk('devchain_update_epic', {
      sessionId: project.session,
      id: second.id,
      version: await versionOnVm(second.id),
      externalTask: task('ENG-41'),
    });
    await pullAndSettle(project.id);

    expect(syncError(project.id)).toBeNull();
    expect(homeLinks(project.id)).toEqual([
      expect.objectContaining({ epicId: second.id, remoteTaskId: 'ENG-41' }),
    ]);
    // The unlink calls nothing; the link reads the task once; home's apply calls nothing.
    expect(vendor.callsAfter(from)).toEqual(taskRead('ENG-41'));
  }, 60_000);

  it("5: detach brings the VM's links home on home's connection, managed sync goes on at home, and an unlink there retires the import", async () => {
    const project = await attachedProject();
    const { parent } = await managedTree(project, 'ENG-51', ['Child 1']);
    const connectionId = homeConnectionId(project.id);
    const imported = await importAtHome(project, 'ENG-53');
    expect(imported.created).toBe(true);
    // Linked on the VM after home's last pull: only the detach export brings it home.
    const unpulled = await createOnVm(project, 'Linked on the VM', {
      externalTask: task('ENG-52'),
    });
    expect(homeLinks(project.id).map((link) => link.remoteTaskId)).toEqual(['ENG-51', 'ENG-53']);

    await runOperation('detach', project.id);
    await settled();

    expect(homeLinks(project.id)).toEqual([
      { epicId: parent.id, remoteTaskId: 'ENG-51', connectionId },
      { epicId: unpulled.id, remoteTaskId: 'ENG-52', connectionId },
      { epicId: imported.epic.id, remoteTaskId: 'ENG-53', connectionId },
    ]);
    expect(projections(project.id)).toEqual([
      expect.objectContaining({ phase: 'confirmed', remoteTaskId: expect.any(String) }),
    ]);
    const creates = calls({ op: 'subtask:create' }).length;
    const later = await home()
      .app.get(EpicsService)
      .createEpic({
        projectId: project.id,
        statusId: `${project.id}-status`,
        title: 'Child 2',
        description: null,
        parentId: parent.id,
        agentId: null,
        data: null,
        skillsRequired: null,
        tags: [],
      });
    await settled();

    expect(calls({ instance: 'home', op: 'subtask:create' }).length).toBe(creates + 1);
    expect(projections(project.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ epicId: later.id, phase: 'confirmed' })]),
    );
    expect(projections(project.id)).toHaveLength(2);
    expect(calls({ op: 'subtask:delete' }).length).toBe(0);

    // A deliberate unlink at home, then the project goes back to the VM: a new import of the
    // task makes a new epic and leaves the unlinked one alone.
    const [importLink] = await home().storage.listExternalTaskLinksForEpic(imported.epic.id);
    const unlinked = await fetch(
      `${home().url}/api/epics/${imported.epic.id}/external-sources/${importLink!.id}`,
      { method: 'DELETE' },
    );
    expect(unlinked.status).toBe(204);
    await runOperation('attach', project.id);
    await waitForValue(
      async () => (await host().app.get(IntegrationVmCacheService).status()).cacheReady,
      10_000,
    );

    const again = await importAtHome(project, 'ENG-53');

    expect(again.created).toBe(true);
    expect(again.epic.id).not.toBe(imported.epic.id);
    expect(
      (await host().storage.listExternalTaskLinksForEpic(imported.epic.id)).map((l) => l.id),
    ).toEqual([]);
  }, 90_000);

  it('6: a provider disconnect and reconnect at home reaches the VM, its links keep working, and a rebound parent syncs new children', async () => {
    const project = await attachedProject();
    const linked = await createOnVm(project, 'Linked', { externalTask: task('ENG-61') });
    await pullAndSettle(project.id);
    const old = homeConnectionId(project.id);

    expect(
      await home().storage.disconnectIntegrationConnection({
        projectId: project.id,
        provider: 'jira',
      }),
    ).toBe(true);
    const reconnected = await home().storage.replaceIntegrationConnection(
      {
        projectId: project.id,
        provider: 'jira',
        credentials: { provider: 'jira', siteUrl: JIRA_SITE, email: EMAIL, token: RECONNECTED },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await waitForValue(
      async () =>
        vmConnectionIds(project.id).join() === reconnected.id &&
        (await host().app.get(IntegrationVmCacheService).status()).cacheReady,
      10_000,
    );
    const from = vendor.calls.length;

    const read = await vmOk<{ remoteKey: string }>('devchain_external_tasks_get', {
      sessionId: project.session,
      ...task('ENG-61'),
    });
    // Setting the same task again gives the existing link the new connection.
    await vmOk('devchain_update_epic', {
      sessionId: project.session,
      id: linked.id,
      version: await versionOnVm(linked.id),
      externalTask: task('ENG-61'),
    });
    const another = await createOnVm(project, 'Another', { externalTask: task('ENG-62') });
    await pullAndSettle(project.id);

    expect(read.remoteKey).toBe('ENG-61');
    // One read for the get, one per link, all with the new token; home calls nothing.
    expect(vendor.callsAfter(from)).toEqual([
      ...taskRead('ENG-61', RECONNECTED),
      ...taskRead('ENG-61', RECONNECTED),
      ...taskRead('ENG-62', RECONNECTED),
    ]);
    expect(reconnected.id).not.toBe(old);
    // The rebind receipt gives home's link the reconnected connection again.
    expect(homeLinks(project.id)).toEqual([
      { epicId: linked.id, remoteTaskId: 'ENG-61', connectionId: reconnected.id },
      { epicId: another.id, remoteTaskId: 'ENG-62', connectionId: reconnected.id },
    ]);

    const child = await createOnVm(project, 'Child after rebind', { parentId: linked.id });
    const beforeChild = vendor.calls.length;
    await pullAndSettle(project.id);
    expect(projections(project.id)).toEqual([
      { epicId: child.id, remoteTaskId: expect.any(String), phase: 'confirmed' },
    ]);
    expect(vendor.callsAfter(beforeChild, { opPrefix: 'subtask:' })).toEqual([
      { instance: 'home', op: 'subtask:create', token: '' },
    ]);
  }, 60_000);

  it('9: a VM agent links a phase epic and adds sub-epics while home is stopped; home projects them once', async () => {
    const project = await attachedProject();
    await home().close();

    const read = await vmOk<{ remoteKey: string }>('devchain_external_tasks_get', {
      sessionId: project.session,
      ...task('ENG-91'),
    });
    const phase = await createOnVm(project, 'Phase 1', { externalTask: task('ENG-91') });
    const subEpics = [
      await createOnVm(project, 'Sub 1', { parentId: phase.id }),
      await createOnVm(project, 'Sub 2', { parentId: phase.id }),
    ];
    const creates = calls({ op: 'subtask:create' }).length;
    await instances.restartHome();
    await waitOnline();
    await pullAndSettle(project.id);
    // A full reconcile brings nothing new to project.
    await pullAndSettle(project.id, { full: true });

    expect(read.remoteKey).toBe('ENG-91');
    const sources = (await (
      await fetch(`${home().url}/api/epics/${phase.id}/external-sources`)
    ).json()) as { items: { remoteKey: string }[] };
    expect(sources.items.map((item) => item.remoteKey)).toEqual(['ENG-91']);
    expect(calls({ instance: 'home', op: 'subtask:create' }).length).toBe(creates + 2);
    expect(calls({ op: 'subtask:create' }).length).toBe(creates + 2);
    expect(projections(project.id).map((row) => [row.epicId, row.phase])).toEqual(
      subEpics
        .map((epic) => epic.id)
        .sort()
        .map((id) => [id, 'confirmed']),
    );
  }, 60_000);

  it.each(['before', 'after'])(
    '11: VM edits and deletions of managed sub-epics reach the vendor from home only, also when another epic takes the task %s the full pull',
    async (reuse) => {
      const key = `ENG-111-${reuse}`;
      const project = await attachedProject();
      const { parent, childIds } = await managedTree(project, key, ['Renamed', 'Kept']);
      const remotes = projections(project.id).map((row) => row.remoteTaskId!);
      const [renamed] = childIds;
      const renamedRemote = projections(project.id).find(
        (row) => row.epicId === renamed,
      )!.remoteTaskId!;

      await vmOk('devchain_update_epic', {
        sessionId: project.session,
        id: renamed,
        version: await versionOnVm(renamed),
        title: 'Renamed on the VM',
      });
      await pullAndSettle(project.id);
      expect(vendor.subtasks.get(renamedRemote)?.title).toBe('Renamed on the VM');

      // Deleted without an unlink: an ordinary pull cannot see the deletion and must keep
      // the link and projections the full pull needs to delete the subtasks.
      await vmOk('devchain_delete_epic', { sessionId: project.session, id: parent.id });
      await pullAndSettle(project.id);
      expect(homeLinks(project.id).map((link) => link.epicId)).toEqual([parent.id]);
      expect(projections(project.id)).toHaveLength(2);
      expect(remotes.every((id) => vendor.subtasks.has(id))).toBe(true);

      // Another VM epic, with no children, takes the deleted parent's task.
      const takeTask = async () => {
        const replacement = await createOnVm(project, 'Replacement', {
          externalTask: task(key),
        });
        await pullAndSettle(project.id);
        expect(syncError(project.id)).toBeNull();
        return replacement;
      };
      let replacement: { id: string } | undefined;
      if (reuse === 'before') {
        replacement = await takeTask();
        expect(projections(project.id)).toHaveLength(2);
        expect(remotes.every((id) => vendor.subtasks.has(id))).toBe(true);
      }
      await pullAndSettle(project.id, { full: true });
      replacement ??= await takeTask();

      expect(homeEpicIds(project.id).filter((id) => [parent.id, ...childIds].includes(id))).toEqual(
        [],
      );
      expect(homeLinks(project.id)).toEqual([
        expect.objectContaining({ epicId: replacement.id, remoteTaskId: key }),
      ]);
      expect(projections(project.id)).toEqual([]);
      expect(remotes.some((id) => vendor.subtasks.has(id))).toBe(false);
      expect(calls({ instance: 'home', op: 'subtask:update' })).toHaveLength(1);
      expect(calls({ instance: 'home', op: 'subtask:delete' })).toHaveLength(2);
    },
    60_000,
  );

  it.each([
    { pull: 'applies', answer: 204 },
    { pull: 'fails', answer: 409 },
  ])(
    '12: a home unlink of the parent, whose post-write pull $pull, never answers success while a managed delete is in flight; no DELETE for what it releases',
    async ({ pull: post, answer }) => {
      const project = await attachedProject();
      const { parent, childIds } = await managedTree(project, `ENG-12-${post}`, [
        'Deleted',
        'Released',
      ]);
      const [deleted, released] = childIds;
      const projectionOf = (epicId: string) =>
        home()
          .sqlite.prepare(
            'SELECT id, remote_task_id AS remoteTaskId FROM external_managed_subtask_links WHERE epic_id_snapshot = ?',
          )
          .get(epicId) as { id: string; remoteTaskId: string };
      const deletedProjection = projectionOf(deleted);
      const releasedRemote = projectionOf(released).remoteTaskId;
      const { id: linkId } = home()
        .sqlite.prepare(
          `SELECT id FROM external_task_links
           WHERE epic_id = ? AND json_extract(source_snapshot, '$.managedProjectionId') IS NULL`,
        )
        .get(parent.id) as { id: string };

      // The child's deletion reaches home on a full pull, and managed sync admits its delete.
      await vmOk('devchain_delete_epic', { sessionId: project.session, id: deleted });
      const vendorDelete = vendor.hold('delete');
      const lock = home().app.get(ManagedProjectionLock);
      const runAll = lock.runAll.bind(lock);
      let atLock!: () => void;
      const reachedLock = new Promise<void>((resolve) => (atLock = resolve));
      const lockSpy = jest.spyOn(lock, 'runAll').mockImplementation((ids, operation) => {
        if (ids.includes(deletedProjection.id)) atLock();
        return runAll(ids, operation);
      });
      const changes = jest.spyOn(home().app.get(RemoteHostClient), 'changes');
      try {
        home().app.get(RemoteLiveSyncService).start(project.id, remote.id, { full: true });
        await pull(project.id);
        await vendorDelete.reached;
        if (post === 'fails') changes.mockRejectedValueOnce(new Error('changes feed failed'));

        let answered = false;
        const unlink = fetch(`${home().url}/api/epics/${parent.id}/external-sources/${linkId}`, {
          method: 'DELETE',
        }).finally(() => (answered = true));
        if (post === 'applies') {
          await Promise.race([
            reachedLock,
            unlink.then(() => {
              throw new Error('the unlink answered before its pull reached the projection lock');
            }),
          ]);
          expect(answered).toBe(false);
          expect(homeLinks(project.id).map((link) => link.epicId)).toEqual([parent.id]);
          vendorDelete.release();
        }
        const response = await unlink;
        expect(response.status).toBe(answer);
        if (post === 'fails') {
          expect(await response.json()).toMatchObject({
            details: { code: 'REMOTE_UNLINK_PENDING', retryable: false },
          });
          expect(calls({ op: 'subtask:delete' })).toEqual([]);
          expect(homeLinks(project.id).map((link) => link.epicId)).toEqual([parent.id]);
          vendorDelete.release();
          await pull(project.id);
        }
      } finally {
        vendorDelete.release();
        lockSpy.mockRestore();
        changes.mockRestore();
      }
      await settled();

      expect(
        host().sqlite.prepare('SELECT 1 FROM external_task_links WHERE epic_id = ?').get(parent.id),
      ).toBeUndefined();
      expect(homeLinks(project.id)).toEqual([]);
      expect(projections(project.id)).toEqual([]);
      expect(calls({ op: 'subtask:delete' })).toEqual([
        { instance: 'home', op: 'subtask:delete', token: '' },
      ]);
      expect(vendor.subtasks.has(deletedProjection.remoteTaskId)).toBe(false);
      expect(vendor.subtasks.get(releasedRemote)?.title).toBe('Released');
    },
    60_000,
  );
});
