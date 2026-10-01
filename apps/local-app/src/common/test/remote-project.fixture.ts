/**
 * A complete project for remote handoff specs (connect, mirror, disconnect),
 * with UUID ids so the real REST routes accept them, and per-table readers
 * that compare two instances row by row.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  T,
  ensureProvider,
  replicaSeeder,
  stamps,
} from '../../modules/remotes/replica/__fixtures__/replica-seed';

export interface SeededRemoteProject {
  workspaceId: string;
  projectId: string;
  statusIds: [string, string, string];
  tagIds: [string, string];
  promptId: string;
  profileId: string;
  configId: string;
  leadAgentId: string;
  memberAgentId: string;
  teamId: string;
  /** `rootEpicId` is assigned to the lead, has `childEpicId` and the ClickUp link. */
  rootEpicId: string;
  childEpicId: string;
  /** Related (no direction) to `rootEpicId`. */
  peerEpicId: string;
  spareEpicId: string;
  commentIds: [string, string];
  relationId: string;
  externalLinkId: string;
  segmentIds: [string, string];
  sessionId: string;
  scheduleId: string;
  providerName: string;
}

const PROVIDER_NAME = 'claude';

/**
 * Seeds one project with every replicated table: statuses, tags, a prompt, a
 * profile with a config, a lead and a member in one team, epics with a
 * parent/child pair, comments, a relation, a ClickUp link (home-only), settled
 * time segments, a stopped session with its watermark and a disabled schedule.
 * The provider env holds a secret scoped to the project.
 */
