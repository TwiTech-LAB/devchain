/**
 * ProjectReplicaV1 schema tests.
 * Test layer: pure unit. The schema is a pure Zod contract, so parsing literal
 * payloads is the cheapest reliable layer for accepted and rejected shapes.
 */

import { ProjectReplicaV1Schema, ReplicaProviderSettingsRowSchema } from './project-replica';

const now = '2026-09-22T10:00:00.000Z';

const project = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  name: 'Project',
  description: null,
  root_path: '/tmp/project',
  is_template: 0,
  is_private: 0,
  owner_user_id: null,
  created_at: now,
  updated_at: now,
};

const liveTables = {
  projects: [project],
  statuses: [],
  tags: [],
  providers: [{ id: 'provider-1', name: 'claude' }],
  agent_profiles: [],
  profile_provider_configs: [],
  agents: [],
  epics: [],
  epic_tags: [{ epic_id: 'epic-1', tag_name: 'Phase:1', created_at: now }],
  epic_comments: [],
  epic_relations: [],
  epic_time_segments: [],
};

const configurationTables = {
  prompts: [],
  prompt_tags: [],
  agent_profile_prompts: [],
  teams: [],
  team_members: [],
  team_profiles: [],
  team_profile_configs: [],
  terminal_watchers: [],
  automation_subscribers: [],
  scheduled_epics: [],
  project_settings: [{ project_id: 'project-1', key: 'projectPresets', value: [] }],
  project_provider_plugin_overrides: [
    {
      project_id: 'project-1',
      provider_id: 'provider-1',
      plugin_id: 'plugin-a',
      enabled: 0,
      created_at: now,
      updated_at: now,
    },
  ],
  sender_skill_slugs: ['team/skill'],
  skill_project_disabled: [
    {
      id: 'disabled-1',
      project_id: 'project-1',
      skill_slug: 'team/skill',
      created_at: now,
    },
  ],
  source_project_enabled: [
    {
      id: 'source-1',
      project_id: 'project-1',
      source_name: 'team',
      enabled: 0,
      created_at: now,
    },
  ],
  reviews: [],
  review_comments: [],
};

const instanceSettings = {
  messagePool: {
    enabled: false,
    delayMs: 15000,
    maxWaitMs: 45000,
    maxMessages: 4,
    separator: '\n==\n',
  },
  eventsEpicAssignedTemplate: '[Home] {epic_title} -> {agent_name}',
  skillsSources: { team: true, community: false },
  activityIdleTimeoutMs: 45000,
  terminal: {
    inputMode: 'form',
    scrollbackLines: 20000,
    seedingMaxBytes: 2097152,
    suppressCtrlCWithSelection: false,
  },
  skillsSyncOnStartup: false,
  messagingFollowNote: false,
};

const envelope = {
  version: 1,
  generatedAt: now,
  workspace: { id: 'workspace-1', name: 'Default' },
};

const settledSegment = {
  id: 'segment-1',
  project_id: 'project-1',
  epic_id: null,
  team_batch_id: null,
  attribution_source: 'direct',
  team_id_snapshot: null,
  team_name_snapshot: null,
  session_id_snapshot: 'session-1',
  agent_id_snapshot: 'agent-1',
  agent_name_snapshot: 'Coder',
  started_at: now,
  last_activity_at: now,
  closed_at: now,
  duration_ms: 1000,
  created_at: now,
  updated_at: now,
};

