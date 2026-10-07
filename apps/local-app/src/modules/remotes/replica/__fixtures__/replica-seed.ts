/**
 * Seeds the source project graph used by the replica builder and applier
 * integration specs: projects A, B and C in the default workspace, with global
 * and cross-project rows, settled/open/batch segments and a session.
 */
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../../../common/test/test-database.helper';
export const WORKSPACE_ID = '0defa017-0000-4000-8000-000000000001';
export const T = '2026-09-22T10:00:00.000Z';
export const stamps = { created_at: T, updated_at: T };

export function createReplicaDb(): { sqlite: Database.Database; db: BetterSQLite3Database } {
  return createTestDatabase();
}

export function replicaSeeder(sqlite: Database.Database) {
  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...columns.map((column) => row[column]));
  }

  function seedProject(id: string): void {
    insert('projects', {
      id,
      workspace_id: WORKSPACE_ID,
      name: `Project ${id}`,
      description: null,
      root_path: `/tmp/${id}`,
      is_template: 0,
      is_private: 0,
      ...stamps,
    });
    insert('statuses', {
      id: `${id}-status`,
      project_id: id,
      label: 'New',
      color: '#fff',
      position: 0,
      mcp_hidden: 0,
      ...stamps,
    });
  }

  function seedProfile(id: string, projectId: string | null, providerId: string): void {
    insert('agent_profiles', { id, project_id: projectId, name: `Profile ${id}`, ...stamps });
    insert('profile_provider_configs', {
      id: `${id}-config`,
      profile_id: id,
      provider_id: providerId,
      name: 'default',
      env: JSON.stringify({ CONFIG_SECRET: 'c' }),
      position: 0,
      ...stamps,
    });
  }

  function seedAgent(id: string, projectId: string, profileId: string): void {
    insert('agents', {
      id,
      project_id: projectId,
      profile_id: profileId,
      provider_config_id: `${profileId}-config`,
      name: `Agent ${id}`,
      is_project_owner: 0,
      ...stamps,
    });
  }

  function seedEpic(id: string, projectId: string, extra: Record<string, unknown> = {}): void {
    insert('epics', {
      id,
      project_id: projectId,
      title: `Epic ${id}`,
      status_id: `${projectId}-status`,
      version: 1,
      ...stamps,
      ...extra,
    });
  }

  function seedSegment(id: string, extra: Record<string, unknown>): void {
    insert('epic_time_segments', {
      id,
      project_id: 'A',
      epic_id: 'epic-1',
      attribution_source: 'direct',
      session_id_snapshot: `session-for-${id}`,
      agent_id_snapshot: 'agent-1',
      agent_name_snapshot: 'Agent agent-1',
      started_at: T,
      last_activity_at: T,
      duration_ms: 1000,
      ...stamps,
      ...extra,
    });
  }

  function seedSkill(id: string, slug: string, source = slug.split('/')[0]): void {
    insert('skills', {
      id,
      slug,
      name: slug.split('/').at(-1) ?? slug,
      display_name: slug,
      description: null,
      source,
      created_at: T,
      updated_at: T,
    });
  }

  return { insert, seedProject, seedProfile, seedAgent, seedEpic, seedSegment, seedSkill };
}

/**
 * Returns the ID of the provider named `name`, inserting it as `id` when the
 * database has none (a booted app may have seeded providers already).
 */