export function seedRemoteProject(sqlite: Database.Database): SeededRemoteProject {
  const { insert } = replicaSeeder(sqlite);
  const ids: SeededRemoteProject = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    statusIds: [randomUUID(), randomUUID(), randomUUID()],
    tagIds: [randomUUID(), randomUUID()],
    promptId: randomUUID(),
    profileId: randomUUID(),
    configId: randomUUID(),
    leadAgentId: randomUUID(),
    memberAgentId: randomUUID(),
    teamId: randomUUID(),
    rootEpicId: randomUUID(),
    childEpicId: randomUUID(),
    peerEpicId: randomUUID(),
    spareEpicId: randomUUID(),
    commentIds: [randomUUID(), randomUUID()],
    relationId: randomUUID(),
    externalLinkId: randomUUID(),
    segmentIds: [randomUUID(), randomUUID()],
    sessionId: randomUUID(),
    scheduleId: randomUUID(),
    providerName: PROVIDER_NAME,
  };
  const providerId = ensureProvider(sqlite, randomUUID(), PROVIDER_NAME, { API_KEY: 'secret' });

  insert('project_workspaces', {
    id: ids.workspaceId,
    name: 'Handoff',
    is_default: 0,
    position: 7,
    ...stamps,
  });
  insert('projects', {
    id: ids.projectId,
    workspace_id: ids.workspaceId,
    name: 'Handoff project',
    description: 'Moves to a remote and back',
    root_path: `/tmp/${ids.projectId}`,
    is_template: 0,
    is_private: 0,
    ...stamps,
  });
  insert('provider_env_scopes', {
    provider_id: providerId,
    env_key: 'API_KEY',
    project_id: ids.projectId,
    created_at: T,
  });
  ids.statusIds.forEach((id, position) =>
    insert('statuses', {
      id,
      project_id: ids.projectId,
      label: ['New', 'In Progress', 'Done'][position],
      color: '#ffffff',
      position,
      mcp_hidden: 0,
      ...stamps,
    }),
  );
  ids.tagIds.forEach((id, index) =>
    insert('tags', { id, project_id: ids.projectId, name: `Phase:${index + 1}`, ...stamps }),
  );
  insert('prompts', {
    id: ids.promptId,
    project_id: ids.projectId,
    title: 'SOP',
    content: 'Follow the SOP',
    ...stamps,
  });
  insert('prompt_tags', { prompt_id: ids.promptId, tag_id: ids.tagIds[0], created_at: T });
  insert('agent_profiles', {
    id: ids.profileId,
    project_id: ids.projectId,
    name: 'Coder',
    ...stamps,
  });
  insert('profile_provider_configs', {
    id: ids.configId,
    profile_id: ids.profileId,
    provider_id: providerId,
    name: 'default',
    env: JSON.stringify({ CONFIG_SECRET: 'c' }),
    position: 0,
    ...stamps,
  });
  insert('agent_profile_prompts', {
    profile_id: ids.profileId,
    prompt_id: ids.promptId,
    created_at: T,
  });
  for (const [id, name, owner] of [
    [ids.leadAgentId, 'Lead', 1],
    [ids.memberAgentId, 'Member', 0],
  ] as const) {
    insert('agents', {
      id,
      project_id: ids.projectId,
      profile_id: ids.profileId,
      provider_config_id: ids.configId,
      name,
      is_project_owner: owner,
      ...stamps,
    });
  }
  insert('teams', {
    id: ids.teamId,
    project_id: ids.projectId,
    name: 'Builders',
    team_lead_agent_id: ids.leadAgentId,
    max_members: 5,
    max_concurrent_tasks: 5,
    allow_team_lead_create_agents: 0,
    ...stamps,
  });
  for (const agentId of [ids.leadAgentId, ids.memberAgentId]) {
    insert('team_members', { team_id: ids.teamId, agent_id: agentId, created_at: T });
  }
  insert('team_profiles', { team_id: ids.teamId, profile_id: ids.profileId, created_at: T });
  insert('team_profile_configs', {
    team_id: ids.teamId,
    profile_id: ids.profileId,
    provider_config_id: ids.configId,
    created_at: T,
  });

  const epic = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    insert('epics', {
      id,
      project_id: ids.projectId,
      title,
      status_id: ids.statusIds[0],
      version: 1,
      ...stamps,
      ...extra,
    });
  epic(ids.rootEpicId, 'Root', { agent_id: ids.leadAgentId });
  epic(ids.childEpicId, 'Child', { parent_id: ids.rootEpicId, status_id: ids.statusIds[1] });
  epic(ids.peerEpicId, 'Peer');
  epic(ids.spareEpicId, 'Spare');
  insert('epic_tags', { epic_id: ids.rootEpicId, tag_id: ids.tagIds[0], created_at: T });
  insert('epic_tags', { epic_id: ids.childEpicId, tag_id: ids.tagIds[1], created_at: T });
  ids.commentIds.forEach((id, index) =>
    insert('epic_comments', {
      id,
      epic_id: index === 0 ? ids.rootEpicId : ids.childEpicId,
      author_name: 'Coder',
      content: `Comment ${index + 1}`,
      ...stamps,
    }),
  );
  const [left, right] = [ids.rootEpicId, ids.peerEpicId].sort();
  insert('epic_relations', {
    id: ids.relationId,
    left_epic_id: left,
    right_epic_id: right,
    type: 'related',
    direction: 'none',
    created_by: 'user',
    ...stamps,
  });
  insert('external_task_links', {
    id: ids.externalLinkId,
    epic_id: ids.rootEpicId,
    project_id: ids.projectId,
    connection_id: null,
    provider: 'clickup',
    remote_scope_key: 'team-1',
    remote_task_id: 'cu-123',
    source_snapshot: JSON.stringify({ name: 'ClickUp task' }),
    ...stamps,
  });

  insert('sessions', {
    id: ids.sessionId,
    agent_id: ids.leadAgentId,
    epic_id: ids.rootEpicId,
    status: 'stopped',
    started_at: '2026-09-22T09:00:00.000Z',
    ended_at: '2026-09-22T09:30:00.000Z',
    last_activity_at: '2026-09-22T09:29:00.000Z',
    ...stamps,
  });
  insert('epic_time_session_watermarks', {
    session_id: ids.sessionId,
    project_id: ids.projectId,
    last_activity_at: '2026-09-22T09:29:00.000Z',
    ...stamps,
  });
  ids.segmentIds.forEach((id, index) =>
    insert('epic_time_segments', {
      id,
      project_id: ids.projectId,
      epic_id: index === 0 ? ids.rootEpicId : ids.childEpicId,
      attribution_source: 'direct',
      session_id_snapshot: ids.sessionId,
      agent_id_snapshot: ids.leadAgentId,
      agent_name_snapshot: 'Lead',
      started_at: `2026-09-22T09:0${index}:00.000Z`,
      last_activity_at: `2026-09-22T09:1${index}:00.000Z`,
      closed_at: `2026-09-22T09:1${index}:00.000Z`,
      duration_ms: 600_000,
      ...stamps,
    }),
  );
  insert('scheduled_epics', {
    id: ids.scheduleId,
    project_id: ids.projectId,
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: 0,
    title_template: 'Nightly',
    allow_overlap: 0,
    missed_run_policy: 'skip',
    config_version: 1,
    ...stamps,
  });
  return ids;
}