describe('ProjectReplicaV1Schema', () => {
  it('accepts each scope with its table set', () => {
    const payloads = [
      { ...envelope, scope: 'live', tables: liveTables },
      {
        ...envelope,
        scope: 'attach',
        tables: {
          ...liveTables,
          ...configurationTables,
          provider_settings: [
            {
              providerName: 'claude',
              env: { API_KEY: 'v' },
              envScopes: { API_KEY: ['project-1', 'project-outside'] },
              auto_compact_threshold: 42,
              claude_launch_settings_json: null,
            },
          ],
          provider_models: [{ providerName: 'claude', name: 'sonnet-4', created_at: now }],
          provider_efforts: [{ providerName: 'claude', name: 'high', created_at: now }],
          provider_plugin_defaults: [
            {
              providerName: 'claude',
              plugin_id: 'plugin-a',
              enabled: 1,
              created_at: now,
              updated_at: now,
            },
          ],
          instance_settings: instanceSettings,
          sessions: [],
          epic_time_session_watermarks: [],
        },
      },
      {
        ...envelope,
        scope: 'detach',
        tables: {
          ...liveTables,
          ...configurationTables,
          sessions: [],
          epic_time_session_watermarks: [],
        },
      },
    ];

    for (const payload of payloads) {
      expect(ProjectReplicaV1Schema.safeParse(payload).success).toBe(true);
    }
  });

  it('rejects an unknown version', () => {
    const result = ProjectReplicaV1Schema.safeParse({
      ...envelope,
      version: 2,
      scope: 'live',
      tables: liveTables,
    });

    expect(result.success).toBe(false);
  });

  it('rejects tables that do not belong to the scope', () => {
    const liveWithSessions = {
      ...envelope,
      scope: 'live',
      tables: { ...liveTables, sessions: [] },
    };
    const liveWithSkillSwitches = {
      ...envelope,
      scope: 'live',
      tables: {
        ...liveTables,
        sender_skill_slugs: [],
        skill_project_disabled: [],
        source_project_enabled: [],
      },
    };
    const attachWithoutSessions = {
      ...envelope,
      scope: 'attach',
      tables: {
        ...liveTables,
        ...configurationTables,
        provider_settings: [],
      },
    };
    const detachWithEnv = {
      ...envelope,
      scope: 'detach',
      tables: {
        ...liveTables,
        ...configurationTables,
        sessions: [],
        epic_time_session_watermarks: [],
        provider_settings: [],
      },
    };

    expect(ProjectReplicaV1Schema.safeParse(liveWithSessions).success).toBe(false);
    expect(ProjectReplicaV1Schema.safeParse(liveWithSkillSwitches).success).toBe(false);
    expect(ProjectReplicaV1Schema.safeParse(attachWithoutSessions).success).toBe(false);
    expect(ProjectReplicaV1Schema.safeParse(detachWithEnv).success).toBe(false);
  });

  it('requires sender skill slugs in attach and detach replicas', () => {
    const { sender_skill_slugs: senderSkillSlugs, ...configurationWithoutSenderSkills } =
      configurationTables;
    expect(senderSkillSlugs).toEqual(['team/skill']);
    const attachWithoutSenderSkills = {
      ...envelope,
      scope: 'attach',
      tables: {
        ...liveTables,
        ...configurationWithoutSenderSkills,
        provider_settings: [],
      },
    };
    const detachWithoutSenderSkills = {
      ...envelope,
      scope: 'detach',
      tables: {
        ...liveTables,
        ...configurationWithoutSenderSkills,
        sessions: [],
        epic_time_session_watermarks: [],
      },
    };

    expect(ProjectReplicaV1Schema.safeParse(attachWithoutSenderSkills).success).toBe(false);
    expect(ProjectReplicaV1Schema.safeParse(detachWithoutSenderSkills).success).toBe(false);
  });

  it('rejects unknown row columns and a replica without projects', () => {
    const extraColumn = {
      ...envelope,
      scope: 'live',
      tables: { ...liveTables, projects: [{ ...project, new_column: 1 }] },
    };
    const noProjects = { ...envelope, scope: 'live', tables: { ...liveTables, projects: [] } };

    expect(ProjectReplicaV1Schema.safeParse(extraColumn).success).toBe(false);
    expect(ProjectReplicaV1Schema.safeParse(noProjects).success).toBe(false);
  });

  it('accepts settled segments only', () => {
    const withSegment = (segment: Record<string, unknown>) => ({
      ...envelope,
      scope: 'live',
      tables: { ...liveTables, epic_time_segments: [segment] },
    });

    expect(ProjectReplicaV1Schema.safeParse(withSegment(settledSegment)).success).toBe(true);
    expect(
      ProjectReplicaV1Schema.safeParse(withSegment({ ...settledSegment, closed_at: null })).success,
    ).toBe(false);
    expect(
      ProjectReplicaV1Schema.safeParse(withSegment({ ...settledSegment, team_batch_id: 'batch-1' }))
        .success,
    ).toBe(false);
  });
});