export function ensureProvider(
  sqlite: Database.Database,
  id: string,
  name: string,
  env: Record<string, string> | null,
): string {
  const existing = sqlite.prepare('SELECT id FROM providers WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  const envJson = env ? JSON.stringify(env) : null;
  if (existing) {
    sqlite.prepare('UPDATE providers SET env = ? WHERE id = ?').run(envJson, existing.id);
    return existing.id;
  }
  sqlite
    .prepare(
      `INSERT INTO providers (id, name, mcp_configured, env, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)`,
    )
    .run(id, name, envJson, T, T);
  return id;
}

/**
 * The instance-level agent settings an attach replica carries to the host, in
 * the stored encodings the settings writers produce.
 */
const INSTANCE_SETTING_ROWS = [
  ['setting-pool-enabled', 'messagePool.enabled', 'false'],
  ['setting-pool-delay', 'messagePool.delayMs', '15000'],
  ['setting-pool-max-wait', 'messagePool.maxWaitMs', '45000'],
  ['setting-pool-max-messages', 'messagePool.maxMessages', '4'],
  ['setting-pool-separator', 'messagePool.separator', JSON.stringify('\n==\n')],
  [
    'setting-epic-template',
    'events.epicAssigned.template',
    JSON.stringify('[Home] {epic_title} -> {agent_name}'),
  ],
  ['setting-skill-sources', 'skills.sources', JSON.stringify({ team: true, community: false })],
  ['setting-idle-timeout', 'activity.idleTimeoutMs', '45000'],
  ['setting-terminal-scrollback', 'terminal.scrollback.lines', '20000'],
  ['setting-terminal-seed-max', 'terminal.seeding.maxBytes', String(2 * 1024 * 1024)],
  ['setting-terminal-input-mode', 'terminal.inputMode', 'form'],
  ['setting-terminal-suppress-ctrl-c', 'terminal.suppressCtrlCWithSelection', 'false'],
  ['setting-skills-sync-on-startup', 'skills.syncOnStartup', 'false'],
  ['setting-messaging-follow-note', 'messaging.followNote', 'false'],
] as const;

/** Every setting key an attach replica's `instance_settings` covers. */
export const INSTANCE_SETTING_KEYS = INSTANCE_SETTING_ROWS.map(([, key]) => key);

/** Seeds projects A, B and C; returns the provider IDs the rows reference. */
export function seedReplicaSource(sqlite: Database.Database): { claude: string; codex: string } {
  const { insert, seedProject, seedProfile, seedAgent, seedEpic, seedSegment } =
    replicaSeeder(sqlite);
  seedProject('A');
  seedProject('B');
  seedProject('C');

  const claude = ensureProvider(sqlite, 'prov-claude', 'claude', {
    API_KEY: 'secret-a',
    UNSCOPED: 'x',
  });
  const codex = ensureProvider(sqlite, 'prov-codex', 'codex', null);
  insert('provider_env_scopes', {
    provider_id: claude,
    env_key: 'API_KEY',
    project_id: 'A',
    created_at: T,
  });
  insert('provider_env_scopes', {
    provider_id: claude,
    env_key: 'API_KEY',
    project_id: 'B',
    created_at: T,
  });

  seedProfile('profile-a', 'A', claude);
  seedProfile('profile-global', null, codex);
  seedProfile('profile-c', 'C', claude);
  seedAgent('agent-1', 'A', 'profile-a');
  seedAgent('agent-2', 'A', 'profile-global');

  insert('prompts', { id: 'prompt-a', project_id: 'A', title: 'A', content: 'a', ...stamps });
  insert('prompts', {
    id: 'prompt-global',
    project_id: null,
    title: 'G',
    content: 'g',
    ...stamps,
  });
  insert('prompts', {
    id: 'prompt-unused-global',
    project_id: null,
    title: 'U',
    content: 'u',
    ...stamps,
  });
  insert('agent_profile_prompts', {
    profile_id: 'profile-a',
    prompt_id: 'prompt-a',
    created_at: T,
  });
  insert('agent_profile_prompts', {
    profile_id: 'profile-a',
    prompt_id: 'prompt-global',
    created_at: T,
  });
  insert('tags', { id: 'tag-a', project_id: 'A', name: 'Phase:1', ...stamps });
  insert('tags', { id: 'tag-global', project_id: null, name: 'role', ...stamps });
  insert('prompt_tags', { prompt_id: 'prompt-a', tag_id: 'tag-a', created_at: T });
  insert('prompt_tags', { prompt_id: 'prompt-global', tag_id: 'tag-global', created_at: T });

  insert('teams', {
    id: 'team-1',
    project_id: 'A',
    name: 'Builders',
    team_lead_agent_id: 'agent-1',
    max_members: 5,
    max_concurrent_tasks: 5,
    allow_team_lead_create_agents: 0,
    ...stamps,
  });
  insert('team_members', { team_id: 'team-1', agent_id: 'agent-1', created_at: T });
  insert('team_profiles', { team_id: 'team-1', profile_id: 'profile-a', created_at: T });
  insert('team_profile_configs', {
    team_id: 'team-1',
    profile_id: 'profile-a',
    provider_config_id: 'profile-a-config',
    created_at: T,
  });

  insert('terminal_watchers', {
    id: 'watcher-1',
    project_id: 'A',
    name: 'Context full',
    enabled: 1,
    scope: 'provider',
    scope_filter_id: claude,
    poll_interval_ms: 5000,
    viewport_lines: 50,
    condition: JSON.stringify({ type: 'contains', pattern: 'full' }),
    idle_after_seconds: 0,
    cooldown_ms: 60000,
    cooldown_mode: 'time',
    event_name: 'claude.context_full',
    ...stamps,
  });
  insert('automation_subscribers', {
    id: 'subscriber-1',
    project_id: 'A',
    name: 'Notify',
    enabled: 1,
    event_name: 'claude.context_full',
    action_type: 'send_agent_message',
    action_inputs: '{}',
    delay_ms: 0,
    cooldown_ms: 5000,
    retry_on_error: 0,
    position: 0,
    priority: 0,
    ...stamps,
  });
  insert('scheduled_epics', {
    id: 'schedule-1',
    project_id: 'A',
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: 1,
    title_template: 'Nightly',
    allow_overlap: 0,
    missed_run_policy: 'skip',
    config_version: 1,
    ...stamps,
  });

  seedEpic('epic-1', 'A', { agent_id: 'agent-1' });
  seedEpic('epic-2', 'A', { parent_id: 'epic-1' });
  seedEpic('epic-b', 'B');
  insert('epic_tags', { epic_id: 'epic-1', tag_id: 'tag-a', created_at: T });
  insert('epic_comments', {
    id: 'comment-1',
    epic_id: 'epic-1',
    author_name: 'Coder',
    content: 'Started',
    ...stamps,
  });
  for (const [id, right] of [
    ['relation-internal', 'epic-2'],
    ['relation-cross', 'epic-b'],
  ]) {
    insert('epic_relations', {
      id,
      left_epic_id: 'epic-1',
      right_epic_id: right,
      type: 'related',
      direction: 'none',
      created_by: 'user',
      ...stamps,
    });
  }

  insert('reviews', {
    id: 'review-1',
    project_id: 'A',
    epic_id: 'epic-1',
    title: 'Review',
    status: 'pending',
    mode: 'commit',
    base_ref: 'main',
    head_ref: 'feature',
    created_by: 'user',
    version: 1,
    ...stamps,
  });
  insert('review_comments', {
    id: 'review-comment-1',
    review_id: 'review-1',
    content: 'Looks good',
    comment_type: 'comment',
    status: 'open',
    author_type: 'user',
    version: 1,
    ...stamps,
  });

  insert('epic_time_team_batches', {
    id: 'batch-1',
    project_id: 'A',
    team_id_snapshot: 'team-1',
    team_name_snapshot: 'Builders',
    lead_agent_id_snapshot: 'agent-1',
    lead_agent_name_snapshot: 'Agent agent-1',
    started_at: T,
    ...stamps,
  });
  seedSegment('segment-settled', { closed_at: T });
  seedSegment('segment-open', { closed_at: null });
  seedSegment('segment-batch', { closed_at: T, team_batch_id: 'batch-1' });

  insert('sessions', {
    id: 'session-1',
    agent_id: 'agent-1',
    epic_id: 'epic-1',
    status: 'stopped',
    started_at: T,
    ...stamps,
  });
  insert('epic_time_session_watermarks', {
    session_id: 'session-1',
    project_id: 'A',
    last_activity_at: T,
    ...stamps,
  });

  insert('settings', {
    id: 'setting-presets',
    key: 'projectPresets',
    value: JSON.stringify({ A: [{ name: 'Fast', agentConfigs: [] }], B: [] }),
    ...stamps,
  });
  insert('settings', {
    id: 'setting-autoclean',
    key: 'autoClean.statusIds',
    value: JSON.stringify({ A: ['A-status'] }),
    ...stamps,
  });

  // Upserts because a booted app may have seeded some of these keys already
  // (e.g. skills.sources).
  for (const [id, key, value] of INSTANCE_SETTING_ROWS) {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(id, key, value, T, T);
  }

  return { claude, codex };
}