/** Tables whose rows the live mirror keeps equal to the host. */
export const LIVE_REPLICA_TABLES = [
  'projects',
  'statuses',
  'tags',
  'providers',
  'agent_profiles',
  'profile_provider_configs',
  'agents',
  'epics',
  'epic_tags',
  'epic_comments',
  'epic_relations',
  'epic_time_segments',
] as const;

/** Tables that also travel on connect and disconnect. */
export const ATTACH_REPLICA_TABLES = [
  ...LIVE_REPLICA_TABLES,
  'prompts',
  'prompt_tags',
  'agent_profile_prompts',
  'teams',
  'team_members',
  'team_profiles',
  'team_profile_configs',
  'terminal_watchers',
  'automation_subscribers',
  'scheduled_epics',
  'reviews',
  'review_comments',
  'provider_env_scopes',
] as const;

/** Tables only a disconnect brings back. */
export const DETACH_ONLY_TABLES = ['sessions', 'epic_time_session_watermarks'] as const;

export type ReplicaTableName =
  | (typeof ATTACH_REPLICA_TABLES)[number]
  | (typeof DETACH_ONLY_TABLES)[number];

const PROFILES = `SELECT id FROM agent_profiles WHERE project_id = @p
  UNION SELECT profile_id FROM agents WHERE project_id = @p`;

/**
 * One key per row of `table` that belongs to the project. Keys are row IDs,
 * or the natural key for join tables; providers and tags on join rows are
 * named, because provider IDs differ between instances.
 */
