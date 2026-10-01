import { effectiveSourceSwitches, registeredSourceNames } from '../helpers/skill-source-switches';
import { isAlwaysEnabledSkillSource } from '../../../../common/constants/built-in-skill-sources';
import { PROJECT_REPLICA_SETTING_KEYS } from '@devchain/shared';
import type { ReplicaInstanceSettings } from '@devchain/shared';
import type {
  ProjectReplicaSource,
  ReadProjectReplicaSourceOptions,
} from '../../interfaces/storage.interface';
import {
  DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS,
  DEFAULT_EPIC_ASSIGNED_TEMPLATE,
  DEFAULT_MESSAGING_FOLLOW_NOTE,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_ENABLED,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_SEPARATOR,
  DEFAULT_SKILLS_SYNC_ON_STARTUP,
  DEFAULT_TERMINAL_INPUT_MODE,
  DEFAULT_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
  MAX_MESSAGE_POOL_DELAY_MS,
  MAX_MESSAGE_POOL_MAX_MESSAGES,
  MAX_MESSAGE_POOL_MAX_WAIT_MS,
  MAX_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SEED_MAX_BYTES,
  MIN_MESSAGE_POOL_DELAY_MS,
  MIN_MESSAGE_POOL_MAX_MESSAGES,
  MIN_MESSAGE_POOL_MAX_WAIT_MS,
  MIN_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SEED_MAX_BYTES,
} from '../../../settings/services/settings.constants';
import { TERMINAL_INPUT_MODES } from '../../../settings/dtos/settings.dto';
import { SkillsSettingsDelegate } from '../../../settings/local/delegates/skills-settings.delegate';
import { readRevokedDeviceKids } from '../../../e2ee/services/device-revocation-history';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

// Stays well under SQLite's bound-parameter limit.
const ID_CHUNK_SIZE = 500;

// Every column except `frozen_at`: the freeze flag is local to each instance.
const PROJECT_COLUMNS =
  'id, workspace_id, name, description, root_path, is_template, is_private, owner_user_id, created_at, updated_at';

