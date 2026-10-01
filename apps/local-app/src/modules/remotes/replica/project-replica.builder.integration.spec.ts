import { BUILT_IN_SKILL_SOURCE_NAMES } from '../../../common/constants/built-in-skill-sources';
/**
 * ProjectReplicaBuilder over a migrated in-memory SQLite database.
 * Test layer: storage integration. The builder's contract is the exact rows it
 * reads in one transaction (joins, settled-segment filter, global-row
 * inclusion), which only a real migrated schema exercises.
 */
import type Database from 'better-sqlite3';
import { ProjectReplicaV1Schema } from '@devchain/shared';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { ProjectReplicaBuilder } from './project-replica.builder';
import {
  INSTANCE_SETTING_KEYS,
  T,
  WORKSPACE_ID,
  createReplicaDb,
  ensureProvider,
  replicaSeeder,
  seedReplicaSource,
  stamps,
} from './__fixtures__/replica-seed';

const builtInsOn = Object.fromEntries(
  Object.values(BUILT_IN_SKILL_SOURCE_NAMES).map((name) => [name, true]),
);

describe('ProjectReplicaBuilder (integration)', () => {
  let sqlite: Database.Database;
  let builder: ProjectReplicaBuilder;
  let seed: ReturnType<typeof replicaSeeder>;

  beforeEach(() => {
    const created = createReplicaDb();
    sqlite = created.sqlite;
    builder = new ProjectReplicaBuilder(new LocalStorageService(created.db));
    seedReplicaSource(sqlite);
    sqlite
      .prepare(
        'INSERT INTO community_skill_sources (id, name, repo_owner, repo_name, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('community-source', 'community', 'owner', 'repo', 'main', T, T);
    sqlite
      .prepare(
        'INSERT INTO local_skill_sources (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('local-source', 'team', '/home/team', T, T);
    seed = replicaSeeder(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();

  it('carries only the attached workspace grants and retained device authority, never on detach/live', async () => {
    seed.insert('project_workspaces', {
      id: 'other-workspace',
      name: 'Other',
      is_default: 0,
      position: 1,
      ...stamps,
    });
    seed.insert('settings', {
      id: 'paired',
      key: 'cloud.e2ee.devices',
      value: JSON.stringify({ v: 1, devices: { phone: { kid: 'phone' } } }),
      ...stamps,
    });
    seed.insert('settings', {
      id: 'revoked',
      key: 'cloud.e2ee.revokedDeviceKids',
      value: JSON.stringify(['revoked-phone']),
      ...stamps,
    });
    for (const [device_kid, workspace_id] of [
      ['phone', WORKSPACE_ID],
      ['phone', 'other-workspace'],
      ['unknown', WORKSPACE_ID],
    ]) {
      seed.insert('paired_device_workspace_grants', { device_kid, workspace_id });
    }
    const attached = await builder.build({ projectIds: ['A'], scope: 'attach' });
    if (!attached.ok) throw new Error(JSON.stringify(attached.errors));
    expect(attached.replica.tables.paired_device_workspace_grants).toEqual([
      { device_kid: 'phone', workspace_id: WORKSPACE_ID },
    ]);
    expect(attached.replica.tables.authorityKids).toEqual(['phone', 'revoked-phone']);
    for (const scope of ['live', 'detach'] as const) {
      const result = await builder.build({ projectIds: ['A'], scope });
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      expect(result.replica.tables).not.toHaveProperty('paired_device_workspace_grants');
      expect(result.replica.tables).not.toHaveProperty('authorityKids');
    }
  });

  it('builds an attach replica with every table, preserved IDs and referenced global rows', async () => {
    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { replica } = result;
    const { tables } = replica;
    expect(replica).toMatchObject({
      version: 1,
      scope: 'attach',
      workspace: { id: WORKSPACE_ID, name: 'Default' },
    });
    expect(ids(tables.projects)).toEqual(['A']);
    expect(tables.projects[0].root_path).toBe('/tmp/A');
    expect(ids(tables.statuses)).toEqual(['A-status']);
    expect(ids(tables.agent_profiles)).toEqual(['profile-a', 'profile-global']);
    expect(ids(tables.profile_provider_configs)).toEqual([
      'profile-a-config',
      'profile-global-config',
    ]);
    expect(tables.providers).toEqual([
      { id: 'prov-claude', name: 'claude' },
      { id: 'prov-codex', name: 'codex' },
    ]);
    expect(ids(tables.agents)).toEqual(['agent-1', 'agent-2']);
    expect(ids(tables.prompts)).toEqual(['prompt-a', 'prompt-global']);
    expect(tables.agent_profile_prompts).toHaveLength(2);
    expect(ids(tables.tags)).toEqual(['tag-a', 'tag-global']);
    expect(tables.prompt_tags).toHaveLength(2);
    expect(ids(tables.teams)).toEqual(['team-1']);
    expect(tables.team_members).toEqual([
      { team_id: 'team-1', agent_id: 'agent-1', created_at: T },
    ]);
    expect(tables.team_profiles).toHaveLength(1);
    expect(tables.team_profile_configs).toHaveLength(1);
    expect(ids(tables.terminal_watchers)).toEqual(['watcher-1']);
    expect(ids(tables.automation_subscribers)).toEqual(['subscriber-1']);
    expect(ids(tables.scheduled_epics)).toEqual(['schedule-1']);
    expect(ids(tables.epics)).toEqual(['epic-1', 'epic-2']);
    expect(tables.epics.find((epic) => epic.id === 'epic-2')?.parent_id).toBe('epic-1');
    expect(tables.epic_tags).toEqual([{ epic_id: 'epic-1', tag_name: 'Phase:1', created_at: T }]);
    expect(ids(tables.epic_comments)).toEqual(['comment-1']);
    expect(ids(tables.reviews)).toEqual(['review-1']);
    expect(ids(tables.review_comments)).toEqual(['review-comment-1']);
    expect(ids(tables.epic_time_segments)).toEqual(['segment-settled']);
    expect(ids(tables.sessions)).toEqual(['session-1']);
    expect(tables.epic_time_session_watermarks).toEqual([
      { session_id: 'session-1', project_id: 'A', last_activity_at: T, ...stamps },
    ]);
    expect(tables.provider_settings.find((row) => row.providerName === 'claude')).toMatchObject({
      env: { API_KEY: 'secret-a', UNSCOPED: 'x' },
      envScopes: { API_KEY: ['A', 'B'] },
    });
    expect(tables).not.toHaveProperty('provider_env_scopes');
    expect(tables.project_settings).toEqual([
      { project_id: 'A', key: 'autoClean.statusIds', value: ['A-status'] },
      { project_id: 'A', key: 'projectPresets', value: [{ name: 'Fast', agentConfigs: [] }] },
    ]);
    expect(tables.instance_settings).toEqual({
      messagePool: {
        enabled: false,
        delayMs: 15000,
        maxWaitMs: 45000,
        maxMessages: 4,
        separator: '\n==\n',
      },
      eventsEpicAssignedTemplate: '[Home] {epic_title} -> {agent_name}',
      skillsSources: {
        ...builtInsOn,
        team: true,
        community: false,
      },
      activityIdleTimeoutMs: 45000,
      terminal: {
        inputMode: 'form',
        scrollbackLines: 20000,
        seedingMaxBytes: 2 * 1024 * 1024,
        suppressCtrlCWithSelection: false,
      },
      skillsSyncOnStartup: false,
      messagingFollowNote: false,
    });
  });

  it('resolves unset instance settings to the effective defaults on attach', async () => {
    sqlite
      .prepare(
        `DELETE FROM settings WHERE key IN (${INSTANCE_SETTING_KEYS.map(() => '?').join(', ')})`,
      )
      .run(...INSTANCE_SETTING_KEYS);

    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.replica.tables.instance_settings).toEqual({
      messagePool: {
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      },
      eventsEpicAssignedTemplate:
        '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. Status: {epic_status}. (Epic ID: {epic_id})',
      skillsSources: {
        ...builtInsOn,
        team: true,
        community: true,
      },
      activityIdleTimeoutMs: 30000,
      terminal: {
        inputMode: 'tty',
        scrollbackLines: 10000,
        seedingMaxBytes: 1024 * 1024,
        suppressCtrlCWithSelection: true,
      },
      skillsSyncOnStartup: true,
      messagingFollowNote: true,
    });
  });

  it('exports the built-in devchain source as enabled despite a legacy stored "off"', async () => {
    sqlite
      .prepare("UPDATE settings SET value = ? WHERE key = 'skills.sources'")
      .run(JSON.stringify({ devchain: false, community: false }));

    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.replica.tables.instance_settings?.skillsSources).toMatchObject({
      devchain: true,
      community: false,
    });
  });

  it('clamps out-of-range message pool numbers to the settings bounds', async () => {
    sqlite.exec(`
      UPDATE settings SET value = '10' WHERE key = 'messagePool.delayMs';
      UPDATE settings SET value = '999999' WHERE key = 'messagePool.maxWaitMs';
      UPDATE settings SET value = '-5' WHERE key = 'messagePool.maxMessages';
      UPDATE settings SET value = '5' WHERE key = 'terminal.scrollback.lines';
      UPDATE settings SET value = '999999999' WHERE key = 'terminal.seeding.maxBytes';
    `);

    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.replica.tables.instance_settings.messagePool).toMatchObject({
      delayMs: 1000,
      maxWaitMs: 120000,
      // A non-positive stored value is not admitted by the settings readers,
      // so the effective value is the default, not the clamp minimum.
      maxMessages: 10,
    });
    expect(result.replica.tables.instance_settings.terminal).toMatchObject({
      scrollbackLines: 100,
      seedingMaxBytes: 4 * 1024 * 1024,
    });
  });

  it('carries instance settings on attach only, never on detach or live', async () => {
    const detach = await builder.build({ projectIds: ['A'], scope: 'detach' });
    const live = await builder.build({ projectIds: ['A'], scope: 'live' });

    if (!detach.ok || !live.ok) throw new Error('expected both builds to succeed');
    expect(detach.replica.tables).not.toHaveProperty('instance_settings');
    expect(live.replica.tables).not.toHaveProperty('instance_settings');
  });

  it('round-trips through JSON and the schema, and the schema rejects another version', async () => {
    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const wire: unknown = JSON.parse(JSON.stringify(result.replica));
    expect(ProjectReplicaV1Schema.parse(wire)).toEqual(result.replica);
    expect(ProjectReplicaV1Schema.safeParse({ ...result.replica, version: 2 }).success).toBe(false);
  });

  it('includes sessions and watermarks on detach and keeps provider env values home', async () => {
    const result = await builder.build({ projectIds: ['A'], scope: 'detach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tables } = result.replica;
    expect(ids(tables.sessions)).toEqual(['session-1']);
    expect(tables.epic_time_session_watermarks).toEqual([
      { session_id: 'session-1', project_id: 'A', last_activity_at: T, ...stamps },
    ]);
    expect(ids(tables.prompts)).toEqual(['prompt-a', 'prompt-global']);
    expect(tables).not.toHaveProperty('provider_env_scopes');
  });

  it('represents disabled skills by slug and source switches by name on attach and detach', async () => {
    seed.seedSkill('skill-home', 'team/disabled-skill');
    seed.seedSkill('skill-unrelated', 'other/available');
    seed.insert('skill_project_disabled', {
      id: 'disabled-home',
      project_id: 'A',
      skill_id: 'skill-home',
      created_at: T,
    });
    seed.insert('source_project_enabled', {
      id: 'source-home',
      project_id: 'A',
      source_name: 'team',
      enabled: 0,
      created_at: T,
    });

    const attached = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!attached.ok) throw new Error(JSON.stringify(attached.errors));
    expect(attached.replica.tables.skill_project_disabled).toEqual([
      {
        id: 'disabled-home',
        project_id: 'A',
        skill_slug: 'team/disabled-skill',
        created_at: T,
      },
    ]);
    expect(attached.replica.tables.sender_skill_slugs).toEqual([
      'other/available',
      'team/disabled-skill',
    ]);
    expect(attached.replica.tables.source_project_enabled).toEqual([
      {
        id: 'source-home',
        project_id: 'A',
        source_name: 'team',
        enabled: 0,
        created_at: T,
      },
    ]);

    sqlite.prepare('DELETE FROM skill_project_disabled WHERE id = ?').run('disabled-home');
    sqlite.prepare('UPDATE source_project_enabled SET enabled = 1 WHERE id = ?').run('source-home');
    const detached = await builder.build({ projectIds: ['A'], scope: 'detach' });

    if (!detached.ok) throw new Error(JSON.stringify(detached.errors));
    expect(detached.replica.tables.skill_project_disabled).toEqual([]);
    expect(detached.replica.tables.sender_skill_slugs).toEqual([
      'other/available',
      'team/disabled-skill',
    ]);
    expect(detached.replica.tables.source_project_enabled).toEqual([
      {
        id: 'source-home',
        project_id: 'A',
        source_name: 'team',
        enabled: 1,
        created_at: T,
      },
    ]);
  });

  it('gives every detach session a watermark at or after its last activity', async () => {
    const later = '2026-09-22T11:00:00.000Z';
    sqlite.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = 'session-1'`).run(later);
    for (const [id, lastActivityAt] of [
      ['session-unwatermarked', later],
      ['session-idle', null],
    ]) {
      seed.insert('sessions', {
        id,
        agent_id: 'agent-2',
        status: 'stopped',
        started_at: T,
        last_activity_at: lastActivityAt,
        ...stamps,
      });
    }

    const result = await builder.build({ projectIds: ['A'], scope: 'detach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const readAt = result.replica.generatedAt;
    expect(result.replica.tables.epic_time_session_watermarks).toEqual([
      {
        session_id: 'session-1',
        project_id: 'A',
        last_activity_at: later,
        created_at: T,
        updated_at: readAt,
      },
      {
        session_id: 'session-unwatermarked',
        project_id: 'A',
        last_activity_at: later,
        created_at: readAt,
        updated_at: readAt,
      },
    ]);
  });

  it('carries only the live-tier tables on live', async () => {
    const result = await builder.build({ projectIds: ['A'], scope: 'live' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tables } = result.replica;
    expect(Object.keys(tables).sort()).toEqual(
      [
        'agent_profiles',
        'agents',
        'epic_comments',
        'epic_relations',
        'epic_tags',
        'epic_time_segments',
        'epics',
        'profile_provider_configs',
        'projects',
        'providers',
        'statuses',
        'tags',
      ].sort(),
    );
    expect(ids(tables.tags)).toEqual(['tag-a']);
    expect(ids(tables.epic_time_segments)).toEqual(['segment-settled']);
    expect(ids(tables.agent_profiles)).toEqual(['profile-a', 'profile-global']);
  });

  it('limits a live build to epics whose row or a comment changed, keeping small tables whole', async () => {
    const later = '2026-09-22T12:00:00.000Z';
    seed.insert('epic_comments', {
      id: 'comment-late',
      epic_id: 'epic-2',
      author_name: 'Coder',
      content: 'Later',
      created_at: later,
      updated_at: later,
    });
    sqlite
      .prepare("UPDATE epic_time_segments SET updated_at = ? WHERE id = 'segment-settled'")
      .run(later);

    const result = await builder.build({
      projectIds: ['A'],
      scope: 'live',
      changedSince: '2026-09-22T11:00:00.000Z',
      includeIdSets: true,
    });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tables } = result.replica;
    expect(ids(tables.epics)).toEqual(['epic-2']);
    expect(ids(tables.epic_comments)).toEqual(['comment-late']);
    expect(tables.epic_tags).toEqual([]);
    expect(ids(tables.epic_time_segments)).toEqual(['segment-settled']);
    expect(ids(tables.statuses)).toEqual(['A-status']);
    expect(ids(tables.agents)).toEqual(['agent-1', 'agent-2']);
    expect(result.idSets).toEqual({
      epics: ['epic-1', 'epic-2'],
      epic_comments: ['comment-1', 'comment-late'],
      epic_relations: ['relation-internal'],
      epic_time_segments: ['segment-settled'],
    });
    expect(Date.parse(result.replica.generatedAt)).not.toBeNaN();
  });

  it('excludes relations to another project unless that project is in the request', async () => {
    const single = await builder.build({ projectIds: ['A'], scope: 'live' });
    const both = await builder.build({ projectIds: ['A', 'B'], scope: 'live' });

    if (!single.ok || !both.ok) throw new Error('expected both builds to succeed');
    expect(ids(single.replica.tables.epic_relations)).toEqual(['relation-internal']);
    expect(single.excludedRelationCount).toBe(1);
    expect(ids(both.replica.tables.epic_relations)).toEqual([
      'relation-cross',
      'relation-internal',
    ]);
    expect(both.excludedRelationCount).toBe(0);
    expect(ids(both.replica.tables.projects)).toEqual(['A', 'B']);
  });

  it('carries provider instance tables for referenced providers only, with configured names synthesized', async () => {
    seed.insert('provider_models', {
      id: 'model-sonnet',
      provider_id: 'prov-claude',
      name: 'sonnet-4',
      position: 0,
      ...stamps,
    });
    seed.insert('provider_models', {
      id: 'model-opus',
      provider_id: 'prov-claude',
      name: 'opus-4',
      position: 1,
      ...stamps,
    });
    seed.insert('provider_models', {
      id: 'model-codex',
      provider_id: 'prov-codex',
      name: 'gpt-5',
      position: 0,
      ...stamps,
    });
    seed.insert('provider_efforts', {
      id: 'effort-claude',
      provider_id: 'prov-claude',
      name: 'high',
      position: 0,
      ...stamps,
    });
    sqlite.exec(`
      UPDATE providers SET auto_compact_threshold = 42, claude_launch_settings_json = '{"tui":"default"}'
        WHERE name = 'claude';
      UPDATE agents SET model_override = 'mystery-model' WHERE id = 'agent-1';
      UPDATE profile_provider_configs SET effort = 'custom-effort' WHERE id = 'profile-global-config';
    `);
    seed.insert('provider_plugin_defaults', {
      provider_id: 'prov-claude',
      plugin_id: 'plugin-a',
      enabled: 1,
      ...stamps,
    });
    seed.insert('project_provider_plugin_overrides', {
      project_id: 'A',
      provider_id: 'prov-codex',
      plugin_id: 'plugin-b',
      enabled: 0,
      ...stamps,
    });
    // A provider nothing references: its catalog must stay home.
    ensureProvider(sqlite, 'prov-unref', 'unref', null);
    seed.insert('provider_models', {
      id: 'model-unref',
      provider_id: 'prov-unref',
      name: 'unref-model',
      position: 0,
      ...stamps,
    });

    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tables, generatedAt } = result.replica;
    expect(tables.providers.map((provider) => provider.name).sort()).toEqual(['claude', 'codex']);
    expect(tables.provider_settings).toEqual([
      {
        providerName: 'claude',
        env: { API_KEY: 'secret-a', UNSCOPED: 'x' },
        envScopes: { API_KEY: ['A', 'B'] },
        auto_compact_threshold: 42,
        claude_launch_settings_json: '{"tui":"default"}',
      },
      {
        providerName: 'codex',
        env: null,
        envScopes: {},
        auto_compact_threshold: null,
        claude_launch_settings_json: null,
      },
    ]);
    expect(tables.provider_models).toEqual([
      { providerName: 'claude', name: 'sonnet-4', created_at: T },
      { providerName: 'claude', name: 'opus-4', created_at: T },
      { providerName: 'codex', name: 'gpt-5', created_at: T },
      // Configured by agent-1 but absent from home's own catalog.
      { providerName: 'claude', name: 'mystery-model', created_at: generatedAt },
    ]);
    expect(tables.provider_efforts).toEqual([
      { providerName: 'claude', name: 'high', created_at: T },
      // Configured on the codex profile config, missing from the codex catalog.
      { providerName: 'codex', name: 'custom-effort', created_at: generatedAt },
    ]);
    expect(tables.provider_plugin_defaults).toEqual([
      { providerName: 'claude', plugin_id: 'plugin-a', enabled: 1, created_at: T, updated_at: T },
    ]);
    expect(tables.project_provider_plugin_overrides).toEqual([
      { project_id: 'A', provider_id: 'prov-codex', plugin_id: 'plugin-b', enabled: 0, ...stamps },
    ]);
  });

  it('carries settings and catalogs for a provider referenced only by a scoped key', async () => {
    ensureProvider(sqlite, 'scope-only', 'scope-only', { TOKEN: 'value', GLOBAL: 'global' });
    ensureProvider(sqlite, 'unrelated', 'unrelated', { OTHER: 'other' });
    for (const projectId of ['A', 'B']) {
      seed.insert('provider_env_scopes', {
        provider_id: 'scope-only',
        env_key: 'TOKEN',
        project_id: projectId,
        created_at: T,
      });
    }
    seed.insert('provider_env_scopes', {
      provider_id: 'unrelated',
      env_key: 'OTHER',
      project_id: 'B',
      created_at: T,
    });
    for (const table of ['provider_models', 'provider_efforts']) {
      seed.insert(table, {
        id: table,
        provider_id: 'scope-only',
        name: 'custom',
        position: 0,
        ...stamps,
      });
    }
    const result = await builder.build({ projectIds: ['A'], scope: 'attach' });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tables } = result.replica;
    expect(tables.providers.map((row) => row.name)).toContain('scope-only');
    expect(tables.providers.map((row) => row.name)).not.toContain('unrelated');
    expect(tables.provider_settings.find((row) => row.providerName === 'scope-only')).toEqual({
      providerName: 'scope-only',
      env: { TOKEN: 'value', GLOBAL: 'global' },
      envScopes: { TOKEN: ['A', 'B'] },
      auto_compact_threshold: null,
      claude_launch_settings_json: null,
    });
    for (const rows of [tables.provider_models, tables.provider_efforts]) {
      expect(rows).toContainEqual({ providerName: 'scope-only', name: 'custom', created_at: T });
    }
  });

  it.each(['[]', '{"TOKEN":1}', 'null', 'invalid'])(
    'fails preflight for invalid provider env %s even without scope rows',
    async (env) => {
      sqlite.prepare("UPDATE providers SET env = ? WHERE name = 'claude'").run(env);
      sqlite.exec('DELETE FROM provider_env_scopes');
      const result = await builder.build({ projectIds: ['A'], scope: 'attach' });
      expect(result).toMatchObject({
        ok: false,
        errors: [{ code: 'PROVIDER_ENV_INVALID', providerName: 'claude' }],
      });
    },
  );

  it('references a provider that only a project plugin override points at', async () => {
    ensureProvider(sqlite, 'prov-agy', 'agy', null);
    seed.insert('project_provider_plugin_overrides', {
      project_id: 'A',
      provider_id: 'prov-agy',
      plugin_id: 'plugin-agy',
      enabled: 1,
      ...stamps,
    });

    const attached = await builder.build({ projectIds: ['A'], scope: 'attach' });
    const detached = await builder.build({ projectIds: ['A'], scope: 'detach' });
    const live = await builder.build({ projectIds: ['A'], scope: 'live' });

    if (!attached.ok || !detached.ok || !live.ok) throw new Error('expected builds to succeed');
    expect(attached.replica.tables.providers.map((provider) => provider.name)).toContain('agy');
    expect(attached.replica.tables.project_provider_plugin_overrides).toEqual([
      { project_id: 'A', provider_id: 'prov-agy', plugin_id: 'plugin-agy', enabled: 1, ...stamps },
    ]);
    // The override returns at detach; the instance tables never do.
    expect(detached.replica.tables.project_provider_plugin_overrides).toEqual([
      { project_id: 'A', provider_id: 'prov-agy', plugin_id: 'plugin-agy', enabled: 1, ...stamps },
    ]);
    expect(detached.replica.tables).not.toHaveProperty('provider_settings');
    // Live carries neither the override nor its provider.
    expect(live.replica.tables).not.toHaveProperty('project_provider_plugin_overrides');
    expect(live.replica.tables.providers.map((provider) => provider.name)).not.toContain('agy');
  });

  it('fails preflight when a referenced provider is missing on the target', async () => {
    const result = await builder.build({
      projectIds: ['A'],
      scope: 'attach',
      targetProviderNames: ['claude'],
    });

    expect(result).toEqual({
      ok: false,
      errors: [{ code: 'PROVIDER_NOT_ON_TARGET', providerName: 'codex' }],
    });
  });

  it('fails preflight when a referenced profile belongs to another project', async () => {
    seed.seedAgent('agent-foreign', 'A', 'profile-c');

    const result = await builder.build({ projectIds: ['A'], scope: 'live' });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'REFERENCED_ROW_UNAVAILABLE',
          table: 'agent_profiles',
          id: 'profile-c',
          reason: 'other_project',
          referencedBy: { table: 'agents', id: 'agent-foreign' },
        },
      ],
    });
  });

  it('fails preflight when a profile prompt belongs to another project', async () => {
    seed.insert('prompts', {
      id: 'prompt-c',
      project_id: 'C',
      title: 'C',
      content: 'c',
      ...stamps,
    });
    seed.insert('agent_profile_prompts', {
      profile_id: 'profile-a',
      prompt_id: 'prompt-c',
      created_at: T,
    });

    const attach = await builder.build({ projectIds: ['A'], scope: 'attach' });
    const live = await builder.build({ projectIds: ['A'], scope: 'live' });

    expect(attach).toEqual({
      ok: false,
      errors: [
        {
          code: 'REFERENCED_ROW_UNAVAILABLE',
          table: 'prompts',
          id: 'prompt-c',
          reason: 'other_project',
          referencedBy: { table: 'agent_profiles', id: 'profile-a' },
        },
      ],
    });
    expect(live.ok).toBe(true);
  });

  it('fails preflight when a provider config points at a missing provider row', async () => {
    sqlite.pragma('foreign_keys = OFF');
    sqlite
      .prepare("UPDATE profile_provider_configs SET provider_id = 'prov-gone' WHERE id = ?")
      .run('profile-a-config');
    sqlite.pragma('foreign_keys = ON');

    const result = await builder.build({ projectIds: ['A'], scope: 'live' });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'PROVIDER_ROW_MISSING',
          providerId: 'prov-gone',
          referencedBy: { table: 'profile_provider_configs', id: 'profile-a-config' },
        },
      ],
    });
  });

  it('reports a missing project instead of a partial payload', async () => {
    const result = await builder.build({ projectIds: ['A', 'missing'], scope: 'live' });

    expect(result).toEqual({
      ok: false,
      errors: [{ code: 'PROJECT_NOT_FOUND', projectId: 'missing' }],
    });
  });
});
