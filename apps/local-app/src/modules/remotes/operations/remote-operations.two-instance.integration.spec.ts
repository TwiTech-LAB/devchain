/**
 * Connect and disconnect operations between two real DevChain apps.
 * Test layer: two-instance integration. The contract spans home's runner and
 * binding writes, the host API over HTTP, and a home restart on the same data
 * directory, which only booted apps exercise.
 */
import { BUILT_IN_SKILL_SOURCE_NAMES } from '../../../common/constants/built-in-skill-sources';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { RemoteBindingChangedEventPayload } from '../../events/catalog/remote.binding.changed';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type {
  Remote,
  RemoteOperation,
  UpdateRemoteOperation,
} from '../../storage/models/domain.models';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { TerminalActivityService } from '../../terminal/services/terminal-activity.service';
import {
  T,
  ensureProvider,
  replicaSeeder,
  seedReplicaSource,
} from '../replica/__fixtures__/replica-seed';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { FileSyncService } from '../../file-sync/file-sync.service';
import type { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { AttachOperation } from './attach.operation';
import { FileSyncHandoff } from './file-sync-handoff';
import { RemoteHostClient } from './remote-host.client';

const WORKSPACE = 'workspace-team';

type RemoteList = { items: { online: boolean }[] };

describe('remote operations between two instances', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let bindingEvents: RemoteBindingChangedEventPayload[];

  const home = (): TestInstance => instances.home;

  function listenForBindingEvents(instance: TestInstance): void {
    instance.app
      .get(EventEmitter2)
      .on('remote.binding.changed', (payload: RemoteBindingChangedEventPayload) =>
        bindingEvents.push(payload),
      );
  }

  async function api<T = RemoteOperation>(
    instance: TestInstance,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function startOperation(
    kind: 'attach' | 'detach',
    body: Record<string, unknown>,
  ): Promise<RemoteOperation> {
    const response = await api(home(), 'POST', `/api/remotes/${remote.id}/${kind}`, body);
    expect(response.status).toBe(202);
    return response.body;
  }

  async function waitForState(
    id: string,
    state: RemoteOperation['state'],
  ): Promise<RemoteOperation> {
    return waitForValue(async () => {
      const { body: operation } = await api(home(), 'GET', `/api/remotes/operations/${id}`);
      if (operation.state === 'failed' && state !== 'failed') {
        throw new Error(`Operation failed: ${JSON.stringify(operation.steps)}`);
      }
      return operation.state === state ? operation : null;
    }, 15_000);
  }

  const waitUntilRemoteOnline = () =>
    waitForValue(async () => {
      const { body } = await api<RemoteList>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === true;
    }, 10_000);

  const stepStates = (operation: RemoteOperation) =>
    Object.fromEntries(operation.steps.map((step) => [step.id, step.state]));

  const bindingRow = (projectId: string) =>
    home()
      .sqlite.prepare('SELECT state, host_cursor FROM remote_project_bindings WHERE project_id = ?')
      .get(projectId) as { state: string; host_cursor: string | null } | undefined;

  /** The fixture's in-memory file sync of an instance. */
  const fileSyncOf = (instance: TestInstance) =>
    instance.app.get(FileSyncService) as unknown as FakeFileSyncService;

  /** `{ type, paused }` of each of the project's folders on an instance. */
  const folderStates = (instance: TestInstance, projectId: string) =>
    Object.fromEntries(
      [`code:${projectId}`].map((id) => {
        const folder = fileSyncOf(instance).folders.get(id);
        return [id, folder ? { type: folder.type, paused: folder.paused } : null];
      }),
    );

  const hostHasProject = (projectId: string) =>
    Boolean(instances.host.sqlite.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId));

  beforeAll(async () => {
    instances = await startTwoInstances();
    const sqlite = instances.home.sqlite;
    seedReplicaSource(sqlite);
    sqlite
      .prepare(
        `INSERT INTO community_skill_sources
      (id, name, repo_owner, repo_name, branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('home-community', 'community', 'home-owner', 'skills', 'main', T, T);
    sqlite
      .prepare(
        `INSERT INTO local_skill_sources
      (id, name, folder_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
      )
      .run('home-team', 'team', '/home/team-skills', T, T);
    instances.host.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(
        'host-skill-switches',
        'skills.sources',
        JSON.stringify({ microsoft: false, 'host-only': false }),
        T,
        T,
      );

    const { seedProject, seedEpic, insert } = replicaSeeder(sqlite);
    // Home's provider catalog and threshold must reach the host at connect.
    const homeClaude = sqlite.prepare("SELECT id FROM providers WHERE name = 'claude'").get() as {
      id: string;
    };
    insert('provider_models', {
      id: 'model-sonnet',
      provider_id: homeClaude.id,
      name: 'sonnet-4-20250514',
      position: 0,
      created_at: T,
      updated_at: T,
    });
    insert('provider_efforts', {
      id: 'effort-high',
      provider_id: homeClaude.id,
      name: 'high',
      position: 0,
      created_at: T,
      updated_at: T,
    });
    sqlite
      .prepare('UPDATE providers SET auto_compact_threshold = ? WHERE id = ?')
      .run(42, homeClaude.id);
    seedProject('D');
    seedProject('E');
    seedProject('F');
    seedProject('G');
    seedProject('H');
    seedProject('I');
    seedProject('J');
    seedProject('K');
    seedEpic('epic-i', 'I');
    sqlite.exec(`
      INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
      VALUES ('${WORKSPACE}', 'Team', 0, 1, '${T}', '${T}');
      UPDATE projects SET workspace_id = '${WORKSPACE}' WHERE id IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K');
    `);
    // A session still running at home when A connects.
    sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, epic_id, status, started_at, created_at, updated_at)
         VALUES ('session-live', 'agent-1', 'epic-1', 'running', ?, ?, ?)`,
      )
      .run(T, T, T);
    ensureProvider(instances.host.sqlite, 'host-claude', 'claude', null);
    ensureProvider(instances.host.sqlite, 'host-codex', 'codex', null);

    remote = await instances.registerRemote('vm-1');
    await waitUntilRemoteOnline();
  }, 60_000);

  beforeEach(() => {
    bindingEvents = [];
    listenForBindingEvents(home());
  });

  afterEach(() => {
    home().app.get(EventEmitter2).removeAllListeners('remote.binding.changed');
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  describe('attach then detach', () => {
    it('moves the project to the host with the same IDs and makes home read-only', async () => {
      const broadcast = jest.spyOn(
        home().app.get<RealtimeBroadcaster>(REALTIME_BROADCASTER),
        'broadcastEvent',
      );

      // Connect requires the remote's reported home folder to equal this PC's.
      const { body: runtime } = await api<{ homePath: string }>(
        instances.host,
        'GET',
        '/api/runtime',
      );
      expect(runtime.homePath).toBe(homedir());

      const started = await startOperation('attach', { projectId: 'A' });
      const done = await waitForState(started.id, 'done');

      expect(done.steps.map((step) => step.id)).toEqual([
        'preflight',
        'git_config',
        'docker_preflight',
        'stop_home_sessions',
        'docker_stop_home',
        'wait_time_batches',
        'freeze_home',
        'build_replica',
        'push_replica',
        'transcripts_push',
        'docker_push',
        'file_sync_initial',
        'file_sync_flip',
        'docker_create_host',
        'bind_remote',
        'thaw_host',
        'start_live_sync',
      ]);
      // A Connect without Docker items skips only the Docker steps.
      expect(
        done.steps.every(
          (step) => step.state === (step.id.startsWith('docker_') ? 'skipped' : 'done'),
        ),
      ).toBe(true);

      const host = instances.host.sqlite;
      expect(host.prepare("SELECT id FROM epics WHERE project_id = 'A' ORDER BY id").all()).toEqual(
        [{ id: 'epic-1' }, { id: 'epic-2' }],
      );
      expect(
        host.prepare("SELECT id FROM agents WHERE project_id = 'A' ORDER BY id").all(),
      ).toEqual([{ id: 'agent-1' }, { id: 'agent-2' }]);
      // Home's provider catalog and threshold landed with the project.
      expect(
        host
          .prepare(
            `SELECT pm.name FROM provider_models pm
             JOIN providers p ON p.id = pm.provider_id WHERE p.name = 'claude' ORDER BY pm.position`,
          )
          .all(),
      ).toEqual([{ name: 'sonnet-4-20250514' }]);
      expect(
        host
          .prepare(
            `SELECT pe.name FROM provider_efforts pe
             JOIN providers p ON p.id = pe.provider_id WHERE p.name = 'claude' ORDER BY pe.position`,
          )
          .all(),
      ).toEqual([{ name: 'high' }]);
      expect(
        host.prepare("SELECT auto_compact_threshold FROM providers WHERE name = 'claude'").get(),
      ).toEqual({ auto_compact_threshold: 42 });
      expect(host.prepare("SELECT frozen_at FROM projects WHERE id = 'A'").get()).toEqual({
        frozen_at: null,
      });

      const binding = bindingRow('A');
      expect(binding?.state).toBe('remote');
      expect(binding?.host_cursor).toBe(done.details.importCursor);
      expect(
        home().sqlite.prepare("SELECT status FROM sessions WHERE id = 'session-live'").get(),
      ).toEqual({ status: 'stopped' });
      expect(home().app.get(ProjectFreezeService).isFrozen('A')).toBe(true);
      expect(home().app.get(RemoteLiveSyncService).isRunning('A')).toBe(true);
      expect(done.details.fileSync).toEqual({
        folders: {
          'code:A': { completion: 100, needItems: 0, needBytes: 0 },
        },
      });
      expect(folderStates(instances.host, 'A')).toEqual({
        'code:A': { type: 'sendreceive', paused: false },
      });
      expect(folderStates(home(), 'A')).toEqual({
        'code:A': { type: 'sendreceive', paused: false },
      });
      expect(fileSyncOf(home()).peers).toEqual(new Set([fileSyncOf(instances.host).deviceId]));
      expect(bindingEvents.map((event) => event.state)).toEqual(['attaching', 'remote']);
      expect(bindingEvents[1]).toEqual({
        projectId: 'A',
        remoteId: remote.id,
        state: 'remote',
        hostCursor: done.details.importCursor,
        syncError: null,
      });
      expect(
        broadcast.mock.calls.some(
          ([topic, type, payload]) =>
            topic === 'remote-operations' &&
            type === 'progress' &&
            (payload as RemoteOperation).id === started.id,
        ),
      ).toBe(true);

      const write = await api(home(), 'POST', '/api/epics', {
        projectId: 'A',
        title: 'At home',
        statusId: 'A-status',
      });
      expect(write.status).toBe(423);
      expect(write.body).toMatchObject({
        code: 'PROJECT_REMOTE',
        details: { projectId: 'A', remoteId: remote.id, remoteName: 'vm-1' },
      });
    });

    it("carries home's instance settings to the host and applies its idle timeout without a restart", async () => {
      const instanceSetting = (db: Database.Database, key: string) =>
        (
          db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | {
                value: string;
              }
            | undefined
        )?.value;
      const keys = [
        'messagePool.enabled',
        'messagePool.delayMs',
        'messagePool.maxWaitMs',
        'messagePool.maxMessages',
        'messagePool.separator',
        'events.epicAssigned.template',
        'skills.sources',
        'activity.idleTimeoutMs',
      ];
      const homeValues = Object.fromEntries(
        keys.map((key) => [key, instanceSetting(home().sqlite, key)]),
      );
      expect(homeValues).toEqual({
        'messagePool.enabled': 'false',
        'messagePool.delayMs': '15000',
        'messagePool.maxWaitMs': '45000',
        'messagePool.maxMessages': '4',
        'messagePool.separator': JSON.stringify('\n==\n'),
        'events.epicAssigned.template': JSON.stringify('[Home] {epic_title} -> {agent_name}'),
        'skills.sources': JSON.stringify({ team: true, community: false }),
        'activity.idleTimeoutMs': '45000',
      });
      for (const key of keys.filter((key) => key !== 'skills.sources')) {
        expect(instanceSetting(instances.host.sqlite, key)).toBe(homeValues[key]);
      }
      expect(JSON.parse(instanceSetting(instances.host.sqlite, 'skills.sources')!)).toEqual({
        ...Object.fromEntries(
          Object.values(BUILT_IN_SKILL_SOURCE_NAMES).map((name) => [name, true]),
        ),
        jeffallan: true,
        team: true,
        community: false,
        'host-only': false,
      });

      // The host app booted before any of these rows existed there: only the
      // post-sync refresh can have moved the running value off 30000.
      const hostActivity = instances.host.app.get(TerminalActivityService);
      await waitForValue(async () => (hostActivity.idleTimeoutMs === 45000 ? true : null), 10_000);
    });

    it('cancelling a refused attach leaves the existing binding and freeze alone', async () => {
      const started = await startOperation('attach', { projectId: 'A' });
      const refused = await waitForState(started.id, 'failed');
      expect(refused.steps[0].error).toMatchObject({ code: 'REMOTE_BINDING_EXISTS' });

      const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

      expect(cancel.body.state).toBe('cancelled');
      expect(bindingRow('A')?.state).toBe('remote');
      expect(home().app.get(ProjectFreezeService).isFrozen('A')).toBe(true);
      expect(hostHasProject('A')).toBe(true);
      expect(bindingEvents).toEqual([]);
    });

    it('cancelling a failed detach gives the project back to the remote', async () => {
      const client = home().app.get(RemoteHostClient);
      jest.spyOn(client, 'exportReplica').mockRejectedValueOnce(new Error('export interrupted'));

      const started = await startOperation('detach', { projectId: 'A' });
      const failed = await waitForState(started.id, 'failed');
      expect(stepStates(failed)).toMatchObject({
        preflight: 'done',
        freeze_host: 'done',
        stop_host_sessions: 'done',
        final_pull: 'failed',
      });
      expect(
        instances.host.sqlite.prepare("SELECT frozen_at FROM projects WHERE id = 'A'").get(),
      ).not.toEqual({ frozen_at: null });
      expect(home().app.get(RemoteLiveSyncService).isRunning('A')).toBe(false);

      const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

      expect(cancel.body.state).toBe('cancelled');
      expect(bindingRow('A')?.state).toBe('remote');
      expect(
        instances.host.sqlite.prepare("SELECT frozen_at FROM projects WHERE id = 'A'").get(),
      ).toEqual({ frozen_at: null });
      expect(home().app.get(RemoteLiveSyncService).isRunning('A')).toBe(true);
      expect(bindingEvents.map((event) => event.state)).toEqual(['detaching', 'remote']);
    });

    it('brings host edits and detach-only rows back, releases the host copy and unbinds', async () => {
      const host = instances.host.sqlite;
      const now = new Date().toISOString();
      host
        .prepare("UPDATE epics SET title = 'Edited on host', updated_at = ? WHERE id = 'epic-2'")
        .run(now);
      host
        .prepare(
          `INSERT INTO sessions (id, agent_id, epic_id, status, started_at, created_at, updated_at)
           VALUES ('session-host', 'agent-1', 'epic-1', 'stopped', ?, ?, ?)`,
        )
        .run(now, now, now);

      const started = await startOperation('detach', { projectId: 'A' });
      const done = await waitForState(started.id, 'done');

      expect(done.steps.every((step) => step.state === 'done')).toBe(true);
      expect(home().sqlite.prepare("SELECT title FROM epics WHERE id = 'epic-2'").get()).toEqual({
        title: 'Edited on host',
      });
      expect(
        home().sqlite.prepare("SELECT agent_id FROM sessions WHERE id = 'session-host'").get(),
      ).toEqual({ agent_id: 'agent-1' });
      expect(hostHasProject('A')).toBe(false);
      expect(bindingRow('A')).toBeUndefined();
      expect(home().app.get(ProjectFreezeService).isFrozen('A')).toBe(false);
      expect(home().app.get(RemoteLiveSyncService).isRunning('A')).toBe(false);
      expect(folderStates(home(), 'A')).toEqual({
        'code:A': { type: 'sendonly', paused: true },
      });
      expect(folderStates(instances.host, 'A')).toEqual({
        'code:A': { type: 'receiveonly', paused: true },
      });
      expect(bindingEvents.map((event) => event.state)).toEqual(['detaching', 'deleted']);

      const write = await api(home(), 'POST', '/api/epics', {
        projectId: 'A',
        title: 'At home again',
        statusId: 'A-status',
      });
      expect(write.status).toBe(201);
    });
  });

  it('takes the replayed push cursor from the host, never from home clock', async () => {
    const client = home().app.get(RemoteHostClient);
    const realImport = client.importProject.bind(client);
    // The host commits the import (freezing the copy from creation), then the
    // step fails before it is persisted done: the freeze answer is lost.
    jest.spyOn(client, 'freeze').mockRejectedValueOnce(new Error('freeze answer lost'));

    const started = await startOperation('attach', { projectId: 'I' });
    const failed = await waitForState(started.id, 'failed');

    expect(stepStates(failed)).toMatchObject({ push_replica: 'failed', bind_remote: 'pending' });
    expect(hostHasProject('I')).toBe(true);
    // `thaw_host` never ran, so the host-issued cursor is still on the host row.
    const hostFrozenAt = (
      instances.host.sqlite.prepare("SELECT frozen_at FROM projects WHERE id = 'I'").get() as {
        frozen_at: string | null;
      }
    ).frozen_at;
    expect(hostFrozenAt).not.toBeNull();

    // Home runs five minutes ahead of the host during the replay: a cursor from
    // home's clock would be newer than every host write and starve the mirror.
    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 5 * 60_000);
    const importOutcomes: string[] = [];
    const importSpy = jest
      .spyOn(client, 'importProject')
      .mockImplementation(async (remoteId, replica) => {
        const outcome = await realImport(remoteId, replica);
        importOutcomes.push(outcome.imported ? 'imported' : outcome.reason);
        return outcome;
      });
    try {
      const retry = await api(home(), 'POST', `/api/remotes/operations/${started.id}/retry`);
      expect(retry.status).toBe(202);
      await waitForState(started.id, 'done');
    } finally {
      clock.mockRestore();
      importSpy.mockRestore();
    }

    expect(importOutcomes).toEqual(['PROJECT_EXISTS']);
    const binding = bindingRow('I');
    expect(binding?.state).toBe('remote');
    expect(binding?.host_cursor).toBe(hostFrozenAt);

    // The review scenario: a host write right after the replay must arrive
    // through the live mirror — a home-clock cursor would omit it as too old.
    const hostEditAt = new Date().toISOString();
    instances.host.sqlite
      .prepare(
        "UPDATE epics SET title = 'Edited on host after replay', updated_at = ? WHERE id = 'epic-i'",
      )
      .run(hostEditAt);
    await waitForValue(async () => {
      const row = home().sqlite.prepare("SELECT title FROM epics WHERE id = 'epic-i'").get() as
        | { title: string }
        | undefined;
      return row?.title === 'Edited on host after replay' ? row : null;
    }, 15_000);
    expect(home().sqlite.prepare("SELECT title FROM epics WHERE id = 'epic-i'").get()).toEqual({
      title: 'Edited on host after replay',
    });
  }, 30_000);

  it('cancel on an attaching binding releases the host copy and leaves home unbound and thawed', async () => {
    const client = home().app.get(RemoteHostClient);
    const realImport = client.importProject.bind(client);
    // The host receives the copy, then the step fails before the host is frozen.
    jest.spyOn(client, 'importProject').mockImplementationOnce(async (remoteId, replica) => {
      await realImport(remoteId, replica);
      throw new Error('connection dropped after import');
    });

    const started = await startOperation('attach', { projectId: 'C' });
    await waitForState(started.id, 'failed');
    expect(hostHasProject('C')).toBe(true);
    expect(bindingRow('C')?.state).toBe('attaching');

    const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

    expect(cancel.status).toBe(200);
    expect(cancel.body.state).toBe('cancelled');
    expect(hostHasProject('C')).toBe(false);
    expect(bindingRow('C')).toBeUndefined();
    expect(home().app.get(ProjectFreezeService).isFrozen('C')).toBe(false);
    expect(bindingEvents.map((event) => event.state)).toEqual(['attaching', 'deleted']);
  });

  it('cancelling an attach after the file sync began stops sharing on both sides and leaves home writable', async () => {
    jest
      .spyOn(home().app.get(FileSyncHandoff), 'flipToHost')
      .mockRejectedValueOnce(new Error('flip interrupted'));

    const started = await startOperation('attach', { projectId: 'J' });
    const failed = await waitForState(started.id, 'failed');
    expect(stepStates(failed)).toMatchObject({
      file_sync_initial: 'done',
      file_sync_flip: 'failed',
      bind_remote: 'pending',
    });
    expect(folderStates(instances.host, 'J')['code:J']).toEqual({
      type: 'receiveonly',
      paused: false,
    });

    const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

    expect(cancel.body.state).toBe('cancelled');
    expect(cancel.body.details).not.toHaveProperty('hostFolderRemovalError');
    expect(folderStates(home(), 'J')).toEqual({ 'code:J': null });
    expect(folderStates(instances.host, 'J')).toEqual({ 'code:J': null });
    expect(bindingRow('J')).toBeUndefined();
    expect(hostHasProject('J')).toBe(false);
    expect(home().app.get(ProjectFreezeService).isFrozen('J')).toBe(false);
  });

  // A cancel while the initial sync itself waits must not sit out the 30-minute
  // sync timeout; only the two-instance layer exercises the runner-to-handoff
  // abort path over the real cancel endpoint.
  it('cancels a Connect while its file sync waits, ending it as cancelled with both folders unshared and home writable', async () => {
    replicaSeeder(home().sqlite).seedProject('L');
    fileSyncOf(home()).gitProjects.add('L');
    // Neither folder ever completes on the receiver, so the sync waits for its
    // 30-minute timeout unless the cancel ends it.
    fileSyncOf(instances.host).need.set('code:L', { needItems: 1, needBytes: 64 });
    fileSyncOf(instances.host).need.set('git:L', { needItems: 1, needBytes: 64 });

    const started = await startOperation('attach', { projectId: 'L' });
    await waitForValue(async () => {
      const { body: operation } = await api(home(), 'GET', `/api/remotes/operations/${started.id}`);
      return stepStates(operation).file_sync_initial === 'running' ? operation : null;
    }, 15_000);

    const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

    expect(cancel.status).toBe(200);
    expect(cancel.body.state).toBe('cancelled');
    expect(cancel.body.details).not.toHaveProperty('hostFolderRemovalError');
    const sync = cancel.body.steps.find((step) => step.id === 'file_sync_initial');
    expect(sync?.error).toMatchObject({ message: 'The Connect was cancelled.' });
    for (const instance of [home(), instances.host]) {
      expect(fileSyncOf(instance).folders.has('code:L')).toBe(false);
      expect(fileSyncOf(instance).folders.has('git:L')).toBe(false);
    }
    expect(bindingRow('L')).toBeUndefined();
    expect(hostHasProject('L')).toBe(false);
    expect(home().app.get(ProjectFreezeService).isFrozen('L')).toBe(false);
    const write = await api(home(), 'POST', '/api/epics', {
      projectId: 'L',
      title: 'Still home',
      statusId: 'L-status',
    });
    expect(write.status).toBe(201);
  }, 30_000);

  // A retry sets the failed sync step back to pending. A cancel that arrives
  // while the retried step's start is saved must still undo the first attempt.
  it('undoes the first sync attempt when its retry is cancelled before the step starts again', async () => {
    replicaSeeder(home().sqlite).seedProject('M');
    fileSyncOf(home()).gitProjects.add('M');
    const initial = jest.spyOn(home().app.get(FileSyncHandoff), 'initial');
    const interrupt = jest.spyOn(home().app.get(AttachOperation), 'interrupt');
    jest
      .spyOn(fileSyncOf(home()), 'waitForComplete')
      .mockRejectedValueOnce(new Error('sync timed out'));

    const started = await startOperation('attach', { projectId: 'M' });
    const failed = await waitForState(started.id, 'failed');
    expect(stepStates(failed).file_sync_initial).toBe('failed');
    for (const instance of [home(), instances.host]) {
      expect(fileSyncOf(instance).folders.has('code:M')).toBe(true);
      expect(fileSyncOf(instance).folders.has('git:M')).toBe(true);
    }

    // Hold the retried step's start write, so the cancel finds no step to interrupt.
    const storage = home().app.get<{
      updateRemoteOperation(id: string, data: UpdateRemoteOperation): Promise<RemoteOperation>;
    }>(STORAGE_SERVICE);
    const save = storage.updateRemoteOperation.bind(storage);
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    jest.spyOn(storage, 'updateRemoteOperation').mockImplementation(async (id, data) => {
      const starting = data.steps?.some(
        (step) => step.id === 'file_sync_initial' && step.state === 'running',
      );
      if (starting && !held) {
        held = true;
        await released;
      }
      return save(id, data);
    });
    const retry = await api(home(), 'POST', `/api/remotes/operations/${started.id}/retry`);
    expect(retry.status).toBe(202);
    await waitForValue(async () => (held ? true : null), 10_000);

    const cancelling = api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);
    await waitForValue(async () => (interrupt.mock.calls.length > 0 ? true : null), 10_000);
    release();
    const cancel = await cancelling;

    expect(cancel.status).toBe(200);
    expect(cancel.body.state).toBe('cancelled');
    expect(cancel.body.details).not.toHaveProperty('hostFolderRemovalError');
    expect(initial).toHaveBeenCalledTimes(1);
    for (const instance of [home(), instances.host]) {
      expect(fileSyncOf(instance).folders.has('code:M')).toBe(false);
      expect(fileSyncOf(instance).folders.has('git:M')).toBe(false);
    }
    expect(bindingRow('M')).toBeUndefined();
    expect(hostHasProject('M')).toBe(false);
    expect(home().app.get(ProjectFreezeService).isFrozen('M')).toBe(false);
  }, 30_000);

  it('cancelling a detach after its file flip makes the remote the file writer again', async () => {
    const attach = await startOperation('attach', { projectId: 'K' });
    await waitForState(attach.id, 'done');
    const handoff = home().app.get(FileSyncHandoff);
    const realFlip = handoff.flipToHome.bind(handoff);
    jest.spyOn(handoff, 'flipToHome').mockImplementationOnce(async (...args) => {
      await realFlip(...args);
      throw new Error('answer lost after the flip');
    });

    const started = await startOperation('detach', { projectId: 'K' });
    const failed = await waitForState(started.id, 'failed');
    expect(stepStates(failed)).toMatchObject({
      file_sync_final: 'done',
      file_sync_flip: 'failed',
      host_release: 'pending',
    });
    expect(folderStates(home(), 'K')['code:K']).toEqual({ type: 'sendonly', paused: true });

    const cancel = await api(home(), 'POST', `/api/remotes/operations/${started.id}/cancel`);

    expect(cancel.body.state).toBe('cancelled');
    expect(folderStates(instances.host, 'K')).toEqual({
      'code:K': { type: 'sendreceive', paused: false },
    });
    expect(folderStates(home(), 'K')).toEqual({
      'code:K': { type: 'sendreceive', paused: false },
    });
    expect(bindingRow('K')?.state).toBe('remote');
  });

  it('refuses a second operation for the same project with 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const freeze = home().app.get(ProjectFreezeService);
    const realFreeze = freeze.freeze.bind(freeze);
    jest.spyOn(freeze, 'freeze').mockImplementationOnce(async (projectId) => {
      await gate;
      return realFreeze(projectId);
    });

    const started = await startOperation('attach', { projectId: 'D' });
    const second = await api(home(), 'POST', `/api/remotes/${remote.id}/attach`, {
      projectId: 'D',
    });
    const detach = await api(home(), 'POST', `/api/remotes/${remote.id}/detach`, {
      projectId: 'D',
    });

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: started.id },
    });
    expect(detach.status).toBe(409);

    release();
    await waitForState(started.id, 'done');
  });

  it('resumes a running operation from its last persisted step after a home restart', async () => {
    const freeze = home().app.get(ProjectFreezeService);
    // The first app never finishes `freeze_home`; it is closed with that step in flight.
    jest.spyOn(freeze, 'freeze').mockImplementationOnce(() => new Promise(() => undefined));

    const started = await startOperation('attach', { projectId: 'E' });
    const inFlight = await waitForValue(async () => {
      const { body: operation } = await api(home(), 'GET', `/api/remotes/operations/${started.id}`);
      return stepStates(operation).freeze_home === 'running' ? operation : null;
    }, 10_000);
    const preflightStartedAt = inFlight.steps[0].startedAt;

    await instances.restartHome();
    listenForBindingEvents(home());
    await waitUntilRemoteOnline();
    const done = await waitForState(started.id, 'done');

    expect(done.steps[0].startedAt).toBe(preflightStartedAt);
    expect(
      done.steps.every(
        (step) => step.state === (step.id.startsWith('docker_') ? 'skipped' : 'done'),
      ),
    ).toBe(true);
    expect(hostHasProject('E')).toBe(true);
    expect(bindingRow('E')?.state).toBe('remote');
    expect(home().app.get(ProjectFreezeService).isFrozen('E')).toBe(true);
    expect(bindingEvents.map((event) => event.state)).toEqual(['attaching', 'remote']);
  }, 30_000);

  describe('a detach takes over a failed attach that already bound the project', () => {
    /** Runs an attach of `projectId` whose `thaw_host` fails once, after `bind_remote` handed the project over. */
    async function attachFailingAtThaw(projectId: string): Promise<RemoteOperation> {
      const client = home().app.get(RemoteHostClient);
      jest.spyOn(client, 'thaw').mockRejectedValueOnce(new Error('host went away'));
      const started = await startOperation('attach', { projectId });
      const failed = await waitForState(started.id, 'failed');
      expect(stepStates(failed)).toMatchObject({
        bind_remote: 'done',
        thaw_host: 'failed',
        start_live_sync: 'pending',
      });
      expect(bindingRow(projectId)?.state).toBe('remote');
      return failed;
    }

    const putStatus = (projectId: string, label: string) =>
      api(home(), 'PUT', `/api/statuses/${projectId}-status`, { label });

    it('forced, with the host stopped: cancels the attach without rollback and gives the project back', async () => {
      const failed = await attachFailingAtThaw('F');
      const importCursor = (failed.details as { importCursor: string }).importCursor;
      await instances.host.close();
      await waitForValue(async () => {
        const { body } = await api<RemoteList>(home(), 'GET', '/api/remotes');
        return body.items[0]?.online === false;
      }, 10_000);
      const refusedCancel = await api(
        home(),
        'POST',
        `/api/remotes/operations/${failed.id}/cancel`,
      );
      expect(refusedCancel).toMatchObject({
        status: 409,
        body: { details: { code: 'REMOTE_OPERATION_NOT_CANCELLABLE' } },
      });

      const started = await startOperation('detach', { projectId: 'F', force: true });
      const done = await waitForState(started.id, 'done');

      const { body: superseded } = await api(home(), 'GET', `/api/remotes/operations/${failed.id}`);
      expect(superseded).toMatchObject({
        state: 'cancelled',
        steps: failed.steps,
        details: { importCursor, supersededBy: started.id, supersededAt: expect.any(String) },
      });
      expect(superseded.details).not.toHaveProperty('hostReleaseError');
      const cancelAgain = await api(home(), 'POST', `/api/remotes/operations/${failed.id}/cancel`);
      expect(cancelAgain).toMatchObject({
        status: 409,
        body: { details: { code: 'REMOTE_OPERATION_FINISHED' } },
      });
      expect(done.details.forcedLoss).toMatchObject({ hostCursor: importCursor });
      expect(bindingRow('F')).toBeUndefined();
      expect((await putStatus('F', 'Home again')).status).toBe(200);

      // No rollback ran: the host copy, with the host's work, is still there.
      await instances.restartHost();
      expect(hostHasProject('F')).toBe(true);
      await waitUntilRemoteOnline();
    }, 30_000);

    it('not forced, with the host reachable: runs the whole detach from the bound state', async () => {
      const failed = await attachFailingAtThaw('G');

      const started = await startOperation('detach', { projectId: 'G' });
      const done = await waitForState(started.id, 'done');

      expect(stepStates(done)).toEqual({
        preflight: 'done',
        freeze_host: 'done',
        stop_host_sessions: 'done',
        docker_stop_host: 'done',
        wait_time_batches: 'done',
        final_pull: 'done',
        transcripts_pull: 'done',
        file_sync_final: 'done',
        file_sync_flip: 'done',
        host_release: 'done',
        unbind: 'done',
        thaw_home: 'done',
      });
      const { body: superseded } = await api(home(), 'GET', `/api/remotes/operations/${failed.id}`);
      expect(superseded).toMatchObject({
        state: 'cancelled',
        details: { supersededBy: started.id },
      });
      expect(hostHasProject('G')).toBe(false);
      expect(bindingRow('G')).toBeUndefined();
      expect((await putStatus('G', 'Home again')).status).toBe(200);
    }, 30_000);

    it('still refuses a detach while a failed attach has not bound the project, and cancels it', async () => {
      const client = home().app.get(RemoteHostClient);
      jest.spyOn(client, 'importProject').mockRejectedValueOnce(new Error('host import broke'));
      const attach = await startOperation('attach', { projectId: 'H' });
      const failed = await waitForState(attach.id, 'failed');
      expect(stepStates(failed)).toMatchObject({ push_replica: 'failed', bind_remote: 'pending' });

      const refused = await api(home(), 'POST', `/api/remotes/${remote.id}/detach`, {
        projectId: 'H',
        force: true,
      });
      expect(refused).toMatchObject({
        status: 409,
        body: { details: { code: 'REMOTE_OPERATION_IN_PROGRESS', operationId: failed.id } },
      });

      const cancelled = await api(home(), 'POST', `/api/remotes/operations/${failed.id}/cancel`);
      expect(cancelled).toMatchObject({ status: 200, body: { state: 'cancelled' } });
      expect(bindingRow('H')).toBeUndefined();
    }, 30_000);
  });

  it('forced detach with the host stopped replaces the refused detach, unbinds, thaws home and records the mirror age', async () => {
    const attach = await startOperation('attach', { projectId: 'A' });
    await waitForState(attach.id, 'done');
    // What home's Syncthing last knew it still needed from the host.
    fileSyncOf(home()).need.set('code:A', { needItems: 3, needBytes: 4096 });
    await instances.host.close();
    await waitForValue(async () => {
      const { body } = await api<RemoteList>(home(), 'GET', '/api/remotes');
      return body.items[0]?.online === false;
    }, 10_000);

    const plain = await startOperation('detach', { projectId: 'A' });
    const refused = await waitForState(plain.id, 'failed');
    expect(refused.steps[0].error).toMatchObject({ code: 'REMOTE_OFFLINE' });

    const started = await startOperation('detach', { projectId: 'A', force: true });
    const done = await waitForState(started.id, 'done');
    const { body: replaced } = await api(home(), 'GET', `/api/remotes/operations/${plain.id}`);
    expect(replaced.state).toBe('cancelled');

    expect(stepStates(done)).toEqual({
      preflight: 'done',
      freeze_host: 'skipped',
      stop_host_sessions: 'skipped',
      docker_stop_host: 'skipped',
      wait_time_batches: 'skipped',
      final_pull: 'skipped',
      transcripts_pull: 'skipped',
      file_sync_final: 'skipped',
      file_sync_flip: 'done',
      host_release: 'skipped',
      unbind: 'done',
      thaw_home: 'done',
    });
    expect(done.details.forcedLoss).toEqual({
      hostCursor: expect.any(String),
      mirrorAgeMs: expect.any(Number),
      fileSync: {
        folders: [{ id: 'code:A', needItems: 3, needBytes: 4096 }],
      },
      teamLanes: 'unfinalized',
      transcripts: 'remote-changes',
    });
    // The flip reached home only: home writes again and shares nothing while disconnected.
    expect(folderStates(home(), 'A')).toEqual({
      'code:A': { type: 'sendonly', paused: true },
    });
    expect((done.details.forcedLoss as { mirrorAgeMs: number }).mirrorAgeMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(bindingRow('A')).toBeUndefined();
    expect(home().app.get(ProjectFreezeService).isFrozen('A')).toBe(false);
  }, 30_000);
});