export class ProjectReplicaReadStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async readProjectReplicaSource(
    projectIds: readonly string[],
    options: ReadProjectReplicaSourceOptions,
  ): Promise<ProjectReplicaSource> {
    return this.txRunner.runImmediateQueuedOrJoin(() =>
      this.readSourceSync([...new Set(projectIds)], options),
    );
  }

  private readSourceSync(
    requestedIds: string[],
    options: ReadProjectReplicaSourceOptions,
  ): ProjectReplicaSource {
    // Inside the transaction no write can land between this instant and the reads below.
    const source = emptySource(new Date().toISOString());
    source.projects = this.selectIn(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id IN`,
      requestedIds,
    );
    const projectIds = source.projects.map((project) => project.id);
    if (projectIds.length === 0) {
      return source;
    }

    const byProject = <T>(table: string, orderBy = 'id'): T[] =>
      this.selectIn<T>(
        `SELECT * FROM ${table} WHERE project_id IN`,
        projectIds,
        `ORDER BY ${orderBy}`,
      );

    source.workspaces = this.selectIn(
      'SELECT id, name FROM project_workspaces WHERE id IN',
      unique(source.projects.map((project) => project.workspace_id)),
    );
    if (options.includeWorkspaceGrants) {
      const directory = this.rawClient
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('cloud.e2ee.devices') as { value: string } | undefined;
      const parsed = directory ? JSON.parse(directory.value) : { v: 1, devices: {} };
      if (
        parsed.v !== 1 ||
        !parsed.devices ||
        typeof parsed.devices !== 'object' ||
        Array.isArray(parsed.devices)
      ) {
        throw new Error('Invalid paired-device directory');
      }
      source.authorityKids = [
        ...new Set([...Object.keys(parsed.devices), ...readRevokedDeviceKids(this.rawClient)]),
      ].sort();
      source.paired_device_workspace_grants = this.selectIn(
        'SELECT device_kid, workspace_id FROM paired_device_workspace_grants WHERE workspace_id IN',
        source.workspaces.map((workspace) => workspace.id),
        'ORDER BY workspace_id, device_kid',
      );
    }
    source.statuses = byProject('statuses');
    source.tags = byProject('tags');
    source.agents = byProject('agents');
    this.readEpicTier(source, projectIds, options.changedSince);
    source.epic_relations = this.readRelations(projectIds);
    if (options.includeIdSets) {
      source.idSets = {
        epics: this.selectIn<{ id: string }>(
          'SELECT id FROM epics WHERE project_id IN',
          projectIds,
          'ORDER BY id',
        ).map((row) => row.id),
        epic_comments: this.selectIn<{ id: string }>(
          'SELECT c.id FROM epic_comments c JOIN epics e ON e.id = c.epic_id WHERE e.project_id IN',
          projectIds,
          'ORDER BY c.id',
        ).map((row) => row.id),
        epic_time_segments: this.selectIn<{ id: string }>(
          `SELECT id FROM epic_time_segments
           WHERE closed_at IS NOT NULL AND team_batch_id IS NULL AND project_id IN`,
          projectIds,
          'ORDER BY id',
        ).map((row) => row.id),
      };
    }

    if (options.includeConfiguration) {
      source.prompts = byProject('prompts');
      source.teams = byProject('teams');
      const teamIds = source.teams.map((team) => team.id);
      source.team_members = this.selectIn(
        'SELECT * FROM team_members WHERE team_id IN',
        teamIds,
        'ORDER BY team_id, agent_id',
      );
      source.team_profiles = this.selectIn(
        'SELECT * FROM team_profiles WHERE team_id IN',
        teamIds,
        'ORDER BY team_id, profile_id',
      );
      source.team_profile_configs = this.selectIn(
        'SELECT * FROM team_profile_configs WHERE team_id IN',
        teamIds,
        'ORDER BY team_id, profile_id, provider_config_id',
      );
      source.terminal_watchers = byProject('terminal_watchers');
      source.automation_subscribers = byProject('automation_subscribers');
      source.scheduled_epics = byProject('scheduled_epics');
      source.reviews = byProject('reviews');
      source.review_comments = this.selectIn(
        'SELECT * FROM review_comments WHERE review_id IN',
        source.reviews.map((review) => review.id),
        'ORDER BY id',
      );
      source.provider_env_scopes = this.selectIn(
        'SELECT provider_id, env_key, project_id FROM provider_env_scopes WHERE project_id IN',
        projectIds,
        'ORDER BY provider_id, env_key, project_id',
      );
      source.project_provider_plugin_overrides = byProject(
        'project_provider_plugin_overrides',
        'project_id, provider_id, plugin_id',
      );
      source.skill_project_disabled = this.selectIn(
        `SELECT disabled.id, disabled.project_id, skill.slug AS skill_slug, disabled.created_at
         FROM skill_project_disabled disabled
         JOIN skills skill ON skill.id = disabled.skill_id
         WHERE disabled.project_id IN`,
        projectIds,
        'ORDER BY disabled.project_id, skill.slug',
      );
      source.sender_skill_slugs = (
        this.rawClient.prepare('SELECT slug FROM skills ORDER BY slug').all() as Array<{
          slug: string;
        }>
      ).map(({ slug }) => slug);
      source.source_project_enabled = byProject(
        'source_project_enabled',
        'project_id, source_name',
      );
      source.settings = this.selectIn(
        'SELECT key, value FROM settings WHERE key IN',
        [...PROJECT_REPLICA_SETTING_KEYS],
        'ORDER BY key',
      );
      source.instanceSettings = this.readInstanceSettings();
    }

    if (options.includeSessions) {
      source.sessions = this.selectIn(
        'SELECT s.* FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.project_id IN',
        projectIds,
        'ORDER BY s.id',
      );
      source.epic_time_session_watermarks = byProject('epic_time_session_watermarks', 'session_id');
    }

    this.readReferencedConfiguration(source, projectIds, options.includeConfiguration);
    return source;
  }

  /**
   * The instance's effective global agent settings, resolved with the same
   * defaults, clamps and decodings the settings readers apply, so the replica
   * carries exactly what the sending instance operates on. The receiver stores
   * the values verbatim; its own readers then resolve them identically.
   */
  private readInstanceSettings(): ReplicaInstanceSettings {
    const rawSetting = (key: string): string | undefined => {
      const row = this.rawClient.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? decodeStoredString(row.value) : undefined;
    };
    const clampedNumber = (key: string, fallback: number, min: number, max: number): number => {
      const raw = rawSetting(key);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      // Same admission as the settings reader: only finite positives clamp.
      return Number.isFinite(parsed) && parsed > 0
        ? Math.max(min, Math.min(parsed, max))
        : fallback;
    };
    const booleanSetting = (key: string, fallback: boolean): boolean => {
      const raw = rawSetting(key);
      return raw === undefined ? fallback : raw === 'true';
    };

    const separatorRaw = rawSetting('messagePool.separator');
    const templateRaw = rawSetting('events.epicAssigned.template');
    const template = templateRaw?.trim() ? templateRaw.trim() : undefined;
    const idleRaw = rawSetting('activity.idleTimeoutMs');
    const idleParsed = idleRaw === undefined ? Number.NaN : Number(idleRaw);
    const inputModeRaw = rawSetting('terminal.inputMode');

    return {
      messagePool: {
        enabled: booleanSetting('messagePool.enabled', DEFAULT_MESSAGE_POOL_ENABLED),
        delayMs: clampedNumber(
          'messagePool.delayMs',
          DEFAULT_MESSAGE_POOL_DELAY_MS,
          MIN_MESSAGE_POOL_DELAY_MS,
          MAX_MESSAGE_POOL_DELAY_MS,
        ),
        maxWaitMs: clampedNumber(
          'messagePool.maxWaitMs',
          DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
          MIN_MESSAGE_POOL_MAX_WAIT_MS,
          MAX_MESSAGE_POOL_MAX_WAIT_MS,
        ),
        maxMessages: clampedNumber(
          'messagePool.maxMessages',
          DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
          MIN_MESSAGE_POOL_MAX_MESSAGES,
          MAX_MESSAGE_POOL_MAX_MESSAGES,
        ),
        separator: separatorRaw ?? DEFAULT_MESSAGE_POOL_SEPARATOR,
      },
      eventsEpicAssignedTemplate: template ?? DEFAULT_EPIC_ASSIGNED_TEMPLATE,
      skillsSources: this.readSkillSources(),
      activityIdleTimeoutMs:
        Number.isFinite(idleParsed) && idleParsed > 0
          ? idleParsed
          : DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS,
      terminal: {
        inputMode:
          TERMINAL_INPUT_MODES.find((mode) => mode === inputModeRaw) ?? DEFAULT_TERMINAL_INPUT_MODE,
        scrollbackLines: clampedNumber(
          'terminal.scrollback.lines',
          DEFAULT_TERMINAL_SCROLLBACK,
          MIN_TERMINAL_SCROLLBACK,
          MAX_TERMINAL_SCROLLBACK,
        ),
        seedingMaxBytes: clampedNumber(
          'terminal.seeding.maxBytes',
          DEFAULT_TERMINAL_SEED_MAX_BYTES,
          MIN_TERMINAL_SEED_MAX_BYTES,
          MAX_TERMINAL_SEED_MAX_BYTES,
        ),
        suppressCtrlCWithSelection: booleanSetting(
          'terminal.suppressCtrlCWithSelection',
          DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
        ),
      },
      skillsSyncOnStartup: new SkillsSettingsDelegate({
        sqlite: this.rawClient,
      }).getSkillsSyncOnStartup(),
      messagingFollowNote: booleanSetting('messaging.followNote', DEFAULT_MESSAGING_FOLLOW_NOTE),
    };
  }

  /** Same normalization as the skills settings readers: lowercase keys, boolean values only. */
  private readSkillSources(): Record<string, boolean> {
    const row = this.rawClient
      .prepare("SELECT value FROM settings WHERE key = 'skills.sources'")
      .get() as { value: string } | undefined;
    const names = registeredSourceNames(
      (
        this.rawClient
          .prepare(
            'SELECT name FROM community_skill_sources UNION SELECT name FROM local_skill_sources',
          )
          .all() as Array<{ name: string }>
      ).map((source) => source.name),
    );
    const normalized: Record<string, boolean> = {};
    try {
      let parsed: unknown = JSON.parse(row?.value ?? '{}');
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [rawKey, value] of Object.entries(parsed)) {
          const key = rawKey.trim().toLowerCase();
          if (key && typeof value === 'boolean' && !isAlwaysEnabledSkillSource(key)) {
            normalized[key] = value;
          }
        }
      }
    } catch {
      /* Malformed stored switches use the enabled default. */
    }
    return effectiveSourceSwitches(normalized, names);
  }

  /**
   * Epics with their tags and comments, plus settled segments. With `changedSince`,
   * only epics whose row or any comment changed after it (comment writes do not
   * touch `epics.updated_at`), and only segments updated after it.
   */
  private readEpicTier(
    source: ProjectReplicaSource,
    projectIds: string[],
    changedSince: string | undefined,
  ): void {
    const settled = 'closed_at IS NOT NULL AND team_batch_id IS NULL';
    if (changedSince === undefined) {
      source.epics = this.selectIn(
        'SELECT * FROM epics WHERE project_id IN',
        projectIds,
        'ORDER BY id',
      );
      source.epic_time_segments = this.selectIn(
        `SELECT * FROM epic_time_segments WHERE ${settled} AND project_id IN`,
        projectIds,
        'ORDER BY id',
      );
    } else {
      source.epics = this.selectIn(
        'SELECT e.* FROM epics e WHERE e.project_id IN',
        projectIds,
        `AND (e.updated_at > ? OR EXISTS (
           SELECT 1 FROM epic_comments c WHERE c.epic_id = e.id AND c.updated_at > ?))
         ORDER BY e.id`,
        [changedSince, changedSince],
      );
      source.epic_time_segments = this.selectIn(
        `SELECT * FROM epic_time_segments WHERE ${settled} AND project_id IN`,
        projectIds,
        'AND updated_at > ? ORDER BY id',
        [changedSince],
      );
    }

    const epicIds = source.epics.map((epic) => epic.id);
    source.epic_tags = this.selectIn(
      `SELECT et.epic_id, t.name AS tag_name, et.created_at
       FROM epic_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.epic_id IN`,
      epicIds,
      'ORDER BY et.epic_id, t.name',
    );
    source.epic_comments = this.selectIn(
      'SELECT * FROM epic_comments WHERE epic_id IN',
      epicIds,
      'ORDER BY id',
    );
  }

  private readRelations(projectIds: string[]): ProjectReplicaSource['epic_relations'] {
    const sql = `SELECT r.*, le.project_id AS left_project_id, re.project_id AS right_project_id
       FROM epic_relations r
       JOIN epics le ON le.id = r.left_epic_id
       JOIN epics re ON re.id = r.right_epic_id
       WHERE `;
    const rows = new Map<string, ProjectReplicaSource['epic_relations'][number]>();
    for (const side of ['le', 're']) {
      for (const row of this.selectIn<ProjectReplicaSource['epic_relations'][number]>(
        `${sql}${side}.project_id IN`,
        projectIds,
      )) {
        rows.set(row.id, row);
      }
    }
    return [...rows.values()].sort((a, b) => compare(a.id, b.id));
  }

  /**
   * Adds the profiles, provider configs, prompts, tags and providers that the
   * project rows point at, wherever they live.
   */
  private readReferencedConfiguration(
    source: ProjectReplicaSource,
    projectIds: string[],
    includeConfiguration: boolean,
  ): void {
    const profileIds = new Set<string>();
    const configIds = new Set<string>();
    for (const agent of source.agents) {
      profileIds.add(agent.profile_id);
      configIds.add(agent.provider_config_id);
    }
    for (const row of source.team_profiles) profileIds.add(row.profile_id);
    for (const row of source.team_profile_configs) {
      profileIds.add(row.profile_id);
      configIds.add(row.provider_config_id);
    }

    const referencedConfigs = this.selectIn<
      ProjectReplicaSource['profile_provider_configs'][number]
    >('SELECT * FROM profile_provider_configs WHERE id IN', [...configIds]);
    for (const config of referencedConfigs) profileIds.add(config.profile_id);

    const projectProfiles = this.selectIn<ProjectReplicaSource['agent_profiles'][number]>(
      'SELECT * FROM agent_profiles WHERE project_id IN',
      projectIds,
    );
    for (const profile of projectProfiles) profileIds.delete(profile.id);
    source.agent_profiles = sortById([
      ...projectProfiles,
      ...this.selectIn<ProjectReplicaSource['agent_profiles'][number]>(
        'SELECT * FROM agent_profiles WHERE id IN',
        [...profileIds],
      ),
    ]);

    const configsById = new Map(referencedConfigs.map((config) => [config.id, config]));
    for (const config of this.selectIn<ProjectReplicaSource['profile_provider_configs'][number]>(
      'SELECT * FROM profile_provider_configs WHERE profile_id IN',
      source.agent_profiles.map((profile) => profile.id),
    )) {
      configsById.set(config.id, config);
    }
    source.profile_provider_configs = sortById([...configsById.values()]);

    const providerIds = new Set(
      source.profile_provider_configs.map((config) => config.provider_id),
    );

    if (includeConfiguration) {
      source.agent_profile_prompts = this.selectIn(
        'SELECT * FROM agent_profile_prompts WHERE profile_id IN',
        source.agent_profiles.map((profile) => profile.id),
        'ORDER BY profile_id, created_at, prompt_id',
      );
      const projectPromptIds = new Set(source.prompts.map((prompt) => prompt.id));
      const foreignPromptIds = unique(
        source.agent_profile_prompts
          .map((row) => row.prompt_id)
          .filter((promptId) => !projectPromptIds.has(promptId)),
      );
      source.prompts = sortById([
        ...source.prompts,
        ...this.selectIn<ProjectReplicaSource['prompts'][number]>(
          'SELECT * FROM prompts WHERE id IN',
          foreignPromptIds,
        ),
      ]);

      source.prompt_tags = this.selectIn(
        'SELECT * FROM prompt_tags WHERE prompt_id IN',
        source.prompts.map((prompt) => prompt.id),
        'ORDER BY prompt_id, tag_id',
      );
      const projectTagIds = new Set(source.tags.map((tag) => tag.id));
      const foreignTagIds = unique(
        source.prompt_tags.map((row) => row.tag_id).filter((tagId) => !projectTagIds.has(tagId)),
      );
      source.tags = sortById([
        ...source.tags,
        ...this.selectIn<ProjectReplicaSource['tags'][number]>(
          'SELECT * FROM tags WHERE id IN',
          foreignTagIds,
        ),
      ]);

      for (const scope of source.provider_env_scopes) providerIds.add(scope.provider_id);
      for (const watcher of source.terminal_watchers) {
        if (watcher.scope === 'provider' && watcher.scope_filter_id) {
          providerIds.add(watcher.scope_filter_id);
        }
      }
      for (const override of source.project_provider_plugin_overrides) {
        providerIds.add(override.provider_id);
      }

      // The provider closure is complete here: instance-level rows travel for
      // exactly these providers.
      const instanceProviderIds = [...providerIds];
      source.provider_env_scopes = this.selectIn(
        'SELECT provider_id, env_key, project_id FROM provider_env_scopes WHERE provider_id IN',
        instanceProviderIds,
        'ORDER BY provider_id, env_key, project_id',
      );
      source.provider_settings = this.selectIn(
        'SELECT id AS provider_id, auto_compact_threshold, claude_launch_settings_json FROM providers WHERE id IN',
        instanceProviderIds,
        'ORDER BY provider_id',
      );
      source.provider_models = this.selectIn(
        'SELECT * FROM provider_models WHERE provider_id IN',
        instanceProviderIds,
        'ORDER BY provider_id, position, id',
      );
      source.provider_efforts = this.selectIn(
        'SELECT * FROM provider_efforts WHERE provider_id IN',
        instanceProviderIds,
        'ORDER BY provider_id, position, id',
      );
      source.provider_plugin_defaults = this.selectIn(
        'SELECT * FROM provider_plugin_defaults WHERE provider_id IN',
        instanceProviderIds,
        'ORDER BY provider_id, plugin_id',
      );
    }

    source.providers = this.selectIn(
      'SELECT id, name, env FROM providers WHERE id IN',
      [...providerIds],
      'ORDER BY id',
    );
  }

  /**
   * Runs `<prefix> (?, ...) <suffix>` over `ids` in chunks and concatenates the
   * rows; `suffixParams` bind the suffix's placeholders.
   */
  private selectIn<T>(
    prefix: string,
    ids: readonly string[],
    suffix = '',
    suffixParams: readonly unknown[] = [],
  ): T[] {
    const rows: T[] = [];
    for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
      const chunk = ids.slice(start, start + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      rows.push(
        ...(this.rawClient
          .prepare(`${prefix} (${placeholders}) ${suffix}`)
          .all(...chunk, ...suffixParams) as T[]),
      );
    }
    return rows;
  }
}

function emptySource(readAt: string): ProjectReplicaSource {
  return {
    readAt,
    projects: [],
    workspaces: [],
    paired_device_workspace_grants: [],
    authorityKids: [],
    statuses: [],
    tags: [],
    providers: [],
    agent_profiles: [],
    profile_provider_configs: [],
    agents: [],
    epics: [],
    epic_tags: [],
    epic_comments: [],
    epic_relations: [],
    epic_time_segments: [],
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
    reviews: [],
    review_comments: [],
    provider_env_scopes: [],
    provider_settings: [],
    provider_models: [],
    provider_efforts: [],
    provider_plugin_defaults: [],
    project_provider_plugin_overrides: [],
    sender_skill_slugs: [],
    skill_project_disabled: [],
    source_project_enabled: [],
    settings: [],
    instanceSettings: defaultInstanceSettings(),
    sessions: [],
    epic_time_session_watermarks: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Settings rows store strings JSON-encoded when the writer went through `updateSettings`. */
function decodeStoredString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Not JSON encoded; the raw string is the value.
  }
  return trimmed;
}

function defaultInstanceSettings(): ReplicaInstanceSettings {
  return {
    messagePool: {
      enabled: DEFAULT_MESSAGE_POOL_ENABLED,
      delayMs: DEFAULT_MESSAGE_POOL_DELAY_MS,
      maxWaitMs: DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
      maxMessages: DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
      separator: DEFAULT_MESSAGE_POOL_SEPARATOR,
    },
    eventsEpicAssignedTemplate: DEFAULT_EPIC_ASSIGNED_TEMPLATE,
    skillsSources: {},
    activityIdleTimeoutMs: DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS,
    terminal: {
      inputMode: DEFAULT_TERMINAL_INPUT_MODE,
      scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
      seedingMaxBytes: DEFAULT_TERMINAL_SEED_MAX_BYTES,
      suppressCtrlCWithSelection: DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
    },
    skillsSyncOnStartup: DEFAULT_SKILLS_SYNC_ON_STARTUP,
    messagingFollowNote: DEFAULT_MESSAGING_FOLLOW_NOTE,
  };
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => compare(a.id, b.id));
}
