/**
 * Project write admission through every entry point of a booted app.
 * Test layer: two-instance integration. The contract is that each REST route,
 * MCP tool and background runner refuses writes to a project that a remote owns
 * (home) or that a handoff has frozen (host), which only the wired app shows.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { McpService } from '../../mcp/services/mcp.service';
import { ScheduledEpicRunnerService } from '../../scheduled-epics/services/scheduled-epic-runner.service';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { SkillSourceRegistryService } from '../../skills/services/skill-source-registry.service';
import { RegistryClientService } from '../../registry/services/registry-client.service';
import { RegistryOrchestrationService } from '../../registry/services/registry-orchestration.service';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsStore } from '../../teams/storage/teams.store';
import { ProjectFrozenError, ProjectRemoteError } from '../../../common/errors/error-types';
import { T, ensureProvider, replicaSeeder, stamps } from '../replica/__fixtures__/replica-seed';
import type { Remote } from '../../storage/models/domain.models';

const ids = {
  workspace: randomUUID(),
  project: randomUUID(),
  peerProject: randomUUID(),
  status: randomUUID(),
  status2: randomUUID(),
  epic: randomUUID(),
  epic2: randomUUID(),
  comment: randomUUID(),
  prompt: randomUUID(),
  profile: randomUUID(),
  config: randomUUID(),
  agent: randomUUID(),
  peerProfile: randomUUID(),
  peerConfig: randomUUID(),
  peerOwner: randomUUID(),
  team: randomUUID(),
  watcher: randomUUID(),
  subscriber: randomUUID(),
  schedule: randomUUID(),
  review: randomUUID(),
  reviewComment: randomUUID(),
  stoppedSession: randomUUID(),
  agentSession: randomUUID(),
  peerSession: randomUUID(),
  record: randomUUID(),
  recordTag: randomUUID(),
  disabledSkill: randomUUID(),
  enabledSkill: randomUUID(),
};

const DIRECT_WRITES = [
  [
    'teams store',
    (instance: TestInstance) => instance.app.get(TeamsStore).deleteTeamsByIds([ids.team]),
  ],
  [
    'core settings delegate',
    (instance: TestInstance) =>
      instance.app.get(SettingsService).updateSettings({
        initialSessionPromptIds: { [ids.project]: ids.prompt },
      }),
  ],
  [
    'preset settings delegate',
    (instance: TestInstance) =>
      instance.app.get(SettingsService).setProjectPresets(ids.project, []),
  ],
] as const;

/** The seeded project and a peer in the same workspace whose owner can message it. */
function seedProjects(sqlite: Database.Database, options: { scheduleDue: boolean }): void {
  const { insert } = replicaSeeder(sqlite);
  const provider = ensureProvider(sqlite, randomUUID(), 'claude', null);
  insert('project_workspaces', {
    id: ids.workspace,
    name: 'Remote team',
    is_default: 0,
    position: 5,
    ...stamps,
  });
  for (const [id, name] of [
    [ids.project, 'Bound'],
    [ids.peerProject, 'Peer'],
  ]) {
    insert('projects', {
      id,
      workspace_id: ids.workspace,
      name,
      description: null,
      root_path: `/tmp/${id}`,
      is_template: 0,
      is_private: 0,
      ...stamps,
    });
  }
  for (const [id, position] of [
    [ids.status, 0],
    [ids.status2, 1],
  ] as const) {
    insert('statuses', {
      id,
      project_id: ids.project,
      label: `Status ${position}`,
      color: '#ffffff',
      position,
      mcp_hidden: 0,
      ...stamps,
    });
  }
  for (const [profile, config, projectId] of [
    [ids.profile, ids.config, ids.project],
    [ids.peerProfile, ids.peerConfig, ids.peerProject],
  ]) {
    insert('agent_profiles', { id: profile, project_id: projectId, name: 'Coder', ...stamps });
    insert('profile_provider_configs', {
      id: config,
      profile_id: profile,
      provider_id: provider,
      name: 'default',
      position: 0,
      ...stamps,
    });
  }
  insert('agents', {
    id: ids.agent,
    project_id: ids.project,
    profile_id: ids.profile,
    provider_config_id: ids.config,
    name: 'Lead',
    is_project_owner: 1,
    ...stamps,
  });
  insert('agents', {
    id: ids.peerOwner,
    project_id: ids.peerProject,
    profile_id: ids.peerProfile,
    provider_config_id: ids.peerConfig,
    name: 'Peer Owner',
    is_project_owner: 1,
    ...stamps,
  });
  insert('prompts', {
    id: ids.prompt,
    project_id: ids.project,
    title: 'P',
    content: 'p',
    ...stamps,
  });
  for (const id of [ids.epic, ids.epic2]) {
    insert('epics', {
      id,
      project_id: ids.project,
      title: `Epic ${id}`,
      status_id: ids.status,
      version: 1,
      ...stamps,
    });
  }
  insert('epic_comments', {
    id: ids.comment,
    epic_id: ids.epic,
    author_name: 'User',
    content: 'hello',
    ...stamps,
  });
  insert('records', {
    id: ids.record,
    epic_id: ids.epic,
    type: 'note',
    data: '{}',
    version: 1,
    ...stamps,
  });
  insert('tags', { id: ids.recordTag, project_id: ids.project, name: 'kept-tag', ...stamps });
  insert('record_tags', { record_id: ids.record, tag_id: ids.recordTag, created_at: T });
  for (const [id, name] of [
    [ids.disabledSkill, 'disabled'],
    [ids.enabledSkill, 'enabled'],
  ]) {
    insert('skills', {
      id,
      slug: `gate-source/${name}`,
      name,
      display_name: name,
      source: 'gate-source',
      ...stamps,
    });
  }
  insert('skill_project_disabled', {
    id: randomUUID(),
    project_id: ids.project,
    skill_id: ids.disabledSkill,
    created_at: T,
  });
  insert('source_project_enabled', {
    id: randomUUID(),
    project_id: ids.project,
    source_name: 'gate-source',
    enabled: 1,
    created_at: T,
  });
  const templates = Object.fromEntries(
    [ids.project, ids.peerProject].map((projectId) => [
      projectId,
      {
        templateSlug: 'gate-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://example.test/registry',
        installedAt: T,
        lastUpdateCheckAt: T,
        source: 'registry',
      },
    ]),
  );
  sqlite
    .prepare(
      'INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(randomUUID(), 'registryTemplates', JSON.stringify(templates), T, T);
  insert('project_provider_plugin_overrides', {
    project_id: ids.project,
    provider_id: provider,
    plugin_id: 'gate-plugin',
    enabled: 1,
    ...stamps,
  });
  insert('teams', {
    id: ids.team,
    project_id: ids.project,
    name: 'Builders',
    team_lead_agent_id: ids.agent,
    max_members: 5,
    max_concurrent_tasks: 5,
    allow_team_lead_create_agents: 1,
    ...stamps,
  });
  insert('team_members', { team_id: ids.team, agent_id: ids.agent, created_at: T });
  insert('team_profiles', { team_id: ids.team, profile_id: ids.profile, created_at: T });
  insert('terminal_watchers', {
    id: ids.watcher,
    project_id: ids.project,
    name: 'Context full',
    enabled: 0,
    scope: 'all',
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
    id: ids.subscriber,
    project_id: ids.project,
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
    id: ids.schedule,
    project_id: ids.project,
    name: 'Nightly',
    cron_expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: options.scheduleDue ? 1 : 0,
    title_template: 'Nightly',
    allow_overlap: 0,
    missed_run_policy: 'skip',
    config_version: 1,
    next_run_at: options.scheduleDue ? '2020-01-01T00:00:00.000Z' : null,
    ...stamps,
  });
  insert('reviews', {
    id: ids.review,
    project_id: ids.project,
    epic_id: ids.epic,
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
    id: ids.reviewComment,
    review_id: ids.review,
    content: 'Looks good',
    comment_type: 'comment',
    status: 'open',
    author_type: 'user',
    version: 1,
    ...stamps,
  });
  insert('sessions', {
    id: ids.stoppedSession,
    agent_id: ids.agent,
    status: 'stopped',
    started_at: T,
    ...stamps,
  });
}

/** Running session rows give MCP calls their agent context; no tmux is involved. */
function seedRunningSessions(sqlite: Database.Database): void {
  const { insert } = replicaSeeder(sqlite);
  insert('sessions', {
    id: ids.agentSession,
    agent_id: ids.agent,
    status: 'running',
    started_at: T,
    ...stamps,
  });
  insert('sessions', {
    id: ids.peerSession,
    agent_id: ids.peerOwner,
    status: 'running',
    started_at: T,
    ...stamps,
  });
}

interface WriteRoute {
  readonly name: string;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

const WRITE_ROUTES: readonly WriteRoute[] = [
  {
    name: 'enable a project skill',
    method: 'POST',
    path: `/api/skills/${ids.disabledSkill}/enable`,
    body: { projectId: ids.project },
  },
  {
    name: 'disable a project skill',
    method: 'POST',
    path: `/api/skills/${ids.enabledSkill}/disable`,
    body: { projectId: ids.project },
  },
  {
    name: 'enable all project skills',
    method: 'POST',
    path: '/api/skills/enable-all',
    body: { projectId: ids.project },
  },
  {
    name: 'disable all project skills',
    method: 'POST',
    path: '/api/skills/disable-all',
    body: { projectId: ids.project },
  },
  {
    name: 'enable a project skill source',
    method: 'POST',
    path: '/api/skills/sources/gate-source/enable-project',
    body: { projectId: ids.project },
  },
  {
    name: 'disable a project skill source',
    method: 'POST',
    path: '/api/skills/sources/gate-source/disable-project',
    body: { projectId: ids.project },
  },
  {
    name: 'check linked registry updates',
    method: 'POST',
    path: `/api/registry/check-updates/${ids.project}`,
  },
  {
    name: 'set project provider plugin policy',
    method: 'PUT',
    path: '/api/provider-plugins/policy/project',
    body: {
      projectId: ids.project,
      providerId: 'replaced-provider-id',
      pluginId: 'gate-plugin',
      enabled: false,
    },
  },
  {
    name: 'reset project provider plugin policy',
    method: 'DELETE',
    path: `/api/provider-plugins/policy/project?projectId=${ids.project}&providerId=replaced-provider-id&pluginId=gate-plugin`,
  },
  {
    name: 'create epic',
    method: 'POST',
    path: '/api/epics',
    body: { projectId: ids.project, title: 'New', statusId: ids.status },
  },
  {
    name: 'update epic',
    method: 'PUT',
    path: `/api/epics/${ids.epic}`,
    body: { title: 'X', version: 1 },
  },
  {
    name: 'bulk update epics',
    method: 'POST',
    path: '/api/epics/bulk-update',
    body: { updates: [{ id: ids.epic, statusId: ids.status2, version: 1 }] },
  },
  { name: 'delete epic', method: 'DELETE', path: `/api/epics/${ids.epic2}` },
  {
    name: 'add epic comment',
    method: 'POST',
    path: `/api/epics/${ids.epic}/comments`,
    body: { authorName: 'User', content: 'more' },
  },
  { name: 'delete epic comment', method: 'DELETE', path: `/api/comments/${ids.comment}` },
  {
    name: 'set epic relation',
    method: 'PUT',
    path: `/api/epics/${ids.epic}/relations/${ids.epic2}`,
    body: { type: 'related' },
  },
  {
    name: 'delete epic relation',
    method: 'DELETE',
    path: `/api/epics/${ids.epic}/relations/${ids.epic2}`,
  },
  {
    name: 'create status',
    method: 'POST',
    path: '/api/statuses',
    body: { projectId: ids.project, label: 'Done', color: '#000000', position: 9 },
  },
  {
    name: 'update status',
    method: 'PUT',
    path: `/api/statuses/${ids.status}`,
    body: { label: 'Y' },
  },
  { name: 'delete status', method: 'DELETE', path: `/api/statuses/${ids.status2}` },
  {
    name: 'reorder statuses',
    method: 'POST',
    path: '/api/statuses/reorder',
    body: { projectId: ids.project, statusIds: [ids.status2, ids.status] },
  },
  {
    name: 'create prompt',
    method: 'POST',
    path: '/api/prompts',
    body: { projectId: ids.project, title: 'T', content: 'c' },
  },
  {
    name: 'update prompt',
    method: 'PUT',
    path: `/api/prompts/${ids.prompt}`,
    body: { title: 'T2', version: 1 },
  },
  { name: 'delete prompt', method: 'DELETE', path: `/api/prompts/${ids.prompt}` },
  {
    name: 'create profile',
    method: 'POST',
    path: '/api/profiles',
    body: { projectId: ids.project, name: 'New' },
  },
  {
    name: 'update profile',
    method: 'PUT',
    path: `/api/profiles/${ids.profile}`,
    body: { name: 'Renamed' },
  },
  {
    name: 'replace profile prompts',
    method: 'PUT',
    path: `/api/profiles/${ids.profile}/prompts`,
    body: { promptIds: [ids.prompt] },
  },
  { name: 'delete profile', method: 'DELETE', path: `/api/profiles/${ids.profile}` },
  {
    name: 'create provider config',
    method: 'POST',
    path: `/api/profiles/${ids.profile}/provider-configs`,
    body: { providerId: 'any', name: 'second' },
  },
  {
    name: 'reorder provider configs',
    method: 'PUT',
    path: `/api/profiles/${ids.profile}/provider-configs/order`,
    body: { configIds: [ids.config] },
  },
  {
    name: 'update provider config',
    method: 'PUT',
    path: `/api/provider-configs/${ids.config}`,
    body: { name: 'n' },
  },
  { name: 'delete provider config', method: 'DELETE', path: `/api/provider-configs/${ids.config}` },
  {
    name: 'create agent',
    method: 'POST',
    path: '/api/agents',
    body: {
      projectId: ids.project,
      profileId: ids.profile,
      providerConfigId: ids.config,
      name: 'N',
    },
  },
  { name: 'update agent', method: 'PUT', path: `/api/agents/${ids.agent}`, body: { name: 'N' } },
  { name: 'patch agent', method: 'PATCH', path: `/api/agents/${ids.agent}`, body: { name: 'N' } },
  { name: 'delete agent', method: 'DELETE', path: `/api/agents/${ids.agent}` },
  {
    name: 'restart agent',
    method: 'POST',
    path: `/api/agents/${ids.agent}/restart`,
    body: { projectId: ids.project },
  },
  {
    name: 'create team',
    method: 'POST',
    path: '/api/teams',
    body: { projectId: ids.project, name: 'Second', memberAgentIds: [ids.agent] },
  },
  { name: 'update team', method: 'PUT', path: `/api/teams/${ids.team}`, body: { name: 'Renamed' } },
  { name: 'disband team', method: 'DELETE', path: `/api/teams/${ids.team}` },
  {
    name: 'create watcher',
    method: 'POST',
    path: '/api/watchers',
    body: {
      projectId: ids.project,
      name: 'W',
      condition: { type: 'contains', pattern: 'x' },
      eventName: 'custom.event',
    },
  },
  {
    name: 'update watcher',
    method: 'PUT',
    path: `/api/watchers/${ids.watcher}`,
    body: { name: 'W2' },
  },
  {
    name: 'toggle watcher',
    method: 'POST',
    path: `/api/watchers/${ids.watcher}/toggle`,
    body: { enabled: true },
  },
  { name: 'delete watcher', method: 'DELETE', path: `/api/watchers/${ids.watcher}` },
  {
    name: 'create subscriber',
    method: 'POST',
    path: '/api/subscribers',
    body: {
      projectId: ids.project,
      name: 'S',
      eventName: 'custom.event',
      actionType: 'send_agent_message',
      actionInputs: {},
    },
  },
  {
    name: 'update subscriber',
    method: 'PUT',
    path: `/api/subscribers/${ids.subscriber}`,
    body: { name: 'S2' },
  },
  {
    name: 'toggle subscriber',
    method: 'POST',
    path: `/api/subscribers/${ids.subscriber}/toggle`,
    body: { enabled: false },
  },
  { name: 'delete subscriber', method: 'DELETE', path: `/api/subscribers/${ids.subscriber}` },
  {
    name: 'create schedule',
    method: 'POST',
    path: '/api/scheduled-epics',
    body: {
      projectId: ids.project,
      name: 'Daily',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      titleTemplate: 'Daily',
    },
  },
  {
    name: 'update schedule',
    method: 'PUT',
    path: `/api/scheduled-epics/${ids.schedule}`,
    body: { configVersion: 1, name: 'Weekly' },
  },
  {
    name: 'toggle schedule',
    method: 'POST',
    path: `/api/scheduled-epics/${ids.schedule}/toggle`,
    body: { enabled: false, configVersion: 1 },
  },
  {
    name: 'run schedule now',
    method: 'POST',
    path: `/api/scheduled-epics/${ids.schedule}/run-now`,
  },
  { name: 'delete schedule', method: 'DELETE', path: `/api/scheduled-epics/${ids.schedule}` },
  {
    name: 'launch session',
    method: 'POST',
    path: '/api/sessions/launch',
    body: { projectId: ids.project, agentId: ids.agent },
  },
  {
    name: 'restore session',
    method: 'POST',
    path: `/api/sessions/${ids.stoppedSession}/restore`,
    body: { projectId: ids.project },
  },
  {
    name: 'rename session',
    method: 'PATCH',
    path: `/api/sessions/${ids.stoppedSession}`,
    body: { projectId: ids.project, name: 'Renamed' },
  },
  {
    name: 'delete session record',
    method: 'DELETE',
    path: `/api/sessions/${ids.stoppedSession}/record?projectId=${ids.project}`,
  },
  {
    name: 'create review',
    method: 'POST',
    path: '/api/reviews',
    body: { projectId: ids.project, title: 'R', baseRef: 'main', headRef: 'feature' },
  },
  {
    name: 'update review',
    method: 'PUT',
    path: `/api/reviews/${ids.review}`,
    body: { title: 'R2', version: 1 },
  },
  { name: 'delete review', method: 'DELETE', path: `/api/reviews/${ids.review}` },
  {
    name: 'comment on review',
    method: 'POST',
    path: `/api/reviews/${ids.review}/comments`,
    body: { content: 'nit' },
  },
  {
    name: 'resolve review comment',
    method: 'PATCH',
    path: `/api/reviews/${ids.review}/comments/${ids.reviewComment}/resolve`,
    body: { status: 'resolved', version: 1 },
  },
  {
    name: 'update project',
    method: 'PUT',
    path: `/api/projects/${ids.project}`,
    body: { name: 'Moved' },
  },
  {
    name: 'move project to another workspace',
    method: 'PUT',
    path: `/api/projects/${ids.project}`,
    body: { workspaceId: 'replaced-in-test' },
  },
  { name: 'delete project', method: 'DELETE', path: `/api/projects/${ids.project}` },
  {
    name: 'import into project',
    method: 'POST',
    path: `/api/projects/${ids.project}/import`,
    body: {},
  },
  {
    name: 'upgrade project template',
    method: 'POST',
    path: `/api/projects/${ids.project}/upgrade-template`,
    body: { targetVersion: '2.0.0' },
  },
  {
    name: 'create project preset',
    method: 'POST',
    path: `/api/projects/${ids.project}/presets`,
    body: { name: 'Fast', agentConfigs: [] },
  },
  {
    name: 'apply project preset',
    method: 'POST',
    path: `/api/projects/${ids.project}/presets/apply`,
    body: { presetName: 'Fast' },
  },
  {
    name: 'set project auto-clean statuses',
    method: 'POST',
    path: `/api/settings/autoclean/${ids.project}`,
    body: { statusIds: [ids.status] },
  },
  {
    name: 'change project settings slice',
    method: 'PUT',
    path: '/api/settings',
    body: { autoClean: { statusIds: { [ids.project]: [ids.status2] } } },
  },
  {
    name: 'delete the workspace holding the project',
    method: 'DELETE',
    path: `/api/workspaces/${ids.workspace}`,
    body: { replacementWorkspaceId: 'replaced-in-test' },
  },
];

const PROTECTED_TABLES = [
  'projects',
  'statuses',
  'epics',
  'epic_comments',
  'epic_relations',
  'prompts',
  'agent_profiles',
  'profile_provider_configs',
  'agents',
  'teams',
  'terminal_watchers',
  'automation_subscribers',
  'scheduled_epics',
  'scheduled_epic_runs',
  'reviews',
  'review_comments',
  'sessions',
  'records',
  'record_tags',
  'tags',
  'guests',
  'project_provider_plugin_overrides',
  'skill_project_disabled',
  'source_project_enabled',
];

const STORAGE_MCP_WRITES = [
  [
    'devchain_skills_set_enabled',
    { sessionId: ids.agentSession, slugs: ['gate-source/enabled'], enabled: false },
  ],
  [
    'devchain_skills_set_source_enabled',
    { sessionId: ids.agentSession, sourceName: 'gate-source', enabled: false },
  ],
  [
    'devchain_create_record',
    { epicId: ids.epic, type: 'note', data: { changed: true }, tags: ['new-tag'] },
  ],
  ['devchain_update_record', { id: ids.record, version: 1, data: { changed: true } }],
  ['devchain_add_tags', { id: ids.record, tags: ['new-tag'] }],
  ['devchain_remove_tags', { id: ids.record, tags: ['kept-tag'] }],
  ['devchain_register_guest', { name: 'Gate guest', tmuxSessionId: 'gate-guest-session' }],
] as const;

function snapshot(sqlite: Database.Database): Record<string, unknown[]> {
  return Object.fromEntries([
    ...PROTECTED_TABLES.map((table) => [
      table,
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
    [
      'project_settings',
      sqlite
        .prepare(
          "SELECT * FROM settings WHERE key IN ('registryTemplates', 'initialSessionPromptIds', 'autoClean.statusIds', 'messagePool.projects', 'projectPresets', 'projectActivePresets') ORDER BY key",
        )
        .all(),
    ],
  ]);
}

describe('project write admission between two instances', () => {
  let instances: TwoInstances;
  let remote: Remote;

  beforeAll(async () => {
    instances = await startTwoInstances();
    await Promise.all(
      [instances.home, instances.host].map((instance) =>
        waitForValue(
          async () =>
            instance.app.get(RegistryOrchestrationService).getUpdateStatus().state !== 'pending',
          15_000,
        ),
      ),
    );
    seedProjects(instances.home.sqlite, { scheduleDue: false });
    seedProjects(instances.host.sqlite, { scheduleDue: false });
    remote = await instances.registerRemote('vm-1');
    await instances.bindProject(ids.project, remote.id, 'remote');
    for (const instance of [instances.home, instances.host]) {
      const registry = instance.app.get(SkillSourceRegistryService);
      const sources = await registry.listRegisteredSources();
      jest
        .spyOn(registry, 'listRegisteredSources')
        .mockResolvedValue([
          ...sources,
          { name: 'gate-source', kind: 'builtin', repoUrl: 'https://example.test/gate-source' },
        ]);
      Object.assign(instance.app.get(RegistryClientService), {
        getTemplate: jest.fn().mockResolvedValue({
          template: { slug: 'gate-template' },
          versions: [{ version: '2.0.0', isLatest: true }],
        }),
      });
    }
    instances.home.sqlite
      .prepare('UPDATE scheduled_epics SET enabled = 1, next_run_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', ids.schedule);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  /** `replaced-in-test` stands for the instance's default workspace. */
  function send(instance: TestInstance, route: WriteRoute): Promise<Response> {
    const { id: defaultWorkspaceId } = instance.sqlite
      .prepare('SELECT id FROM project_workspaces WHERE is_default = 1')
      .get() as { id: string };
    const body =
      route.body === undefined
        ? undefined
        : JSON.stringify(route.body).replaceAll('replaced-in-test', defaultWorkspaceId);
    const { provider_id: providerId } = instance.sqlite
      .prepare('SELECT provider_id FROM profile_provider_configs WHERE id = ?')
      .get(ids.config) as { provider_id: string };
    return fetch(`${instance.url}${route.path.replaceAll('replaced-provider-id', providerId)}`, {
      method: route.method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: body.replaceAll('replaced-provider-id', providerId),
          }),
    });
  }

  async function assertStorageMcpAdmission(
    instance: TestInstance,
    tool: (typeof STORAGE_MCP_WRITES)[number][0],
    params: (typeof STORAGE_MCP_WRITES)[number][1],
    code: 'PROJECT_REMOTE' | 'PROJECT_FROZEN',
  ): Promise<void> {
    if (tool === 'devchain_register_guest') {
      const terminalIO = instance.app.get(TerminalIOService);
      jest.spyOn(terminalIO, 'sessionExists').mockResolvedValueOnce(true);
      Object.assign(terminalIO, {
        getSessionCwd: jest.fn().mockResolvedValue(`/tmp/${ids.project}`),
      });
    }
    const before = snapshot(instance.sqlite);
    const response = await instance.app.get(McpService).handleToolCall(tool, params);
    expect(response).toMatchObject({
      success: false,
      error: { code, data: { projectId: ids.project } },
    });
    expect(snapshot(instance.sqlite)).toEqual(before);
  }

  describe('at home while a remote owns the project', () => {
    let before: Record<string, unknown[]>;

    beforeAll(() => {
      before = snapshot(instances.home.sqlite);
    });

    it.each(WRITE_ROUTES.map((route) => [route.name, route] as const))(
      'refuses to %s with 423 PROJECT_REMOTE',
      async (_name, route) => {
        const response = await send(instances.home, route);
        const body = (await response.json()) as { code?: string; details?: unknown };

        expect({ status: response.status, code: body.code }).toEqual({
          status: 423,
          code: 'PROJECT_REMOTE',
        });
        expect(body.details).toEqual({
          projectId: ids.project,
          remoteId: remote.id,
          remoteName: 'vm-1',
        });
        if (route.name === 'check linked registry updates') {
          expect(instances.home.app.get(RegistryClientService).getTemplate).not.toHaveBeenCalled();
        }
      },
    );

    it('left every protected row unchanged', () => {
      expect(snapshot(instances.home.sqlite)).toEqual(before);
    });

    it.each(DIRECT_WRITES)('%s receives the shared gate through Nest DI', async (_name, write) => {
      const before = snapshot(instances.home.sqlite);

      await expect(write(instances.home)).rejects.toThrow(ProjectRemoteError);

      expect(snapshot(instances.home.sqlite)).toEqual(before);
    });

    it('keeps reads open', async () => {
      for (const path of [
        `/api/epics?projectId=${ids.project}`,
        `/api/epics/${ids.epic}`,
        `/api/statuses?projectId=${ids.project}`,
        `/api/agents?projectId=${ids.project}`,
      ]) {
        const response = await fetch(`${instances.home.url}${path}`);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
      }
    });

    it('skips the project in the scheduler without claiming a run', async () => {
      const schedule = instances.home.sqlite
        .prepare('SELECT enabled, next_run_at FROM scheduled_epics WHERE id = ?')
        .get(ids.schedule) as { enabled: number; next_run_at: string };
      expect(schedule.enabled).toBe(1);
      expect(new Date(schedule.next_run_at).getTime()).toBeLessThan(Date.now());
      const runner = instances.home.app.get(ScheduledEpicRunnerService);
      await (runner as unknown as { scanAndExecute(): Promise<void> }).scanAndExecute();

      const runs = instances.home.sqlite
        .prepare('SELECT COUNT(*) AS n FROM scheduled_epic_runs WHERE schedule_id = ?')
        .get(ids.schedule) as { n: number };
      expect(runs.n).toBe(0);
    });

    describe('MCP', () => {
      let mcp: McpService;

      beforeAll(() => {
        seedRunningSessions(instances.home.sqlite);
        mcp = instances.home.app.get(McpService);
      });

      it.each([
        ['devchain_create_epic', { title: 'From MCP' }],
        ['devchain_update_epic', { id: ids.epic, version: 1, title: 'X' }],
        ['devchain_add_epic_comment', { epicId: ids.epic, content: 'hi' }],
        [
          'devchain_epic_relations_set',
          { epicId: ids.epic, relatedEpicId: ids.epic2, relation: 'related' },
        ],
        ['devchain_epic_relations_delete', { epicId: ids.epic, relatedEpicId: ids.epic2 }],
        ['devchain_delete_epic', { id: ids.epic2 }],
        ['devchain_send_message', { recipientAgentNames: ['Lead'], message: 'hi' }],
        ['devchain_teams_create_agent', { name: 'Helper', configName: 'default' }],
      ] as const)('%s returns the structured PROJECT_REMOTE error', async (tool, params) => {
        const response = await mcp.handleToolCall(tool, {
          sessionId: ids.agentSession,
          ...params,
        });

        expect(response).toMatchObject({
          success: false,
          error: {
            code: 'PROJECT_REMOTE',
            data: { projectId: ids.project, remoteId: remote.id, remoteName: 'vm-1' },
          },
        });
      });

      it('omits the project from devchain_projects_list', async () => {
        const response = await mcp.handleToolCall('devchain_projects_list', {
          sessionId: ids.peerSession,
        });

        expect(response.success).toBe(true);
        const projects = (response.data as { projects: Array<{ id: string }> }).projects;
        expect(projects.map((project) => project.id)).not.toContain(ids.project);
      });

      it.each(STORAGE_MCP_WRITES)(
        '%s refuses writes and preserves rows at home',
        async (tool, params) => {
          await assertStorageMcpAdmission(instances.home, tool, params, 'PROJECT_REMOTE');
        },
      );

      it('refuses a cross-project devchain_send_message with PROJECT_REMOTE', async () => {
        const response = await mcp.handleToolCall('devchain_send_message', {
          sessionId: ids.peerSession,
          recipientProjectId: ids.project,
          message: 'status?',
        });

        expect(response).toMatchObject({
          success: false,
          error: { code: 'PROJECT_REMOTE', data: { remoteId: remote.id, remoteName: 'vm-1' } },
        });
      });
    });
  });

  describe('on the host while a handoff freezes the project', () => {
    let before: Record<string, unknown[]>;

    beforeAll(async () => {
      await instances.host.app.get(ProjectFreezeService).freeze(ids.project);
      before = snapshot(instances.host.sqlite);
    });

    afterAll(async () => {
      await instances.host.app.get(ProjectFreezeService).thaw(ids.project);
    });

    it.each(WRITE_ROUTES.map((route) => [route.name, route] as const))(
      'refuses to %s with 423 PROJECT_FROZEN',
      async (_name, route) => {
        const response = await send(instances.host, route);
        const body = (await response.json()) as { code?: string; details?: unknown };

        expect({ status: response.status, code: body.code }).toEqual({
          status: 423,
          code: 'PROJECT_FROZEN',
        });
        expect(body.details).toEqual({ projectId: ids.project });
        if (route.name === 'check linked registry updates') {
          expect(instances.host.app.get(RegistryClientService).getTemplate).not.toHaveBeenCalled();
        }
      },
    );

    it('left every protected row unchanged', () => {
      expect(snapshot(instances.host.sqlite)).toEqual(before);
    });

    it.each(DIRECT_WRITES)('%s receives the shared gate through Nest DI', async (_name, write) => {
      const before = snapshot(instances.host.sqlite);

      await expect(write(instances.host)).rejects.toThrow(ProjectFrozenError);

      expect(snapshot(instances.host.sqlite)).toEqual(before);
    });

    it('admits writes again after thaw', async () => {
      await instances.host.app.get(ProjectFreezeService).thaw(ids.project);
      try {
        const response = await send(instances.host, {
          name: 'update status',
          method: 'PUT',
          path: `/api/statuses/${ids.status}`,
          body: { label: 'After thaw' },
        });
        expect(response.status).toBe(200);
      } finally {
        await instances.host.app.get(ProjectFreezeService).freeze(ids.project);
      }
    });

    describe('MCP storage writers', () => {
      beforeAll(() => seedRunningSessions(instances.host.sqlite));
      it.each(STORAGE_MCP_WRITES)(
        '%s refuses writes and preserves rows on a frozen host',
        async (tool, params) => {
          await assertStorageMcpAdmission(instances.host, tool, params, 'PROJECT_FROZEN');
        },
      );
    });
  });

  it('checks a writable tracked project against a successful registry response and persists its timestamp', async () => {
    const response = await fetch(
      `${instances.home.url}/api/registry/check-updates/${ids.peerProject}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      linked: true,
      hasUpdate: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
    });
    expect(instances.home.app.get(RegistryClientService).getTemplate).toHaveBeenCalledWith(
      'gate-template',
    );
    expect(
      instances.home.app.get(SettingsService).getProjectTemplateMetadata(ids.peerProject)
        ?.lastUpdateCheckAt,
    ).not.toBe(T);
    expect(
      instances.home.app.get(SettingsService).getProjectTemplateMetadata(ids.project)
        ?.lastUpdateCheckAt,
    ).toBe(T);
  });
});