const KEY_QUERIES: Record<ReplicaTableName, string> = {
  projects: 'SELECT id AS k FROM projects WHERE id = @p',
  statuses: 'SELECT id AS k FROM statuses WHERE project_id = @p',
  tags: 'SELECT id AS k FROM tags WHERE project_id = @p',
  providers: `SELECT DISTINCT pr.name AS k FROM providers pr
    JOIN profile_provider_configs c ON c.provider_id = pr.id
    WHERE c.profile_id IN (${PROFILES})`,
  agent_profiles: `SELECT id AS k FROM agent_profiles WHERE id IN (${PROFILES})`,
  profile_provider_configs: `SELECT id AS k FROM profile_provider_configs
    WHERE profile_id IN (${PROFILES})`,
  agents: 'SELECT id AS k FROM agents WHERE project_id = @p',
  epics: 'SELECT id AS k FROM epics WHERE project_id = @p',
  epic_tags: `SELECT et.epic_id || ' ' || t.name AS k FROM epic_tags et
    JOIN tags t ON t.id = et.tag_id JOIN epics e ON e.id = et.epic_id WHERE e.project_id = @p`,
  epic_comments: `SELECT c.id AS k FROM epic_comments c JOIN epics e ON e.id = c.epic_id
    WHERE e.project_id = @p`,
  epic_relations: `SELECT r.id AS k FROM epic_relations r JOIN epics e ON e.id = r.left_epic_id
    WHERE e.project_id = @p`,
  epic_time_segments: `SELECT id AS k FROM epic_time_segments
    WHERE project_id = @p AND closed_at IS NOT NULL AND team_batch_id IS NULL`,
  prompts: 'SELECT id AS k FROM prompts WHERE project_id = @p',
  prompt_tags: `SELECT pt.prompt_id || ' ' || t.name AS k FROM prompt_tags pt
    JOIN tags t ON t.id = pt.tag_id JOIN prompts pr ON pr.id = pt.prompt_id
    WHERE pr.project_id = @p`,
  agent_profile_prompts: `SELECT profile_id || ' ' || prompt_id AS k FROM agent_profile_prompts
    WHERE profile_id IN (${PROFILES})`,
  teams: 'SELECT id AS k FROM teams WHERE project_id = @p',
  team_members: `SELECT tm.team_id || ' ' || tm.agent_id AS k FROM team_members tm
    JOIN teams t ON t.id = tm.team_id WHERE t.project_id = @p`,
  team_profiles: `SELECT tp.team_id || ' ' || tp.profile_id AS k FROM team_profiles tp
    JOIN teams t ON t.id = tp.team_id WHERE t.project_id = @p`,
  team_profile_configs: `SELECT tc.team_id || ' ' || tc.profile_id || ' ' || tc.provider_config_id
    AS k FROM team_profile_configs tc JOIN teams t ON t.id = tc.team_id WHERE t.project_id = @p`,
  terminal_watchers: 'SELECT id AS k FROM terminal_watchers WHERE project_id = @p',
  automation_subscribers: 'SELECT id AS k FROM automation_subscribers WHERE project_id = @p',
  scheduled_epics: 'SELECT id AS k FROM scheduled_epics WHERE project_id = @p',
  reviews: 'SELECT id AS k FROM reviews WHERE project_id = @p',
  review_comments: `SELECT rc.id AS k FROM review_comments rc JOIN reviews r ON r.id = rc.review_id
    WHERE r.project_id = @p`,
  provider_env_scopes: `SELECT pr.name || ' ' || s.env_key AS k FROM provider_env_scopes s
    JOIN providers pr ON pr.id = s.provider_id WHERE s.project_id = @p`,
  sessions: `SELECT s.id AS k FROM sessions s JOIN agents a ON a.id = s.agent_id
    WHERE a.project_id = @p`,
  epic_time_session_watermarks: `SELECT session_id AS k FROM epic_time_session_watermarks
    WHERE project_id = @p`,
};

/** The project's row keys per table, sorted. */
export function readProjectRowKeys(
  sqlite: Database.Database,
  projectId: string,
  tables: readonly ReplicaTableName[],
): Record<string, string[]> {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (sqlite.prepare(KEY_QUERIES[table]).all({ p: projectId }) as Array<{ k: string }>)
        .map((row) => row.k)
        .sort(),
    ]),
  );
}

/**
 * Per table, the keys only one side has. An equal pair yields `[]`, and a
 * failing `toEqual([])` names each table and row that differs.
 */
export function diffProjectRowKeys(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
  labels: [string, string] = ['home', 'host'],
): Array<Record<string, string | string[]>> {
  const diffs: Array<Record<string, string | string[]>> = [];
  for (const table of Object.keys({ ...left, ...right })) {
    const leftKeys = new Set(left[table] ?? []);
    const rightKeys = new Set(right[table] ?? []);
    const onlyLeft = [...leftKeys].filter((key) => !rightKeys.has(key));
    const onlyRight = [...rightKeys].filter((key) => !leftKeys.has(key));
    if (onlyLeft.length > 0 || onlyRight.length > 0) {
      diffs.push({ table, [`only ${labels[0]}`]: onlyLeft, [`only ${labels[1]}`]: onlyRight });
    }
  }
  return diffs;
}

/** Full rows by id for the project, for content comparison of id-keyed tables. */
export function readProjectRows(
  sqlite: Database.Database,
  table: 'statuses' | 'agents' | 'epics' | 'epic_relations' | 'epic_time_segments',
  projectId: string,
): Record<string, Record<string, unknown>> {
  const sql =
    table === 'epic_relations'
      ? `SELECT r.* FROM epic_relations r JOIN epics e ON e.id = r.left_epic_id
         WHERE e.project_id = ?`
      : `SELECT * FROM ${table} WHERE project_id = ?`;
  const rows = sqlite.prepare(sql).all(projectId) as Array<Record<string, unknown>>;
  return Object.fromEntries(rows.map((row) => [String(row.id), row]));
}