const attach = (extra: Record<string, unknown>) => ({
  ...envelope,
  scope: 'attach',
  tables: {
    ...liveTables,
    ...configurationTables,
    provider_settings: [],
    provider_models: [],
    provider_efforts: [],
    provider_plugin_defaults: [],
    instance_settings: instanceSettings,
    sessions: [],
    epic_time_session_watermarks: [],
    ...extra,
  },
});

describe('ReplicaInstanceSettingsSchema', () => {
  const without = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...instanceSettings };
    delete copy[key];
    return copy;
  };

  it.each<[string, Record<string, unknown>]>([
    ['an unknown key', { ...instanceSettings, claudeBinaryPath: '/usr/bin/claude' }],
    [
      'an unknown terminal key',
      { ...instanceSettings, terminal: { ...instanceSettings.terminal, engine: 'pty' } },
    ],
    [
      'an unknown input mode',
      { ...instanceSettings, terminal: { ...instanceSettings.terminal, inputMode: 'vga' } },
    ],
    ['no terminal values', without('terminal')],
    ['no follow-note switch', without('messagingFollowNote')],
  ])('rejects instance settings with %s', (_label, value) => {
    expect(ProjectReplicaV1Schema.safeParse(attach({ instance_settings: value })).success).toBe(
      false,
    );
  });
});

describe('attach workspace grant authority', () => {
  const row = { device_kid: 'phone', workspace_id: 'workspace-1' };

  it('rejects the removed attach env table', () => {
    expect(ProjectReplicaV1Schema.safeParse(attach({ provider_env_scopes: [] })).success).toBe(
      false,
    );
  });

  it('accepts a scoped snapshot or an older payload without authority metadata', () => {
    expect(
      ProjectReplicaV1Schema.safeParse(
        attach({ paired_device_workspace_grants: [row], authorityKids: ['phone'] }),
      ).success,
    ).toBe(true);
    expect(ProjectReplicaV1Schema.safeParse(attach({})).success).toBe(true);
    expect(
      ProjectReplicaV1Schema.safeParse(
        attach({ paired_device_workspace_grants: [], authorityKids: ['revoked-phone'] }),
      ).success,
    ).toBe(true);
  });

  it.each([
    { paired_device_workspace_grants: [row] },
    { authorityKids: ['phone'] },
    { paired_device_workspace_grants: [row], authorityKids: [] },
    { paired_device_workspace_grants: [row, row], authorityKids: ['phone'] },
    { paired_device_workspace_grants: [row], authorityKids: ['phone', 'phone'] },
    {
      paired_device_workspace_grants: [{ ...row, workspace_id: 'other' }],
      authorityKids: ['phone'],
    },
  ])('rejects invalid or out-of-authority snapshot %#', (extra) => {
    expect(ProjectReplicaV1Schema.safeParse(attach(extra)).success).toBe(false);
  });

  it.each(['live', 'detach'])('does not accept grants on %s', (scope) => {
    const tables =
      scope === 'live'
        ? liveTables
        : { ...liveTables, ...configurationTables, sessions: [], epic_time_session_watermarks: [] };
    expect(
      ProjectReplicaV1Schema.safeParse({
        ...envelope,
        scope,
        tables: { ...tables, paired_device_workspace_grants: [row], authorityKids: ['phone'] },
      }).success,
    ).toBe(false);
  });
});

describe('provider env wire contract', () => {
  const settings = {
    providerName: 'claude',
    auto_compact_threshold: null,
    claude_launch_settings_json: null,
    env: { TOKEN: 'literal-value', EMPTY: '' },
    envScopes: { TOKEN: ['outside-project'] },
  };
  it('requires a string map or null and project-id arrays without excluding login keys', () => {
    expect(ReplicaProviderSettingsRowSchema.parse(settings)).toEqual(settings);
    for (const env of [null, {}]) {
      expect(ReplicaProviderSettingsRowSchema.safeParse({ ...settings, env }).success).toBe(true);
    }
    for (const env of [undefined, [], 'json', { KEY: 1 }]) {
      expect(ReplicaProviderSettingsRowSchema.safeParse({ ...settings, env }).success).toBe(false);
    }
    for (const envScopes of [undefined, null, { KEY: 'project' }, { KEY: [1] }]) {
      expect(ReplicaProviderSettingsRowSchema.safeParse({ ...settings, envScopes }).success).toBe(
        false,
      );
    }
  });
});
