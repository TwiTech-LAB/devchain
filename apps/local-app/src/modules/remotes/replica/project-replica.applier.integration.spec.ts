import { BUILT_IN_SKILL_SOURCE_NAMES } from '../../../common/constants/built-in-skill-sources';
/**
 * ProjectReplicaApplier over two migrated in-memory SQLite databases.
 * Test layer: storage integration. The applier's contract is SQLite behavior
 * under real constraints (unique positions, RESTRICT/CASCADE foreign keys,
 * one transaction), which only a migrated schema exercises. Replicas are
 * built by the real builder so the round trip is covered end to end.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ProjectReplicaScope, ProjectReplicaV1 } from '@devchain/shared';
import { ReplicaApplyError } from '../../../common/errors/error-types';
import { remoteProjectSyncedEvent } from '../../events/catalog/remote.project.synced';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { ProjectReplicaApplier } from './project-replica.applier';
import { ProjectReplicaBuilder } from './project-replica.builder';
import {
  INSTANCE_SETTING_KEYS,
  T,
  WORKSPACE_ID,
  createReplicaDb,
  replicaSeeder,
  seedReplicaSource,
  stamps,
} from './__fixtures__/replica-seed';

const builtInsOn = Object.fromEntries(
  Object.values(BUILT_IN_SKILL_SOURCE_NAMES).map((name) => [name, true]),
);

const MIRRORED_TABLES = [
  'project_workspaces',
  'paired_device_workspace_grants',
  'projects',
  'statuses',
  'tags',
  'prompts',
  'prompt_tags',
  'agent_profiles',
  'agent_profile_prompts',
  'profile_provider_configs',
  'providers',
  'provider_env_scopes',
  'provider_models',
  'provider_efforts',
  'provider_plugin_defaults',
  'project_provider_plugin_overrides',
  'skill_project_disabled',
  'source_project_enabled',
  'agents',
  'teams',
  'team_members',
  'team_profiles',
  'team_profile_configs',
  'terminal_watchers',
  'automation_subscribers',
  'scheduled_epics',
  'settings',
  'epics',
  'epic_tags',
  'epic_comments',
  'epic_relations',
  'reviews',
  'review_comments',
  'epic_time_segments',
  'sessions',
  'epic_time_session_watermarks',
  'external_task_links',
  'external_managed_subtask_links',
];

describe('ProjectReplicaApplier (integration)', () => {
  let home: Database.Database;
  let host: Database.Database;
  let homeBuilder: ProjectReplicaBuilder;
  let hostBuilder: ProjectReplicaBuilder;
  let hostStorage: LocalStorageService;
  let homeStorage: LocalStorageService;
  let applier: ProjectReplicaApplier;
  let homeApplier: ProjectReplicaApplier;
  let emitted: PreparedEvent[];
  let homeSeed: ReturnType<typeof replicaSeeder>;
  let hostSeed: ReturnType<typeof replicaSeeder>;

  beforeEach(() => {
    const homeDb = createReplicaDb();
    const hostDb = createReplicaDb();
    home = homeDb.sqlite;
    host = hostDb.sqlite;
    seedReplicaSource(home);
    homeSeed = replicaSeeder(home);
    hostSeed = replicaSeeder(host);
    homeSeed.insert('statuses', {
      id: 'A-status-2',
      project_id: 'A',
      label: 'Done',
      color: '#000',
      position: 1,
      mcp_hidden: 0,
      ...stamps,
    });
    // Same provider names under different IDs: configs must be remapped by name.
    for (const name of ['claude', 'codex']) {
      hostSeed.insert('providers', {
        id: `host-${name}`,
        name,
        mcp_configured: 0,
        env: JSON.stringify({ HOST_ONLY: 'h' }),
        ...stamps,
      });
    }

    homeStorage = new LocalStorageService(homeDb.db);
    hostStorage = new LocalStorageService(hostDb.db);
    homeBuilder = new ProjectReplicaBuilder(homeStorage);
    hostBuilder = new ProjectReplicaBuilder(hostStorage);
    emitted = [];
    const events: ProjectReplicaApplierEvents = {
      prepareCommitted: (name, payload) => ({
        id: randomUUID(),
        name,
        payload: remoteProjectSyncedEvent.schema.parse(payload),
        requestId: null,
        publishedAt: T,
      }),
      emitCommitted: (event) => {
        emitted.push(event);
      },
    };
    applier = new ProjectReplicaApplier(hostStorage, events);
    homeApplier = new ProjectReplicaApplier(homeStorage, events);
  });

  afterEach(() => {
    home.close();
    host.close();
  });

  type ProjectReplicaApplierEvents = ConstructorParameters<typeof ProjectReplicaApplier>[1];

  async function build<S extends ProjectReplicaScope>(
    scope: S,
    builder = homeBuilder,
  ): Promise<Extract<ProjectReplicaV1, { scope: S }>> {
    const result = await builder.build({ projectIds: ['A'], scope });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.replica;
  }

  function snapshot(db: Database.Database): Record<string, unknown[]> {
    return Object.fromEntries(
      MIRRORED_TABLES.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  }

  function syncedEvents(db: Database.Database): Array<{ name: string; payload: unknown }> {
    return (
      db.prepare('SELECT name, payload_json FROM events ORDER BY rowid').all() as Array<{
        name: string;
        payload_json: string;
      }>
    ).map((row) => ({ name: row.name, payload: JSON.parse(row.payload_json) }));
  }

  const count = (db: Database.Database, sql: string, ...params: unknown[]): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number }).n;

  /**
   * The instance-level agent settings an attach replica carries, keyed by
   * setting key and JSON-decoded: the apply writes the canonical encoding, so
   * equality is on decoded values, not on the sender's raw spacing.
   */
  const keyPlaceholders = INSTANCE_SETTING_KEYS.map(() => '?').join(', ');
  const instanceSettingsRows = (db: Database.Database): Record<string, unknown> =>
    Object.fromEntries(
      (
        db
          .prepare(`SELECT key, value FROM settings WHERE key IN (${keyPlaceholders}) ORDER BY key`)
          .all(...INSTANCE_SETTING_KEYS) as Array<{ key: string; value: string }>
      ).map((row) => {
        let decoded: unknown = row.value;
        try {
          decoded = JSON.parse(row.value);
        } catch {
          // Plain string storage ('true', '25000', the raw input mode); compare it verbatim.
        }
        return [row.key, decoded];
      }),
    );

  it('applies an attach replica with preserved IDs and providers mapped by name', async () => {
    const replica = await build('attach');

    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });

    const copied = await build('attach', hostBuilder);
    const hostProviderName = new Map([
      ['host-claude', 'claude'],
      ['host-codex', 'codex'],
    ]);
    const homeProviderName = new Map(replica.tables.providers.map((p) => [p.id, p.name]));
    const byName = <T extends { provider_id: string }>(rows: T[], names: Map<string, string>) =>
      rows.map((row) => ({ ...row, provider_id: names.get(row.provider_id) }));
    const watcherByName = (
      rows: typeof replica.tables.terminal_watchers,
      names: Map<string, string>,
    ) =>
      rows.map((row) => ({
        ...row,
        scope_filter_id: row.scope_filter_id ? names.get(row.scope_filter_id) : null,
      }));

    const withoutProviderIds = ({
      providers: _providers,
      profile_provider_configs: _configs,
      terminal_watchers: _watchers,
      ...rest
    }: typeof replica.tables) => rest;
    const expected = replica.tables;
    expect(copied.tables.providers.map((p) => p.name)).toEqual(
      expected.providers.map((p) => p.name),
    );
    expect(byName(copied.tables.profile_provider_configs, hostProviderName)).toEqual(
      byName(expected.profile_provider_configs, homeProviderName),
    );
    expect(watcherByName(copied.tables.terminal_watchers, hostProviderName)).toEqual(
      watcherByName(expected.terminal_watchers, homeProviderName),
    );
    expected.provider_settings = expected.provider_settings.map((row) => {
      const envScopes: Record<string, string[]> =
        row.providerName === 'claude' ? { API_KEY: ['A'] } : {};
      return { ...row, envScopes };
    });
    expect(withoutProviderIds(copied.tables)).toEqual(withoutProviderIds(expected));
    expect(copied.workspace).toEqual(replica.workspace);

    const claude = host.prepare("SELECT env FROM providers WHERE id = 'host-claude'").get() as {
      env: string;
    };
    expect(JSON.parse(claude.env)).toEqual({ UNSCOPED: 'x', API_KEY: 'secret-a' });
  });

  it('round-trips disabled skill and source switches across attach and detach', async () => {
    homeSeed.seedSkill('home-skill', 'team/disabled-skill');
    hostSeed.seedSkill('host-skill', 'team/disabled-skill');
    homeSeed.insert('skill_project_disabled', {
      id: 'disabled-home',
      project_id: 'A',
      skill_id: 'home-skill',
      created_at: T,
    });
    homeSeed.insert('source_project_enabled', {
      id: 'team-source-home',
      project_id: 'A',
      source_name: 'team',
      enabled: 0,
      created_at: T,
    });
    homeSeed.insert('source_project_enabled', {
      id: 'home-only-source',
      project_id: 'A',
      source_name: 'home-only',
      enabled: 1,
      created_at: T,
    });
    const attach = await build('attach');
    expect(attach.tables.skill_project_disabled).toEqual([
      {
        id: 'disabled-home',
        project_id: 'A',
        skill_slug: 'team/disabled-skill',
        created_at: T,
      },
    ]);
    const [attachSummary] = await applier.apply(attach, {
      mode: 'full',
      remoteId: null,
      cursor: null,
    });

    expect(attachSummary.skippedUnknownSkillCount).toBe(0);
    expect(
      host.prepare('SELECT id, project_id, skill_id FROM skill_project_disabled').all(),
    ).toEqual([{ id: 'disabled-home', project_id: 'A', skill_id: 'host-skill' }]);
    expect(
      host
        .prepare(
          'SELECT id, project_id, source_name, enabled FROM source_project_enabled ORDER BY source_name',
        )
        .all(),
    ).toEqual([
      { id: 'home-only-source', project_id: 'A', source_name: 'home-only', enabled: 1 },
      { id: 'team-source-home', project_id: 'A', source_name: 'team', enabled: 0 },
    ]);

    host
      .prepare('UPDATE skill_project_disabled SET id = ? WHERE project_id = ?')
      .run('disabled-host', 'A');
    host
      .prepare('UPDATE source_project_enabled SET id = ? WHERE source_name = ?')
      .run('team-source-host', 'team');
    hostSeed.insert('source_project_enabled', {
      id: 'host-only-source',
      project_id: 'A',
      source_name: 'host-only',
      enabled: 1,
      created_at: T,
    });

    await applier.apply(attach, { mode: 'full', remoteId: null, cursor: null });

    expect(
      host.prepare('SELECT id, project_id, skill_id FROM skill_project_disabled').all(),
    ).toEqual([{ id: 'disabled-host', project_id: 'A', skill_id: 'host-skill' }]);
    expect(
      host
        .prepare(
          'SELECT id, project_id, source_name, enabled FROM source_project_enabled ORDER BY source_name',
        )
        .all(),
    ).toEqual([
      { id: 'home-only-source', project_id: 'A', source_name: 'home-only', enabled: 1 },
      { id: 'team-source-host', project_id: 'A', source_name: 'team', enabled: 0 },
    ]);

    host.prepare('DELETE FROM skill_project_disabled WHERE project_id = ?').run('A');
    host.prepare('UPDATE source_project_enabled SET enabled = 1 WHERE source_name = ?').run('team');
    host.prepare('DELETE FROM source_project_enabled WHERE source_name = ?').run('home-only');
    hostSeed.insert('source_project_enabled', {
      id: 'host-only-source',
      project_id: 'A',
      source_name: 'host-only',
      enabled: 1,
      created_at: T,
    });

    const detach = await build('detach', hostBuilder);
    const [detachSummary] = await homeApplier.apply(detach, {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(detachSummary.skippedUnknownSkillCount).toBe(0);
    expect(
      home.prepare('SELECT * FROM skill_project_disabled WHERE project_id = ?').all('A'),
    ).toEqual([]);
    expect(
      home
        .prepare(
          'SELECT id, project_id, source_name, enabled FROM source_project_enabled ORDER BY source_name',
        )
        .all(),
    ).toEqual([
      { id: 'host-only-source', project_id: 'A', source_name: 'host-only', enabled: 1 },
      { id: 'team-source-home', project_id: 'A', source_name: 'team', enabled: 1 },
    ]);
  });

  it('preserves a home switch across connect and disconnect when the host lacks its skill', async () => {
    homeSeed.seedSkill('home-only-skill', 'team/not-installed-on-host');
    homeSeed.insert('skill_project_disabled', {
      id: 'unknown-skill-switch',
      project_id: 'A',
      skill_id: 'home-only-skill',
      created_at: T,
    });
    homeSeed.insert('source_project_enabled', {
      id: 'source-still-applies',
      project_id: 'A',
      source_name: 'team',
      enabled: 0,
      created_at: T,
    });

    const [summary] = await applier.apply(await build('attach'), {
      mode: 'full',
      remoteId: null,
      cursor: null,
    });

    expect(summary.skippedUnknownSkillCount).toBe(1);
    expect(host.prepare('SELECT * FROM skill_project_disabled').all()).toEqual([]);
    expect(host.prepare('SELECT source_name, enabled FROM source_project_enabled').all()).toEqual([
      { source_name: 'team', enabled: 0 },
    ]);

    const detach = await build('detach', hostBuilder);
    const [detachSummary] = await homeApplier.apply(detach, {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(detachSummary.skippedUnknownSkillCount).toBe(0);
    expect(
      home.prepare('SELECT id, project_id, skill_id FROM skill_project_disabled').all(),
    ).toEqual([{ id: 'unknown-skill-switch', project_id: 'A', skill_id: 'home-only-skill' }]);
  });

  it('reconciles home-authoritative kids while preserving VM-only and other-workspace grants', async () => {
    const replica = await build('attach');
    replica.tables.authorityKids = ['home-phone', 'shared-phone', 'revoked-phone'];
    replica.tables.paired_device_workspace_grants = [
      { device_kid: 'home-phone', workspace_id: WORKSPACE_ID },
    ];
    hostSeed.insert('project_workspaces', {
      id: 'host-workspace',
      name: 'VM local',
      is_default: 0,
      position: 1,
      ...stamps,
    });
    for (const [device_kid, workspace_id] of [
      ['vm-only', WORKSPACE_ID],
      ['shared-phone', WORKSPACE_ID],
      ['revoked-phone', WORKSPACE_ID],
      ['home-phone', 'host-workspace'],
    ]) {
      hostSeed.insert('paired_device_workspace_grants', { device_kid, workspace_id });
    }
    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });
    expect(
      host
        .prepare('SELECT * FROM paired_device_workspace_grants ORDER BY device_kid, workspace_id')
        .all(),
    ).toEqual([
      { device_kid: 'home-phone', workspace_id: WORKSPACE_ID },
      { device_kid: 'home-phone', workspace_id: 'host-workspace' },
      { device_kid: 'vm-only', workspace_id: WORKSPACE_ID },
    ]);
    replica.tables.paired_device_workspace_grants = [];
    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });
    expect(
      host.prepare('SELECT * FROM paired_device_workspace_grants ORDER BY device_kid').all(),
    ).toEqual([
      { device_kid: 'home-phone', workspace_id: 'host-workspace' },
      { device_kid: 'vm-only', workspace_id: WORKSPACE_ID },
    ]);
  });

  it('keeps grants for an older attach, a home re-snapshot and a detach', async () => {
    const replica = await build('attach');
    hostSeed.insert('paired_device_workspace_grants', {
      device_kid: 'phone',
      workspace_id: WORKSPACE_ID,
    });
    delete replica.tables.authorityKids;
    delete replica.tables.paired_device_workspace_grants;
    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });
    replica.tables.authorityKids = ['phone'];
    replica.tables.paired_device_workspace_grants = [];
    await applier.apply(replica, {
      mode: 'full',
      remoteId: null,
      cursor: null,
      keepInstanceConfig: true,
    });
    homeSeed.insert('paired_device_workspace_grants', {
      device_kid: 'home-only',
      workspace_id: WORKSPACE_ID,
    });
    await homeApplier.apply(await build('detach', hostBuilder), {
      mode: 'full',
      remoteId: null,
      cursor: null,
    });
    expect(host.prepare('SELECT * FROM paired_device_workspace_grants').all()).toEqual([
      { device_kid: 'phone', workspace_id: WORKSPACE_ID },
    ]);
    expect(home.prepare('SELECT * FROM paired_device_workspace_grants').all()).toEqual([
      { device_kid: 'home-only', workspace_id: WORKSPACE_ID },
    ]);
  });

  it('rejects an out-of-workspace grant before any rows change', async () => {
    const replica = await build('attach');
    replica.tables.authorityKids = ['phone'];
    replica.tables.paired_device_workspace_grants = [
      { device_kid: 'phone', workspace_id: 'other' },
    ];
    const before = snapshot(host);
    await expect(
      applier.apply(replica, { mode: 'full', remoteId: null, cursor: null }),
    ).rejects.toBeInstanceOf(ReplicaApplyError);
    expect(snapshot(host)).toEqual(before);
  });

  it('is a no-op when the same payload is applied twice', async () => {
    const replica = await build('attach');
    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });
    const before = snapshot(host);

    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });

    expect(snapshot(host)).toEqual(before);
    const events = syncedEvents(host);
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({ changedEpicIds: [], deletedEpicIds: [] });
  });

  it('applies swapped positions, an agent removal with its sessions and a new agent in one live apply', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    hostSeed.insert('sessions', {
      id: 'host-session-agent-2',
      agent_id: 'agent-2',
      status: 'stopped',
      started_at: T,
      ...stamps,
    });
    hostSeed.insert('epic_time_session_watermarks', {
      session_id: 'host-session-agent-2',
      project_id: 'A',
      last_activity_at: T,
      ...stamps,
    });

    home.exec(`
      UPDATE statuses SET position = -1 WHERE id = 'A-status';
      UPDATE statuses SET position = 0 WHERE id = 'A-status-2';
      UPDATE statuses SET position = 1 WHERE id = 'A-status';
      DELETE FROM agents WHERE id = 'agent-2';
    `);
    homeSeed.seedProfile('profile-new', 'A', 'prov-claude');
    homeSeed.seedAgent('agent-3', 'A', 'profile-new');

    await applier.apply(await build('live'), {
      mode: 'live',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(
      host
        .prepare("SELECT id, position FROM statuses WHERE project_id = 'A' ORDER BY position")
        .all(),
    ).toEqual([
      { id: 'A-status-2', position: 0 },
      { id: 'A-status', position: 1 },
    ]);
    expect(count(host, "SELECT 1 FROM agents WHERE id = 'agent-2'")).toBe(0);
    expect(count(host, "SELECT 1 FROM sessions WHERE agent_id = 'agent-2'")).toBe(0);
    expect(
      host
        .prepare(
          `SELECT a.id, a.provider_config_id, c.provider_id FROM agents a
           JOIN profile_provider_configs c ON c.id = a.provider_config_id
           WHERE a.id = 'agent-3'`,
        )
        .get(),
    ).toEqual({
      id: 'agent-3',
      provider_config_id: 'profile-new-config',
      provider_id: 'host-claude',
    });
    expect(count(host, "SELECT 1 FROM agent_profiles WHERE id = 'profile-new'")).toBe(1);
  });

  it('applies a relation-only change without touching epics', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    const epicsBefore = host.prepare('SELECT * FROM epics ORDER BY id').all();
    home.exec(`
      DELETE FROM epic_relations WHERE id = 'relation-internal';
      INSERT INTO epic_relations (id, left_epic_id, right_epic_id, type, direction, created_by, created_at, updated_at)
      VALUES ('relation-recreated', 'epic-1', 'epic-2', 'blocks', 'left_to_right', 'agent', '${T}', '${T}');
    `);

    const [summary] = await applier.apply(await build('live'), {
      mode: 'live',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(
      host.prepare("SELECT id, type FROM epic_relations WHERE left_epic_id = 'epic-1'").all(),
    ).toEqual([{ id: 'relation-recreated', type: 'blocks' }]);
    expect(host.prepare('SELECT * FROM epics ORDER BY id').all()).toEqual(epicsBefore);
    expect(summary).toEqual({
      projectId: 'A',
      changedEpicIds: [],
      deletedEpicIds: [],
      skippedUnknownSkillCount: 0,
    });
  });

  it('keeps external task and managed subtask links of mirrored epics across live and full applies', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    hostSeed.insert('external_task_links', {
      id: 'link-1',
      epic_id: 'epic-1',
      project_id: 'A',
      provider: 'jira',
      remote_scope_key: 'site',
      remote_task_id: 'JIRA-1',
      source_snapshot: '{}',
      ...stamps,
    });
    hostSeed.insert('external_managed_subtask_links', {
      id: 'subtask-link-1',
      epic_id: 'epic-2',
      epic_id_snapshot: 'epic-2',
      parent_epic_id_snapshot: 'epic-1',
      parent_source_link_id_snapshot: 'link-1',
      connection_id_snapshot: 'connection-1',
      provider: 'jira',
      remote_scope_key: 'site',
      work_area_remote_id: 'area',
      parent_remote_task_id: 'JIRA-1',
      connection_generation: 1,
      sync_setting_revision: 1,
      ownership_token: 'token',
      desired_version: 1,
      desired_fingerprint: 'fp',
      ...stamps,
    });
    home.exec(`UPDATE epics SET title = 'Renamed', version = 2 WHERE id IN ('epic-1', 'epic-2')`);

    const [live] = await applier.apply(await build('live'), {
      mode: 'live',
      remoteId: 'remote-1',
      cursor: T,
    });
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(live.changedEpicIds).toEqual(['epic-1', 'epic-2']);
    expect(host.prepare('SELECT id, epic_id FROM external_task_links').all()).toEqual([
      { id: 'link-1', epic_id: 'epic-1' },
    ]);
    expect(host.prepare('SELECT id, epic_id FROM external_managed_subtask_links').all()).toEqual([
      { id: 'subtask-link-1', epic_id: 'epic-2' },
    ]);
    expect(host.prepare("SELECT title, version FROM epics WHERE id = 'epic-1'").get()).toEqual({
      title: 'Renamed',
      version: 2,
    });
  });

  it('appends exactly one remote.project.synced event with the deleted epic IDs and no epic events', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    home.exec(`DELETE FROM epics WHERE id = 'epic-2'`);

    const [summary] = await applier.apply(await build('attach'), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    const events = syncedEvents(host);
    expect(events.map((event) => event.name)).toEqual([
      'remote.project.synced',
      'remote.project.synced',
    ]);
    expect(events[1].payload).toEqual({
      projectId: 'A',
      workspaceId: WORKSPACE_ID,
      remoteId: 'remote-1',
      changedEpicIds: [],
      deletedEpicIds: ['epic-2'],
      cursor: T,
    });
    expect(summary.deletedEpicIds).toEqual(['epic-2']);
    expect(emitted.map((event) => event.payload)).toEqual(events.map((event) => event.payload));
    expect(count(host, "SELECT 1 FROM epics WHERE id = 'epic-2'")).toBe(0);
  });

  it('deletes on a live apply only what the host ID sets no longer contain', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    home.exec(`
      DELETE FROM epic_comments WHERE id = 'comment-1';
      DELETE FROM epics WHERE id = 'epic-2';
      DELETE FROM epic_time_segments WHERE id = 'segment-settled';
    `);
    const feed = await homeBuilder.build({
      projectIds: ['A'],
      scope: 'live',
      changedSince: '9999-12-31T00:00:00.000Z',
      includeIdSets: true,
    });
    if (!feed.ok) throw new Error(JSON.stringify(feed.errors));

    const [withoutSets] = await applier.apply(feed.replica, {
      mode: 'live',
      remoteId: 'remote-1',
      cursor: T,
    });
    expect(withoutSets.deletedEpicIds).toEqual([]);
    expect(count(host, "SELECT 1 FROM epics WHERE id = 'epic-2'")).toBe(1);

    const [withSets] = await applier.apply(feed.replica, {
      mode: 'live',
      remoteId: 'remote-1',
      cursor: T,
      idSets: feed.idSets,
    });

    expect(withSets.deletedEpicIds).toEqual(['epic-2']);
    expect(count(host, "SELECT 1 FROM epics WHERE id = 'epic-2'")).toBe(0);
    expect(count(host, "SELECT 1 FROM epic_comments WHERE id = 'comment-1'")).toBe(0);
    expect(count(host, "SELECT 1 FROM epic_time_segments WHERE id = 'segment-settled'")).toBe(0);
    expect(count(host, "SELECT 1 FROM epics WHERE id = 'epic-1'")).toBe(1);
  });

  it('a home resnapshot ignores VM env and scope rows', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    const state = () => ({
      env: home.prepare('SELECT id, env FROM providers ORDER BY id').all(),
      scopes: home
        .prepare('SELECT * FROM provider_env_scopes ORDER BY provider_id, env_key, project_id')
        .all(),
    });
    const before = state();
    host.exec(`
      UPDATE providers SET env = json_set(env, '$.API_KEY', 'vm-rotated', '$.VM_ONLY', 'vm') WHERE name = 'claude';
      DELETE FROM provider_env_scopes;
    `);
    await homeApplier.apply(await build('attach', hostBuilder), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
      keepInstanceConfig: true,
    });
    expect(state()).toEqual(before);
  });

  it('leaves instance settings alone when asked to keep them', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    host.exec(`
      UPDATE settings SET value = 'true' WHERE key = 'messagePool.enabled';
      UPDATE settings SET value = '60000' WHERE key = 'activity.idleTimeoutMs';
      UPDATE settings SET value = '5000' WHERE key = 'terminal.scrollback.lines';
      UPDATE settings SET value = '131072' WHERE key = 'terminal.seeding.maxBytes';
      UPDATE settings SET value = 'tty' WHERE key = 'terminal.inputMode';
      UPDATE settings SET value = 'true' WHERE key = 'terminal.suppressCtrlCWithSelection';
      UPDATE settings SET value = 'true' WHERE key = 'skills.syncOnStartup';
      UPDATE settings SET value = 'true' WHERE key = 'messaging.followNote';
    `);
    const before = instanceSettingsRows(host);

    await applier.apply(await build('attach'), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
      keepInstanceConfig: true,
    });

    expect(instanceSettingsRows(host)).toEqual(before);
  });

  it('merges effective registered switches at Connect and keeps VM-only switches across reconnect', async () => {
    host
      .prepare(
        "INSERT INTO settings (id, key, value, created_at, updated_at) VALUES ('host-switches', 'skills.sources', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify({ microsoft: false, 'host-only': false }), T, T);
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    // The stored encodings match what the settings writers produce, so the
    // host's readers decode the same effective values home operates on.
    expect(instanceSettingsRows(host)).toEqual({
      ...instanceSettingsRows(home),
      'skills.sources': {
        ...builtInsOn,
        'host-only': false,
      },
    });

    home.exec(`
      UPDATE settings SET value = 'true' WHERE key = 'messagePool.enabled';
      UPDATE settings SET value = '25000' WHERE key = 'messagePool.delayMs';
      UPDATE settings SET value = '60000' WHERE key = 'activity.idleTimeoutMs';
      UPDATE settings SET value = '"[Edited] {agent_name}: {epic_title}"' WHERE key = 'events.epicAssigned.template';
      UPDATE settings SET value = '{"community": true, "team": false}' WHERE key = 'skills.sources';
      UPDATE settings SET value = '1200' WHERE key = 'terminal.scrollback.lines';
      UPDATE settings SET value = '131072' WHERE key = 'terminal.seeding.maxBytes';
      UPDATE settings SET value = 'tty' WHERE key = 'terminal.inputMode';
      UPDATE settings SET value = 'true' WHERE key = 'terminal.suppressCtrlCWithSelection';
      UPDATE settings SET value = 'true' WHERE key = 'skills.syncOnStartup';
      UPDATE settings SET value = 'true' WHERE key = 'messaging.followNote';
    `);

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(instanceSettingsRows(host)).toEqual({
      ...instanceSettingsRows(home),
      'skills.sources': {
        ...builtInsOn,
        'host-only': false,
      },
    });
    expect(instanceSettingsRows(host)).toMatchObject({
      'messagePool.enabled': true,
      'messagePool.delayMs': 25000,
      'activity.idleTimeoutMs': 60000,
      'events.epicAssigned.template': '[Edited] {agent_name}: {epic_title}',
      'skills.sources': { microsoft: true, 'host-only': false },
      'terminal.scrollback.lines': 1200,
      'terminal.seeding.maxBytes': 131072,
      'terminal.inputMode': 'tty',
      'terminal.suppressCtrlCWithSelection': true,
      'skills.syncOnStartup': true,
      'messaging.followNote': true,
    });
  });

  it('never writes instance settings on a detach apply', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    const before = instanceSettingsRows(home);

    const detach = await build('detach', hostBuilder);
    expect(detach.tables).not.toHaveProperty('instance_settings');
    await homeApplier.apply(detach, { mode: 'full', remoteId: 'remote-1', cursor: T });

    expect(instanceSettingsRows(home)).toEqual(before);
  });

  it('merges provider catalogs additively, case-insensitively and idempotently', async () => {
    hostSeed.insert('provider_models', {
      id: 'host-model-opus',
      provider_id: 'host-claude',
      name: 'Opus-4',
      position: 0,
      ...stamps,
    });
    hostSeed.insert('provider_models', {
      id: 'host-model-sonnet',
      provider_id: 'host-claude',
      name: 'SONNET-4',
      position: 1,
      ...stamps,
    });
    hostSeed.insert('provider_efforts', {
      id: 'host-effort-high',
      provider_id: 'host-claude',
      name: 'high',
      position: 0,
      ...stamps,
    });
    homeSeed.insert('provider_models', {
      id: 'model-sonnet',
      provider_id: 'prov-claude',
      name: 'sonnet-4',
      position: 0,
      ...stamps,
    });
    homeSeed.insert('provider_models', {
      id: 'model-haiku',
      provider_id: 'prov-claude',
      name: 'haiku-4',
      position: 1,
      ...stamps,
    });
    homeSeed.insert('provider_efforts', {
      id: 'effort-low',
      provider_id: 'prov-claude',
      name: 'low',
      position: 0,
      ...stamps,
    });
    hostSeed.insert('provider_efforts', {
      id: 'host-effort-low',
      provider_id: 'host-claude',
      name: 'LOW',
      position: 1,
      ...stamps,
    });
    home.exec(
      "UPDATE agents SET model_override = 'sonnet-4', effort_override = 'low' WHERE id = 'agent-1'",
    );

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    // A host case-variant wins the catalog row; the copied agent keeps its exact
    // launch strings, which the agent pickers match case-insensitively.
    expect(
      host.prepare("SELECT model_override, effort_override FROM agents WHERE id = 'agent-1'").get(),
    ).toEqual({ model_override: 'sonnet-4', effort_override: 'low' });

    const models = () =>
      host
        .prepare(
          `SELECT pm.name, pm.position FROM provider_models pm
           JOIN providers p ON p.id = pm.provider_id WHERE p.name = 'claude' ORDER BY pm.position`,
        )
        .all();
    const efforts = () =>
      host
        .prepare(
          `SELECT pe.name, pe.position FROM provider_efforts pe
           JOIN providers p ON p.id = pe.provider_id WHERE p.name = 'claude' ORDER BY pe.position`,
        )
        .all();
    // The host's rows and positions survive; the case-variant is not
    // duplicated; new rows append in source order.
    expect(models()).toEqual([
      { name: 'Opus-4', position: 0 },
      { name: 'SONNET-4', position: 1 },
      { name: 'haiku-4', position: 2 },
    ]);
    expect(efforts()).toEqual([
      { name: 'high', position: 0 },
      { name: 'LOW', position: 1 },
    ]);

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(models()).toEqual([
      { name: 'Opus-4', position: 0 },
      { name: 'SONNET-4', position: 1 },
      { name: 'haiku-4', position: 2 },
    ]);
    expect(efforts()).toEqual([
      { name: 'high', position: 0 },
      { name: 'LOW', position: 1 },
    ]);
  });

  it('overwrites provider scalars from home, including null, and skips an invalid launch JSON', async () => {
    host.exec("UPDATE providers SET auto_compact_threshold = 85 WHERE name = 'claude'");
    home.exec(
      `UPDATE providers SET auto_compact_threshold = 42, claude_launch_settings_json = '{"tui":"default"}' WHERE name = 'claude'`,
    );
    const scalars = () =>
      host
        .prepare(
          "SELECT auto_compact_threshold, claude_launch_settings_json FROM providers WHERE name = 'claude'",
        )
        .get() as {
        auto_compact_threshold: number | null;
        claude_launch_settings_json: string | null;
      };

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(scalars()).toEqual({
      auto_compact_threshold: 42,
      claude_launch_settings_json: '{"tui":"default"}',
    });

    // A home edit reaches the host at the next connect.
    home.exec("UPDATE providers SET auto_compact_threshold = 55 WHERE name = 'claude'");
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(scalars()?.auto_compact_threshold).toBe(55);

    // An explicit null travels too.
    home.exec("UPDATE providers SET auto_compact_threshold = NULL WHERE name = 'claude'");
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(scalars()?.auto_compact_threshold).toBeNull();

    // An invalid launch JSON is skipped with a warning; the threshold still lands.
    home.exec(
      `UPDATE providers SET auto_compact_threshold = 66, claude_launch_settings_json = '{not json' WHERE name = 'claude'`,
    );
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(scalars()).toEqual({
      auto_compact_threshold: 66,
      claude_launch_settings_json: '{"tui":"default"}',
    });
  });

  it("reconciles provider plugin defaults to exactly home's set for referenced providers", async () => {
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-claude',
      plugin_id: 'plugin-keep',
      enabled: 1,
      ...stamps,
    });
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-claude',
      plugin_id: 'plugin-flip',
      enabled: 0,
      ...stamps,
    });
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-claude',
      plugin_id: 'plugin-remove',
      enabled: 1,
      ...stamps,
    });
    // Referenced with no home rows: the whole host set clears.
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-codex',
      plugin_id: 'plugin-codex-host-only',
      enabled: 1,
      ...stamps,
    });
    // A provider outside the payload keeps its policy.
    hostSeed.insert('providers', {
      id: 'host-other',
      name: 'other',
      mcp_configured: 0,
      env: null,
      ...stamps,
    });
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-other',
      plugin_id: 'plugin-other',
      enabled: 1,
      ...stamps,
    });
    homeSeed.insert('provider_plugin_defaults', {
      provider_id: 'prov-claude',
      plugin_id: 'plugin-keep',
      enabled: 1,
      ...stamps,
    });
    homeSeed.insert('provider_plugin_defaults', {
      provider_id: 'prov-claude',
      plugin_id: 'plugin-flip',
      enabled: 1,
      ...stamps,
    });

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(
      host
        .prepare(
          `SELECT p.name AS provider, d.plugin_id, d.enabled FROM provider_plugin_defaults d
           JOIN providers p ON p.id = d.provider_id ORDER BY p.name, d.plugin_id`,
        )
        .all(),
    ).toEqual([
      { provider: 'claude', plugin_id: 'plugin-flip', enabled: 1 },
      { provider: 'claude', plugin_id: 'plugin-keep', enabled: 1 },
      { provider: 'other', plugin_id: 'plugin-other', enabled: 1 },
    ]);
  });

  it('round-trips project plugin overrides, including a reset to inherit', async () => {
    homeSeed.insert('project_provider_plugin_overrides', {
      project_id: 'A',
      provider_id: 'prov-claude',
      plugin_id: 'plugin-x',
      enabled: 1,
      ...stamps,
    });

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(
      host
        .prepare(
          'SELECT project_id, provider_id, plugin_id, enabled FROM project_provider_plugin_overrides',
        )
        .all(),
    ).toEqual([{ project_id: 'A', provider_id: 'host-claude', plugin_id: 'plugin-x', enabled: 1 }]);

    // On the VM the user resets plugin-x to inherit and disables another plugin.
    host
      .prepare('DELETE FROM project_provider_plugin_overrides WHERE plugin_id = ?')
      .run('plugin-x');
    hostSeed.insert('project_provider_plugin_overrides', {
      project_id: 'A',
      provider_id: 'host-codex',
      plugin_id: 'plugin-y',
      enabled: 0,
      ...stamps,
    });

    await homeApplier.apply(await build('detach', hostBuilder), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(
      home
        .prepare(
          'SELECT project_id, provider_id, plugin_id, enabled FROM project_provider_plugin_overrides',
        )
        .all(),
    ).toEqual([{ project_id: 'A', provider_id: 'prov-codex', plugin_id: 'plugin-y', enabled: 0 }]);
  });

  it("leaves home's threshold, catalogs and plugin defaults untouched on a resnapshot", async () => {
    homeSeed.insert('provider_models', {
      id: 'model-home',
      provider_id: 'prov-claude',
      name: 'home-model',
      position: 0,
      ...stamps,
    });
    home.exec("UPDATE providers SET auto_compact_threshold = 42 WHERE name = 'claude'");
    homeSeed.insert('provider_plugin_defaults', {
      provider_id: 'prov-claude',
      plugin_id: 'plugin-home',
      enabled: 1,
      ...stamps,
    });
    const homeInstance = () => ({
      threshold: home
        .prepare("SELECT auto_compact_threshold FROM providers WHERE name = 'claude'")
        .get() as { auto_compact_threshold: number | null },
      models: home.prepare('SELECT name, position FROM provider_models ORDER BY position').all(),
      defaults: home
        .prepare('SELECT plugin_id, enabled FROM provider_plugin_defaults ORDER BY plugin_id')
        .all(),
    });

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    // The VM edits its own instance config after the connect.
    host.exec(`
      UPDATE providers SET auto_compact_threshold = 99 WHERE name = 'claude';
      UPDATE epics SET title = 'Host edited' WHERE id = 'epic-1';
    `);
    hostSeed.insert('provider_models', {
      id: 'host-model-extra',
      provider_id: 'host-claude',
      name: 'host-extra-model',
      position: 5,
      ...stamps,
    });
    hostSeed.insert('provider_plugin_defaults', {
      provider_id: 'host-claude',
      plugin_id: 'plugin-host',
      enabled: 1,
      ...stamps,
    });
    const before = homeInstance();

    await homeApplier.apply(await build('attach', hostBuilder), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
      keepInstanceConfig: true,
    });

    // The project data arrived; home's instance config did not move.
    expect(home.prepare("SELECT title FROM epics WHERE id = 'epic-1'").get()).toEqual({
      title: 'Host edited',
    });
    expect(homeInstance()).toEqual(before);
    expect(before.models.length).toBe(1);
    expect(before.threshold.auto_compact_threshold).toBe(42);
  });

  it('refuses a missing referenced provider leaving no catalog or policy writes', async () => {
    homeSeed.insert('provider_models', {
      id: 'model-sonnet',
      provider_id: 'prov-claude',
      name: 'sonnet-4',
      position: 0,
      ...stamps,
    });
    homeSeed.insert('provider_plugin_defaults', {
      provider_id: 'prov-claude',
      plugin_id: 'plugin-a',
      enabled: 1,
      ...stamps,
    });
    homeSeed.insert('project_provider_plugin_overrides', {
      project_id: 'A',
      provider_id: 'prov-claude',
      plugin_id: 'plugin-b',
      enabled: 1,
      ...stamps,
    });
    host.exec("DELETE FROM providers WHERE id = 'host-codex'");

    await expect(
      applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null }),
    ).rejects.toMatchObject({ table: 'providers', rowId: 'prov-codex' });
    expect(count(host, 'SELECT 1 FROM projects')).toBe(0);
    expect(count(host, 'SELECT 1 FROM provider_models')).toBe(0);
    expect(count(host, 'SELECT 1 FROM provider_efforts')).toBe(0);
    expect(count(host, 'SELECT 1 FROM provider_plugin_defaults')).toBe(0);
    expect(count(host, 'SELECT 1 FROM project_provider_plugin_overrides')).toBe(0);
  });

  it('a re-import matches home for the connecting project and projects outside the replica', async () => {
    hostSeed.seedProject('C');
    hostSeed.seedProject('D');
    homeSeed.seedProject('D');
    host.exec("UPDATE projects SET frozen_at = '2026-09-28T00:00:00.000Z' WHERE id = 'C'");
    home.exec(`
      UPDATE providers SET env = json_set(env,
        '$.SCOPED_TO_GLOBAL', 'sg', '$.GLOBAL_TO_SCOPED', 'gs',
        '$.ABSENT', 'absent', '$.CLAUDE_CODE_OAUTH_TOKEN', 'literal-login') WHERE name = 'claude';
      INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES
        ('prov-claude', 'SCOPED_TO_GLOBAL', 'A', '${T}'),
        ('prov-claude', 'SCOPED_TO_GLOBAL', 'C', '${T}'),
        ('prov-claude', 'ABSENT', 'B', '${T}');
    `);
    const assertMatchesHome = () => {
      for (const projectId of ['A', 'C', 'D']) {
        for (const name of ['claude', 'codex']) {
          expect(hostStorage.getProviderEnvForProject(`host-${name}`, projectId)).toEqual(
            homeStorage.getProviderEnvForProject(`prov-${name}`, projectId),
          );
        }
      }
    };
    const scopes = () =>
      host
        .prepare(
          'SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ? ORDER BY env_key, project_id',
        )
        .all('host-claude');
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    assertMatchesHome();
    expect(scopes()).toEqual([
      { env_key: 'API_KEY', project_id: 'A' },
      { env_key: 'SCOPED_TO_GLOBAL', project_id: 'A' },
      { env_key: 'SCOPED_TO_GLOBAL', project_id: 'C' },
    ]);
    expect(hostStorage.getProviderEnvForProject('host-claude', 'A')).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'literal-login',
      GLOBAL_TO_SCOPED: 'gs',
      UNSCOPED: 'x',
    });
    host.exec(`
      UPDATE providers SET env = json_set(env, '$.VM_ONLY', 'vm', '$.VM_SCOPED', 'vm') WHERE name = 'claude';
      INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES
        ('host-claude', 'VM_SCOPED', 'D', '${T}');
    `);
    home.exec(`
      DELETE FROM provider_env_scopes WHERE env_key = 'SCOPED_TO_GLOBAL';
      INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES
        ('prov-claude', 'GLOBAL_TO_SCOPED', 'C', '${T}'),
        ('prov-claude', 'GLOBAL_TO_SCOPED', 'B', '${T}');
      UPDATE providers SET env = json_set(env, '$.API_KEY', 'rotated') WHERE name = 'claude';
    `);
    const replica = await build('attach');
    expect(replica.tables.projects.map((row) => row.id)).toEqual(['A']);
    await applier.apply(replica, { mode: 'full', remoteId: null, cursor: null });
    assertMatchesHome();
    expect(scopes()).toEqual([
      { env_key: 'API_KEY', project_id: 'A' },
      { env_key: 'GLOBAL_TO_SCOPED', project_id: 'C' },
    ]);
    const stored = host.prepare("SELECT env FROM providers WHERE name = 'claude'").get() as {
      env: string;
    };
    expect(Object.keys(JSON.parse(stored.env)).sort()).toEqual([
      'API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GLOBAL_TO_SCOPED',
      'SCOPED_TO_GLOBAL',
      'UNSCOPED',
    ]);
  });

  it.each([null, '{}'])('clears VM env and scopes when home env is %s', async (env) => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    home.prepare("UPDATE providers SET env = ? WHERE name = 'claude'").run(env);
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(host.prepare("SELECT env FROM providers WHERE name = 'claude'").get()).toEqual({
      env: null,
    });
    expect(host.prepare('SELECT * FROM provider_env_scopes').all()).toEqual([]);
  });

  it('overwrites malformed VM env and leaves unrelated provider env and scopes alone', async () => {
    hostSeed.seedProject('D');
    hostSeed.insert('providers', {
      id: 'unrelated',
      name: 'unrelated',
      env: '{"LOCAL":"keep"}',
      ...stamps,
    });
    hostSeed.insert('provider_env_scopes', {
      provider_id: 'unrelated',
      env_key: 'LOCAL',
      project_id: 'D',
      created_at: T,
    });
    host.exec("UPDATE providers SET env = 'malformed' WHERE name = 'claude'");
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(hostStorage.getProviderEnvForProject('host-claude', 'A')).toEqual(
      homeStorage.getProviderEnvForProject('prov-claude', 'A'),
    );
    expect(hostStorage.getProviderEnvForProject('unrelated', 'D')).toEqual({ LOCAL: 'keep' });
    expect(hostStorage.getProviderEnvForProject('unrelated', 'A')).toBeNull();
  });

  it('rolls back the scope cleanup and the env drop together when a later apply write fails', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    const hostEnvKeys = () =>
      Object.keys(
        JSON.parse(
          (
            host.prepare("SELECT env FROM providers WHERE id = 'host-claude'").get() as {
              env: string;
            }
          ).env,
        ),
      ).sort();
    const hostScopes = () =>
      host.prepare('SELECT env_key, project_id FROM provider_env_scopes').all();
    expect(hostEnvKeys()).toEqual(['API_KEY', 'UNSCOPED']);

    home.exec(`
      UPDATE providers SET env = NULL WHERE name = 'claude';
      DELETE FROM provider_env_scopes WHERE env_key = 'API_KEY';
    `);
    const replica = await build('attach');
    replica.tables.epics.push({
      ...replica.tables.epics[0],
      id: 'epic-env-rollback',
      status_id: 'no-such',
    });

    await expect(
      applier.apply(replica, { mode: 'full', remoteId: 'remote-1', cursor: T }),
    ).rejects.toBeInstanceOf(ReplicaApplyError);

    expect(hostEnvKeys()).toEqual(['API_KEY', 'UNSCOPED']);
    expect(hostScopes()).toEqual([{ env_key: 'API_KEY', project_id: 'A' }]);
  });

  it('rolls back everything and names the failing row when a write fails', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    const before = snapshot(host);
    const eventCount = syncedEvents(host).length;
    const replica = await build('live');
    replica.tables.statuses = replica.tables.statuses.map((status) => ({
      ...status,
      label: 'Changed first',
    }));
    replica.tables.epics.push({ ...replica.tables.epics[0], id: 'epic-bad', status_id: 'no-such' });

    const failure = applier.apply(replica, { mode: 'live', remoteId: 'remote-1', cursor: T });

    await expect(failure).rejects.toBeInstanceOf(ReplicaApplyError);
    await expect(failure).rejects.toMatchObject({ table: 'epics', rowId: 'epic-bad' });
    expect(snapshot(host)).toEqual(before);
    expect(syncedEvents(host)).toHaveLength(eventCount);
    expect(emitted).toHaveLength(1);
  });

  it('rolls back grant additions and revocations when later project data fails', async () => {
    hostSeed.insert('paired_device_workspace_grants', {
      device_kid: 'remove',
      workspace_id: WORKSPACE_ID,
    });
    const before = snapshot(host);
    const replica = await build('attach');
    replica.tables.authorityKids = ['remove', 'add'];
    replica.tables.paired_device_workspace_grants = [
      { device_kid: 'add', workspace_id: WORKSPACE_ID },
    ];
    replica.tables.epics.push({
      ...replica.tables.epics[0],
      id: 'bad-grant-apply',
      status_id: 'missing',
    });
    await expect(
      applier.apply(replica, { mode: 'full', remoteId: null, cursor: null }),
    ).rejects.toBeInstanceOf(ReplicaApplyError);
    expect(snapshot(host)).toEqual(before);
  });

  it('commits the payload project frozen when given frozenAt, and leaves frozen_at alone otherwise', async () => {
    const frozenAt = '2026-09-22T12:00:00.000Z';

    await applier.apply(await build('attach'), {
      mode: 'full',
      remoteId: null,
      cursor: frozenAt,
      frozenAt,
    });
    expect(host.prepare("SELECT frozen_at FROM projects WHERE id = 'A'").get()).toEqual({
      frozen_at: frozenAt,
    });

    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    expect(host.prepare("SELECT frozen_at FROM projects WHERE id = 'A'").get()).toEqual({
      frozen_at: frozenAt,
    });
  });

  it('rejects a payload whose provider is not installed on this instance', async () => {
    host.exec("DELETE FROM providers WHERE id = 'host-codex'");

    await expect(
      applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null }),
    ).rejects.toMatchObject({ table: 'providers', rowId: 'prov-codex' });
    expect(count(host, 'SELECT 1 FROM projects')).toBe(0);
  });

  it('rejects a workspace whose name another workspace already uses', async () => {
    home.exec(`
      INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
      VALUES ('workspace-home', 'Team', 0, 1, '${T}', '${T}');
      UPDATE projects SET workspace_id = 'workspace-home' WHERE id IN ('A', 'B', 'C');
    `);
    host.exec(`
      INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
      VALUES ('workspace-host', 'team', 0, 1, '${T}', '${T}');
    `);

    await expect(
      applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null }),
    ).rejects.toMatchObject({ table: 'project_workspaces', rowId: 'workspace-home' });
  });

  it('drops a cross-project epic link at connect and restores it at home on disconnect', async () => {
    home.exec(`UPDATE sessions SET epic_id = 'epic-b' WHERE id = 'session-1'`);
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });

    expect(host.prepare('SELECT id, agent_id, epic_id FROM sessions').all()).toEqual([
      { id: 'session-1', agent_id: 'agent-1', epic_id: null },
    ]);
    expect(
      count(host, "SELECT 1 FROM epic_time_session_watermarks WHERE session_id = 'session-1'"),
    ).toBe(1);

    await homeApplier.apply(await build('detach', hostBuilder), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(home.prepare('SELECT epic_id FROM sessions WHERE id = ?').get('session-1')).toEqual({
      epic_id: 'epic-b',
    });
  });

  it('lets a disconnect clear a session epic that lives inside the project', async () => {
    await applier.apply(await build('attach'), { mode: 'full', remoteId: null, cursor: null });
    host.exec(`UPDATE sessions SET epic_id = NULL WHERE id = 'session-1'`);

    await homeApplier.apply(await build('detach', hostBuilder), {
      mode: 'full',
      remoteId: 'remote-1',
      cursor: T,
    });

    expect(home.prepare('SELECT epic_id FROM sessions WHERE id = ?').get('session-1')).toEqual({
      epic_id: null,
    });
  });
});
