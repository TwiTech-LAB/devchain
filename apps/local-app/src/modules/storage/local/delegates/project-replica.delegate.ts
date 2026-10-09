import type {
  ProjectReplicaStorage,
  ApplyProjectReplicaStorageOptions,
  ProjectReplicaApplyMode,
  ProjectReplicaApplySummary,
} from '../../interfaces/storage.interface';
import { mergeSourceSwitches } from '../helpers/skill-source-switches';
import { SkillsSettingsDelegate } from '../../../settings/local/delegates/skills-settings.delegate';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PROJECT_REPLICA_SETTING_KEYS,
  ProjectReplicaV1Schema,
  validateClaudeLaunchSettingsJson,
  type ProjectReplicaIdSets,
  type ProjectReplicaLiveTables,
  type ProjectReplicaRow,
  type ProjectReplicaTables,
  type ProjectReplicaV1,
} from '@devchain/shared';
import { ConflictError, ReplicaApplyError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { normalizeEnvForStorage } from '../helpers/storage-helpers';
import type { PreparedEvent } from '../../../events/services/durable-event-registry.service';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProjectReplicaStorageDelegate');

export interface ProjectReplicaStorageDelegateDependencies {
  appendEvent: (event: PreparedEvent) => void;
}

type Row = Record<string, unknown>;
/** Live-tier tables are always present; the others depend on the scope. */
type Tables = ProjectReplicaLiveTables &
  Partial<Omit<ProjectReplicaTables, keyof ProjectReplicaLiveTables>>;

/**
 * Applies a `ProjectReplicaV1` with preserved IDs. Contract: parents before
 * children, deletes last, `ON CONFLICT DO UPDATE` only (epics are never deleted
 * and reinserted: `external_task_links` cascade from them). Global rows
 * (`project_id NULL`) and home-only history (sessions, open or batch segments)
 * are never deleted.
 */
export class ProjectReplicaStorageDelegate
  extends BaseStorageDelegate
  implements Pick<ProjectReplicaStorage, 'applyProjectReplica'>
{
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: ProjectReplicaStorageDelegateDependencies,
  ) {
    super(context);
  }

  async applyProjectReplica(
    replica: ProjectReplicaV1,
    mode: ProjectReplicaApplyMode,
    eventFactory: (summary: ProjectReplicaApplySummary) => PreparedEvent,
    options: ApplyProjectReplicaStorageOptions = {},
  ): Promise<ProjectReplicaApplySummary[]> {
    const parsed = ProjectReplicaV1Schema.safeParse(replica);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ReplicaApplyError('payload', issue?.path.join('.') ?? '', 'invalid payload');
    }
    return this.txRunner.runImmediateQueued(() => {
      if (options.requireNewProjects) this.assertProjectsAreNew(parsed.data);
      const summaries = new ReplicaApplyRun(this.rawClient, parsed.data, mode, options).execute();
      for (const summary of summaries) {
        this.dependencies.appendEvent(eventFactory(summary));
      }
      logger.info(
        {
          mode,
          scope: parsed.data.scope,
          projects: summaries.map(({ projectId, changedEpicIds, deletedEpicIds }) => ({
            projectId,
            changed: changedEpicIds.length,
            deleted: deletedEpicIds.length,
          })),
        },
        'Applied project replica',
      );
      return summaries;
    });
  }

  private assertProjectsAreNew(replica: ProjectReplicaV1): void {
    for (const { id } of replica.tables.projects) {
      if (this.rawClient.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) {
        throw new ConflictError('Project already exists on this instance.', {
          code: 'PROJECT_EXISTS',
          projectId: id,
        });
      }
    }
  }
}

/** One apply, run synchronously inside the owning transaction. */
class ReplicaApplyRun {
  private readonly tables: Tables;
  private readonly projectIds: string[];
  private readonly full: boolean;
  private readonly now = new Date().toISOString();
  private readonly statements = new Map<string, Database.Statement>();
  private readonly providerIdMap = new Map<string, string>();
  private readonly changedEpicIds = new Set<string>();
  private readonly skippedUnknownSkillCountByProject = new Map<string, number>();
  private readonly resolvedTagIds = new Set<string>();
  private readonly idSets: ProjectReplicaIdSets | undefined;
  private readonly keepInstanceConfig: boolean;
  private readonly frozenAt: string | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly replica: ProjectReplicaV1,
    mode: ProjectReplicaApplyMode,
    options: ApplyProjectReplicaStorageOptions,
  ) {
    this.idSets = options.idSets;
    this.keepInstanceConfig = options.keepInstanceConfig === true;
    this.frozenAt = options.frozenAt;
    this.tables = replica.tables;
    this.projectIds = replica.tables.projects.map((project) => project.id);
    this.full = mode === 'full';
  }

  execute(): ProjectReplicaApplySummary[] {
    const t = this.tables;
    this.checkWorkspaceName();
    this.mapProviders();

    this.upsertWorkspace();
    if (t.paired_device_workspace_grants !== undefined && !this.keepInstanceConfig) {
      this.applyWorkspaceGrants(t.paired_device_workspace_grants, t.authorityKids ?? []);
    }
    this.upsertAll('projects', t.projects);
    if (this.frozenAt) this.freezeProjects(this.frozenAt);
    this.applyStatuses();
    this.upsertAll('tags', t.tags);
    if (t.prompts) {
      this.upsertAll('prompts', t.prompts);
      this.reconcileJunction('prompt_tags', 'prompt_id', 'tag_id', t.prompts, t.prompt_tags ?? []);
    }
    this.applyProfiles();
    this.applyProviderConfigs();
    this.applyAgents();
    if (t.teams) this.applyTeams();
    if (t.terminal_watchers) {
      this.upsertAll(
        'terminal_watchers',
        t.terminal_watchers.map((row) => this.mapWatcher(row)),
      );
    }
    this.upsertAll('automation_subscribers', t.automation_subscribers);
    if (t.project_settings) this.applySettings(t.project_settings);
    if (t.instance_settings && !this.keepInstanceConfig)
      this.applyInstanceSettings(t.instance_settings);
    // Instance-level provider config is one-way: a host importing a project
    // takes it, while a home re-snapshot keeps its own values.
    if (!this.keepInstanceConfig) this.applyInstanceProviderConfig();
    if (t.project_provider_plugin_overrides)
      this.applyProjectPluginOverrides(t.project_provider_plugin_overrides);
    this.applyEpics();
    this.applyEpicTags();
    this.upsertAll('epic_comments', t.epic_comments, (row) => this.changedEpicIds.add(row.epic_id));
    this.applyRelations();
    // Schedules reference epics (`template_parent_epic_id`), so they follow them.
    this.upsertAll('scheduled_epics', t.scheduled_epics);
    if (t.reviews) this.applyReviews();
    if (t.skill_project_disabled && t.sender_skill_slugs) {
      this.applySkillProjectDisabled(t.skill_project_disabled, t.sender_skill_slugs);
    }
    if (t.source_project_enabled) this.applySourceProjectEnabled(t.source_project_enabled);
    this.upsertAll('epic_time_segments', t.epic_time_segments);
    if (t.sessions) this.applySessions(t.sessions);
    this.upsertAll('epic_time_session_watermarks', t.epic_time_session_watermarks, undefined, [
      'session_id',
    ]);

    const deletedEpicIds = this.deleteMissing();
    const epicProject = new Map(t.epics.map((epic) => [epic.id, epic.project_id]));
    return this.projectIds.map((projectId) => {
      return {
        projectId,
        changedEpicIds: [...this.changedEpicIds]
          .filter((id) => epicProject.get(id) === projectId)
          .sort(),
        deletedEpicIds: deletedEpicIds
          .filter((row) => row.project_id === projectId)
          .map((row) => row.id)
          .sort(),
        skippedUnknownSkillCount: this.skippedUnknownSkillCountByProject.get(projectId) ?? 0,
      };
    });
  }

  /** `frozen_at` is per instance and never in the payload; the upsert leaves it alone. */
  private freezeProjects(frozenAt: string): void {
    for (const projectId of this.projectIds) {
      this.write('projects', projectId, () =>
        this.run('UPDATE projects SET frozen_at = ? WHERE id = ?', frozenAt, projectId),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Preflight
  // ---------------------------------------------------------------------------

  private applyWorkspaceGrants(
    rows: ProjectReplicaRow<'paired_device_workspace_grants'>[],
    authorityKids: string[],
  ): void {
    const workspaceId = this.replica.workspace.id;
    this.write('paired_device_workspace_grants', workspaceId, () => {
      let changed = 0;
      const incoming = new Set(rows.map((row) => row.device_kid));
      const remove = this.db.prepare(
        'DELETE FROM paired_device_workspace_grants WHERE device_kid = ? AND workspace_id = ?',
      );
      // A VM-only device is outside home's authority, even in the same workspace.
      for (const kid of authorityKids) {
        if (!incoming.has(kid)) changed += remove.run(kid, workspaceId).changes;
      }
      const insert = this.db.prepare(
        'INSERT INTO paired_device_workspace_grants (device_kid, workspace_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      );
      for (const row of rows) changed += insert.run(row.device_kid, workspaceId).changes;
      return changed;
    });
  }

  private checkWorkspaceName(): void {
    const { id, name } = this.replica.workspace;
    const clash = this.get<{ id: string }>(
      'SELECT id FROM project_workspaces WHERE lower(name) = lower(?) AND id != ?',
      name,
      id,
    );
    if (clash) {
      throw new ReplicaApplyError(
        'project_workspaces',
        id,
        `workspace name is already used by workspace ${clash.id}`,
      );
    }
  }

  private mapProviders(): void {
    for (const provider of this.tables.providers ?? []) {
      const target = this.get<{ id: string }>(
        'SELECT id FROM providers WHERE name = ?',
        provider.name,
      );
      if (!target) {
        throw new ReplicaApplyError(
          'providers',
          provider.id,
          `provider "${provider.name}" is not installed`,
        );
      }
      this.providerIdMap.set(provider.id, target.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Upserts
  // ---------------------------------------------------------------------------

  private upsertWorkspace(): void {
    const { id, name } = this.replica.workspace;
    this.write('project_workspaces', id, () =>
      this.run(
        `INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
         VALUES (?, ?, 0, (SELECT COALESCE(MAX(position) + 1, 0) FROM project_workspaces), ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
         WHERE project_workspaces.name IS NOT excluded.name`,
        id,
        name,
        this.now,
        this.now,
      ),
    );
  }

  /**
   * Unique `(project_id, position)`: parking every project status first lets
   * swapped positions land without a transient collision.
   */
  private applyStatuses(): void {
    this.inProjects('UPDATE statuses SET position = -rowid - 1 WHERE project_id IN');
    this.upsertAll('statuses', this.tables.statuses);
  }

  /** Unique `(project_id, name)` and `(project_id, family_slug)`; global rows never collide. */
  private applyProfiles(): void {
    this.inProjects(
      'UPDATE agent_profiles SET name = name || char(0) || id, family_slug = NULL WHERE project_id IN',
    );
    const profiles = this.tables.agent_profiles ?? [];
    this.upsertAll('agent_profiles', profiles);
    if (this.tables.agent_profile_prompts) {
      this.reconcileJunction(
        'agent_profile_prompts',
        'profile_id',
        'prompt_id',
        profiles,
        this.tables.agent_profile_prompts,
      );
    }
  }

  /**
   * Unique `(profile_id, position)` and `(profile_id, name)`. Parks the payload's
   * configs plus every config of a project-owned profile (those left over are
   * deleted later); configs of global profiles that the payload omits stay put.
   */
  private applyProviderConfigs(): void {
    const configs = this.tables.profile_provider_configs ?? [];
    const payloadIds = configs.map((config) => config.id);
    const park =
      'UPDATE profile_provider_configs SET position = -rowid - 1, name = name || char(0) || id WHERE ';
    this.inIds(`${park}id IN`, payloadIds);
    this.inProjects(`${park}profile_id IN (SELECT id FROM agent_profiles WHERE project_id IN`, ')');
    this.upsertAll(
      'profile_provider_configs',
      configs.map((config) => ({ ...config, provider_id: this.targetProviderId(config) })),
    );
  }

  /** Partial unique index: one project owner per project. */
  private applyAgents(): void {
    this.inProjects('UPDATE agents SET is_project_owner = 0 WHERE project_id IN');
    this.upsertAll('agents', this.tables.agents);
  }

  private applyTeams(): void {
    const teams = this.tables.teams ?? [];
    this.inProjects('UPDATE teams SET name = name || char(0) || id WHERE project_id IN');
    this.upsertAll('teams', teams);
    const teamIds = new Set(teams.map((team) => team.id));

    // team_profile_configs references team_profiles, so it is trimmed first and filled last.
    const configs = this.tables.team_profile_configs ?? [];
    const keep = new Set(
      configs.map((row) => `${row.team_id}|${row.profile_id}|${row.provider_config_id}`),
    );
    for (const row of this.inIdsAll<{
      team_id: string;
      profile_id: string;
      provider_config_id: string;
    }>(
      'SELECT team_id, profile_id, provider_config_id FROM team_profile_configs WHERE team_id IN',
      [...teamIds],
    )) {
      if (!keep.has(`${row.team_id}|${row.profile_id}|${row.provider_config_id}`)) {
        this.write('team_profile_configs', row.team_id, () =>
          this.run(
            'DELETE FROM team_profile_configs WHERE team_id = ? AND profile_id = ? AND provider_config_id = ?',
            row.team_id,
            row.profile_id,
            row.provider_config_id,
          ),
        );
      }
    }
    this.reconcileTeamPairs(
      'team_profiles',
      'profile_id',
      teamIds,
      this.tables.team_profiles ?? [],
    );
    this.reconcileTeamPairs('team_members', 'agent_id', teamIds, this.tables.team_members ?? []);
    this.upsertAll('team_profile_configs', configs, undefined, [
      'team_id',
      'profile_id',
      'provider_config_id',
    ]);
  }

  private reconcileTeamPairs<C extends 'profile_id' | 'agent_id'>(
    table: 'team_profiles' | 'team_members',
    column: C,
    teamIds: Set<string>,
    rows: Array<{ team_id: string; created_at: string } & Record<C, string>>,
  ): void {
    const keep = new Set(rows.map((row) => `${row.team_id}|${row[column]}`));
    for (const row of this.inIdsAll<Row & { team_id: string }>(
      `SELECT team_id, ${column} FROM ${table} WHERE team_id IN`,
      [...teamIds],
    )) {
      const other = String(row[column]);
      if (!keep.has(`${row.team_id}|${other}`)) {
        this.write(table, row.team_id, () =>
          this.run(`DELETE FROM ${table} WHERE team_id = ? AND ${column} = ?`, row.team_id, other),
        );
      }
    }
    this.upsertAll(table, rows, undefined, ['team_id', column]);
  }

  private mapWatcher(
    row: ProjectReplicaRow<'terminal_watchers'>,
  ): ProjectReplicaRow<'terminal_watchers'> {
    if (row.scope !== 'provider' || !row.scope_filter_id) return row;
    return {
      ...row,
      scope_filter_id: this.providerIdMap.get(row.scope_filter_id) ?? row.scope_filter_id,
    };
  }

  /** Sets this project's slice of each project-keyed settings map. */
  private applySettings(entries: ProjectReplicaTables['project_settings']): void {
    for (const key of PROJECT_REPLICA_SETTING_KEYS) {
      const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
      let map: Record<string, unknown> = {};
      if (row) {
        const parsed = parseJsonObject(row.value);
        if (!parsed)
          throw new ReplicaApplyError('settings', key, 'stored value is not a JSON object');
        map = parsed;
      }
      const next = { ...map };
      for (const projectId of this.projectIds) {
        const entry = entries.find((item) => item.project_id === projectId && item.key === key);
        if (entry) next[projectId] = entry.value;
        else delete next[projectId];
      }
      const encoded = JSON.stringify(next);
      // Nothing to write: the stored slice already matches, or there is no row and no slice.
      const unchanged = row ? encoded === JSON.stringify(map) : Object.keys(next).length === 0;
      if (unchanged) continue;
      this.write('settings', key, () =>
        this.run(
          `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          randomUUID(),
          key,
          encoded,
          this.now,
          this.now,
        ),
      );
    }
  }

  /**
   * Applies the sender's effective global settings, merging source switches
   * while preserving host-only sources, in the encodings the settings writers use,
   * so every reader decodes them unchanged. Re-applying identical values
   * writes nothing (a resnapshot without `keepInstanceConfig` is still a no-op).
   */
  private applyInstanceSettings(settings: ProjectReplicaTables['instance_settings']): void {
    const entries: Array<[string, string]> = [
      ['messagePool.enabled', String(settings.messagePool.enabled)],
      ['messagePool.delayMs', String(settings.messagePool.delayMs)],
      ['messagePool.maxWaitMs', String(settings.messagePool.maxWaitMs)],
      ['messagePool.maxMessages', String(settings.messagePool.maxMessages)],
      ['messagePool.separator', JSON.stringify(settings.messagePool.separator)],
      ['events.epicAssigned.template', JSON.stringify(settings.eventsEpicAssignedTemplate)],
      [
        'skills.sources',
        // The stored map (always-enabled keys kept) keeps the merged JSON stable across re-applies.
        JSON.stringify(
          mergeSourceSwitches(
            settings.skillsSources,
            new SkillsSettingsDelegate({ sqlite: this.db }).getStoredSkillSourcesEnabled(),
          ),
        ),
      ],
      ['activity.idleTimeoutMs', String(settings.activityIdleTimeoutMs)],
      ['terminal.scrollback.lines', String(settings.terminal.scrollbackLines)],
      ['terminal.seeding.maxBytes', String(settings.terminal.seedingMaxBytes)],
      // The settings writer stores inputMode as the raw string, not JSON-encoded.
      ['terminal.inputMode', settings.terminal.inputMode],
      ['terminal.suppressCtrlCWithSelection', String(settings.terminal.suppressCtrlCWithSelection)],
      ['skills.syncOnStartup', String(settings.skillsSyncOnStartup)],
      ['messaging.followNote', String(settings.messagingFollowNote)],
    ];
    for (const [key, value] of entries) {
      const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
      if (row?.value === value) continue;
      this.write('settings', key, () =>
        this.run(
          `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          randomUUID(),
          key,
          value,
          this.now,
          this.now,
        ),
      );
    }
  }

  private applySkillProjectDisabled(
    entries: ProjectReplicaTables['skill_project_disabled'],
    senderSkillSlugs: readonly string[],
  ): void {
    const keep = new Set<string>();
    const senderSkills = new Set(senderSkillSlugs);
    for (const entry of entries) {
      const skill = this.get<{ id: string }>(
        'SELECT id FROM skills WHERE slug = ?',
        entry.skill_slug,
      );
      if (!skill) {
        this.skippedUnknownSkillCountByProject.set(
          entry.project_id,
          (this.skippedUnknownSkillCountByProject.get(entry.project_id) ?? 0) + 1,
        );
        continue;
      }

      keep.add(`${entry.project_id}\0${skill.id}`);
      const id = this.localSwitchId(
        'skill_project_disabled',
        entry.project_id,
        'skill_id',
        skill.id,
        entry.id,
      );
      this.upsertAll(
        'skill_project_disabled',
        [{ id, project_id: entry.project_id, skill_id: skill.id, created_at: entry.created_at }],
        undefined,
        ['project_id', 'skill_id'],
      );
    }

    for (const row of this.inProjectsAll<{
      id: string;
      project_id: string;
      skill_id: string;
      skill_slug: string;
    }>(`SELECT disabled.id, disabled.project_id, disabled.skill_id, skill.slug AS skill_slug
        FROM skill_project_disabled disabled
        JOIN skills skill ON skill.id = disabled.skill_id
        WHERE project_id IN`)) {
      if (senderSkills.has(row.skill_slug) && !keep.has(`${row.project_id}\0${row.skill_id}`)) {
        this.write('skill_project_disabled', row.id, () =>
          this.run('DELETE FROM skill_project_disabled WHERE id = ?', row.id),
        );
      }
    }
  }

  private applySourceProjectEnabled(entries: ProjectReplicaTables['source_project_enabled']): void {
    const keep = new Set<string>();
    for (const entry of entries) {
      keep.add(`${entry.project_id}\0${entry.source_name}`);
      const id = this.localSwitchId(
        'source_project_enabled',
        entry.project_id,
        'source_name',
        entry.source_name,
        entry.id,
      );
      this.upsertAll('source_project_enabled', [{ ...entry, id }], undefined, [
        'project_id',
        'source_name',
      ]);
    }

    for (const row of this.inProjectsAll<{
      id: string;
      project_id: string;
      source_name: string;
    }>('SELECT id, project_id, source_name FROM source_project_enabled WHERE project_id IN')) {
      if (!keep.has(`${row.project_id}\0${row.source_name}`)) {
        this.write('source_project_enabled', row.id, () =>
          this.run('DELETE FROM source_project_enabled WHERE id = ?', row.id),
        );
      }
    }
  }

  private localSwitchId(
    table: 'skill_project_disabled' | 'source_project_enabled',
    projectId: string,
    keyColumn: 'skill_id' | 'source_name',
    keyValue: string,
    replicaId: string,
  ): string {
    const existing = this.get<{ id: string }>(
      `SELECT id FROM ${table} WHERE project_id = ? AND ${keyColumn} = ?`,
      projectId,
      keyValue,
    );
    if (existing) return existing.id;

    return this.get<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, replicaId)
      ? randomUUID()
      : replicaId;
  }

  private reconcileProviderEnv(rows: ProjectReplicaTables['provider_settings']): void {
    // Every project on the VM, not only this replica's (`this.projectIds`).
    const vmProjectIds = new Set(
      this.all<{ id: string }>('SELECT id FROM projects').map((row) => row.id),
    );
    for (const row of rows) {
      const provider = this.providerIdByName(row.providerName);
      const env: Record<string, string> = Object.create(null);
      const retainedScopes = new Map<string, Set<string>>();
      for (const [key, value] of Object.entries(row.env ?? {})) {
        const homeScopes = Object.hasOwn(row.envScopes, key) ? row.envScopes[key] : [];
        const scopes = new Set(homeScopes.filter((id) => vmProjectIds.has(id)));
        // A scoped key must never become global when its projects are absent.
        if (homeScopes.length > 0 && scopes.size === 0) continue;
        env[key] = value;
        retainedScopes.set(key, scopes);
        for (const projectId of scopes) {
          this.write('provider_env_scopes', `${provider.id}:${key}`, () =>
            this.run(
              'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
              provider.id,
              key,
              projectId,
              this.now,
            ),
          );
        }
      }
      for (const scope of this.all<{ env_key: string; project_id: string }>(
        'SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ?',
        provider.id,
      )) {
        if (retainedScopes.get(scope.env_key)?.has(scope.project_id)) continue;
        this.write('provider_env_scopes', `${provider.id}:${scope.env_key}`, () =>
          this.run(
            'DELETE FROM provider_env_scopes WHERE provider_id = ? AND env_key = ? AND project_id = ?',
            provider.id,
            scope.env_key,
            scope.project_id,
          ),
        );
      }
      const envJson = normalizeEnvForStorage(env);
      this.write('providers', provider.id, () =>
        this.run(
          'UPDATE providers SET env = ?, updated_at = ? WHERE id = ? AND env IS NOT ?',
          envJson,
          this.now,
          provider.id,
          envJson,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Instance-level provider config (attach imports only, never a re-snapshot)
  // ---------------------------------------------------------------------------

  private applyInstanceProviderConfig(): void {
    if (this.tables.provider_settings) {
      this.applyProviderSettings(this.tables.provider_settings);
      this.reconcileProviderEnv(this.tables.provider_settings);
    }
    if (this.tables.provider_models) {
      this.applyProviderCatalog('provider_models', this.tables.provider_models);
    }
    if (this.tables.provider_efforts) {
      this.applyProviderCatalog('provider_efforts', this.tables.provider_efforts);
    }
    if (this.tables.provider_plugin_defaults) {
      this.applyProviderPluginDefaults(this.tables.provider_plugin_defaults);
    }
  }

  /** Home is authoritative: both scalars overwrite, an explicit null included. */
  private applyProviderSettings(rows: ProjectReplicaTables['provider_settings']): void {
    for (const row of rows) {
      const provider = this.providerIdByName(row.providerName);
      const current = this.get<{
        auto_compact_threshold: number | null;
        claude_launch_settings_json: string | null;
      }>(
        'SELECT auto_compact_threshold, claude_launch_settings_json FROM providers WHERE id = ?',
        provider.id,
      );
      if (!current) {
        throw new ReplicaApplyError('providers', provider.id, 'provider row is missing');
      }
      const invalidLaunch =
        row.claude_launch_settings_json !== null &&
        !validateClaudeLaunchSettingsJson(row.claude_launch_settings_json).valid;
      if (invalidLaunch) {
        logger.warn(
          { provider: row.providerName },
          'Skipped invalid Claude launch settings JSON from replica',
        );
      }
      const launchToStore = invalidLaunch
        ? current.claude_launch_settings_json
        : row.claude_launch_settings_json;
      if (
        row.auto_compact_threshold === current.auto_compact_threshold &&
        launchToStore === current.claude_launch_settings_json
      ) {
        continue;
      }
      this.write('providers', provider.id, () =>
        this.run(
          'UPDATE providers SET auto_compact_threshold = ?, claude_launch_settings_json = ?, updated_at = ? WHERE id = ?',
          row.auto_compact_threshold,
          launchToStore,
          this.now,
          provider.id,
        ),
      );
    }
  }

  /**
   * Additive merge on the case-insensitive name indexes: existing rows and
   * their positions stay; new rows append at `MAX(position) + 1` per provider
   * in payload order.
   */
  private applyProviderCatalog(
    table: 'provider_models' | 'provider_efforts',
    rows: ProjectReplicaTables['provider_models'],
  ): void {
    for (const row of rows) {
      const provider = this.providerIdByName(row.providerName);
      this.write(table, `${provider.id}:${row.name}`, () =>
        this.run(
          `INSERT INTO ${table} (id, provider_id, name, position, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM ${table} WHERE provider_id = ?), ?, ?)
           ON CONFLICT DO NOTHING`,
          randomUUID(),
          provider.id,
          row.name,
          provider.id,
          row.created_at,
          this.now,
        ),
      );
    }
  }

  /** Full reconcile: for every payload provider, the defaults become the payload's exact set. */
  private applyProviderPluginDefaults(
    rows: ProjectReplicaTables['provider_plugin_defaults'],
  ): void {
    const byProvider = new Map<string, { id: string; plugins: Set<string> }>();
    for (const provider of this.tables.providers) {
      const targetId = this.providerIdMap.get(provider.id);
      if (targetId) byProvider.set(provider.name, { id: targetId, plugins: new Set() });
    }
    for (const row of rows) {
      const entry = byProvider.get(row.providerName);
      if (!entry) {
        throw new ReplicaApplyError(
          'provider_plugin_defaults',
          row.providerName,
          'provider is not in the payload',
        );
      }
      entry.plugins.add(row.plugin_id);
      this.upsertAll(
        'provider_plugin_defaults',
        [
          {
            provider_id: entry.id,
            plugin_id: row.plugin_id,
            enabled: row.enabled,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        ],
        undefined,
        ['provider_id', 'plugin_id'],
      );
    }
    for (const [providerName, entry] of byProvider) {
      for (const { plugin_id } of this.all<{ plugin_id: string }>(
        'SELECT plugin_id FROM provider_plugin_defaults WHERE provider_id = ?',
        entry.id,
      )) {
        if (!entry.plugins.has(plugin_id)) {
          this.write('provider_plugin_defaults', `${providerName}:${plugin_id}`, () =>
            this.run(
              'DELETE FROM provider_plugin_defaults WHERE provider_id = ? AND plugin_id = ?',
              entry.id,
              plugin_id,
            ),
          );
        }
      }
    }
  }

  private providerIdByName(providerName: string): { id: string } {
    const provider = this.get<{ id: string }>(
      'SELECT id FROM providers WHERE name = ?',
      providerName,
    );
    if (!provider) {
      throw new ReplicaApplyError('providers', providerName, 'provider is not installed');
    }
    return provider;
  }

  /** Project plugin policy travels with the project; the provider is remapped by name. */
  private applyProjectPluginOverrides(
    rows: ProjectReplicaTables['project_provider_plugin_overrides'],
  ): void {
    this.upsertAll(
      'project_provider_plugin_overrides',
      rows.map((row) => {
        const target = this.providerIdMap.get(row.provider_id);
        if (!target) {
          throw new ReplicaApplyError(
            'project_provider_plugin_overrides',
            `${row.project_id}:${row.plugin_id}`,
            'provider is not in the payload',
          );
        }
        return { ...row, provider_id: target };
      }),
      undefined,
      ['project_id', 'provider_id', 'plugin_id'],
    );
  }

  private applyEpics(): void {
    this.upsertAll('epics', parentsFirst(this.tables.epics, 'parent_id'), (row) =>
      this.changedEpicIds.add(row.id),
    );
  }

  /** Epic tags travel by name; each payload epic's tag set is complete. */
  private applyEpicTags(): void {
    const payloadTags = this.tables.tags;
    const wanted = new Map<string, Map<string, string>>();
    for (const epic of this.tables.epics) wanted.set(epic.id, new Map());
    const projectOf = new Map(this.tables.epics.map((epic) => [epic.id, epic.project_id]));

    for (const entry of this.tables.epic_tags) {
      const projectId = projectOf.get(entry.epic_id);
      if (!projectId) {
        throw new ReplicaApplyError('epic_tags', entry.epic_id, 'epic is not in the payload');
      }
      const tagId = this.resolveTagId(entry.tag_name, projectId, payloadTags);
      wanted.get(entry.epic_id)?.set(tagId, entry.created_at);
    }

    for (const [epicId, tags] of wanted) {
      const existing = this.all<{ tag_id: string }>(
        'SELECT tag_id FROM epic_tags WHERE epic_id = ?',
        epicId,
      ).map((row) => row.tag_id);
      let changed = false;
      for (const tagId of existing) {
        if (!tags.has(tagId)) {
          this.write('epic_tags', epicId, () =>
            this.run('DELETE FROM epic_tags WHERE epic_id = ? AND tag_id = ?', epicId, tagId),
          );
          changed = true;
        }
      }
      for (const [tagId, createdAt] of tags) {
        if (!existing.includes(tagId)) {
          this.write('epic_tags', epicId, () =>
            this.run(
              'INSERT INTO epic_tags (epic_id, tag_id, created_at) VALUES (?, ?, ?)',
              epicId,
              tagId,
              createdAt,
            ),
          );
          changed = true;
        }
      }
      if (changed) this.changedEpicIds.add(epicId);
    }
  }

  /** Same precedence as epic tag writes: a project tag, then a global tag, else a new project tag. */
  private resolveTagId(
    name: string,
    projectId: string,
    payloadTags: ProjectReplicaTables['tags'],
  ): string {
    const fromPayload =
      payloadTags.find((tag) => tag.name === name && tag.project_id === projectId) ??
      payloadTags.find((tag) => tag.name === name && tag.project_id === null);
    const found =
      fromPayload?.id ??
      this.get<{ id: string }>(
        `SELECT id FROM tags WHERE name = ? AND (project_id = ? OR project_id IS NULL)
         ORDER BY project_id IS NULL, id LIMIT 1`,
        name,
        projectId,
      )?.id;
    if (found) {
      this.resolvedTagIds.add(found);
      return found;
    }
    const id = randomUUID();
    this.write('tags', id, () =>
      this.run(
        'INSERT INTO tags (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        id,
        projectId,
        name,
        this.now,
        this.now,
      ),
    );
    this.resolvedTagIds.add(id);
    return id;
  }

  /** A pair can be re-created on the host under a new ID; the unique pair index would reject it. */
  private applyRelations(): void {
    for (const relation of this.tables.epic_relations) {
      const stale = this.get<{ id: string }>(
        'SELECT id FROM epic_relations WHERE left_epic_id = ? AND right_epic_id = ? AND id != ?',
        relation.left_epic_id,
        relation.right_epic_id,
        relation.id,
      );
      if (stale) {
        this.write('epic_relations', stale.id, () =>
          this.run('DELETE FROM epic_relations WHERE id = ?', stale.id),
        );
      }
    }
    this.upsertAll('epic_relations', this.tables.epic_relations);
  }

  /** Partial unique index: one non-closed review per project. */
  private applyReviews(): void {
    this.inProjects(
      "UPDATE reviews SET status = 'closed' WHERE status != 'closed' AND project_id IN",
    );
    this.upsertAll('reviews', this.tables.reviews);
    this.upsertAll('review_comments', parentsFirst(this.tables.review_comments ?? [], 'parent_id'));
  }

  /**
   * A session can point at an epic of another project; that link cannot travel.
   * A missing local epic drops the incoming link, and a null incoming epic
   * preserves a local link to an epic outside the payload — the copy never
   * carried it, so overwriting with null would erase it after a round trip.
   */
  private applySessions(sessions: ProjectReplicaTables['sessions']): void {
    const payloadProjects = this.projectIds.map(() => '?').join(', ');
    this.upsertAll(
      'sessions',
      sessions.map((session) => {
        if (session.epic_id) {
          return this.get('SELECT 1 FROM epics WHERE id = ?', session.epic_id)
            ? session
            : { ...session, epic_id: null };
        }
        const kept = this.get<{ epic_id: string }>(
          `SELECT s.epic_id FROM sessions s JOIN epics e ON e.id = s.epic_id
           WHERE s.id = ? AND e.project_id NOT IN (${payloadProjects})`,
          session.id,
          ...this.projectIds,
        );
        return kept ? { ...session, epic_id: kept.epic_id } : session;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Deletes (children first)
  // ---------------------------------------------------------------------------

  private deleteMissing(): Array<{ id: string; project_id: string }> {
    const t = this.tables;
    const ids = <T extends { id: string }>(rows: T[] | undefined) =>
      new Set((rows ?? []).map((row) => row.id));
    // The rows to keep of a table a live payload carries only partially: the
    // payload itself in full mode, the host's complete ID set when one came with it.
    const keepOf = <T extends { id: string }>(
      rows: T[] | undefined,
      table: 'epics' | 'epic_comments' | 'epic_time_segments',
    ): Set<string> | null => {
      if (this.full) return ids(rows);
      if (!this.idSets) return null;
      return new Set([...this.idSets[table], ...ids(rows)]);
    };

    const keepSegments = keepOf(t.epic_time_segments, 'epic_time_segments');
    if (keepSegments) {
      this.deleteNotIn(
        'epic_time_segments',
        `SELECT id FROM epic_time_segments
         WHERE closed_at IS NOT NULL AND team_batch_id IS NULL AND project_id IN`,
        keepSegments,
      );
    }
    if (t.review_comments) {
      this.deleteNotIn(
        'review_comments',
        'SELECT c.id FROM review_comments c JOIN reviews r ON r.id = c.review_id WHERE r.project_id IN',
        ids(t.review_comments),
      );
    }
    if (t.reviews)
      this.deleteNotIn('reviews', 'SELECT id FROM reviews WHERE project_id IN', ids(t.reviews));
    if (t.scheduled_epics) {
      this.deleteNotIn(
        'scheduled_epics',
        'SELECT id FROM scheduled_epics WHERE project_id IN',
        ids(t.scheduled_epics),
      );
    }
    // Relations to projects outside the payload are not carried, so they are kept.
    const placeholders = this.projectIds.map(() => '?').join(', ');
    this.deleteNotIn(
      'epic_relations',
      `SELECT r.id FROM epic_relations r
       JOIN epics le ON le.id = r.left_epic_id
       JOIN epics re ON re.id = r.right_epic_id
       WHERE le.project_id IN (${placeholders}) AND re.project_id IN`,
      ids(t.epic_relations),
      this.projectIds,
    );

    let deletedEpics: Array<{ id: string; project_id: string }> = [];
    const keepComments = keepOf(t.epic_comments, 'epic_comments');
    const keep = keepOf(t.epics, 'epics');
    if (keepComments && keep) {
      this.deleteNotIn(
        'epic_comments',
        'SELECT c.id FROM epic_comments c JOIN epics e ON e.id = c.epic_id WHERE e.project_id IN',
        keepComments,
      );
      deletedEpics = this.inProjectsAll<{ id: string; project_id: string }>(
        'SELECT id, project_id FROM epics WHERE project_id IN',
      ).filter((row) => !keep.has(row.id));
      for (const row of deletedEpics) {
        this.write('epics', row.id, () => this.run('DELETE FROM epics WHERE id = ?', row.id));
      }
    }

    if (t.automation_subscribers) {
      this.deleteNotIn(
        'automation_subscribers',
        'SELECT id FROM automation_subscribers WHERE project_id IN',
        ids(t.automation_subscribers),
      );
    }
    if (t.terminal_watchers) {
      this.deleteNotIn(
        'terminal_watchers',
        'SELECT id FROM terminal_watchers WHERE project_id IN',
        ids(t.terminal_watchers),
      );
    }
    if (t.teams)
      this.deleteNotIn('teams', 'SELECT id FROM teams WHERE project_id IN', ids(t.teams));

    if (t.project_provider_plugin_overrides) {
      this.deleteMissingPluginOverrides(t.project_provider_plugin_overrides);
    }

    this.deleteAgents(ids(t.agents));
    this.deleteNotIn(
      'profile_provider_configs',
      `SELECT c.id FROM profile_provider_configs c
       JOIN agent_profiles p ON p.id = c.profile_id WHERE p.project_id IN`,
      ids(t.profile_provider_configs),
    );
    this.deleteNotIn(
      'agent_profiles',
      'SELECT id FROM agent_profiles WHERE project_id IN',
      ids(t.agent_profiles),
    );
    if (t.prompts)
      this.deleteNotIn('prompts', 'SELECT id FROM prompts WHERE project_id IN', ids(t.prompts));
    this.deleteNotIn(
      'tags',
      'SELECT id FROM tags WHERE project_id IN',
      new Set([...ids(t.tags), ...this.resolvedTagIds]),
    );
    this.deleteNotIn('statuses', 'SELECT id FROM statuses WHERE project_id IN', ids(t.statuses));
    return deletedEpics;
  }

  /**
   * The payload carries the project's complete override set (the sender's
   * provider IDs, so keys compare after remapping); a row it omits resets to
   * inherit, which must survive a disconnect.
   */
  private deleteMissingPluginOverrides(
    rows: ProjectReplicaTables['project_provider_plugin_overrides'],
  ): void {
    const keep = new Set(
      rows.map(
        (row) =>
          `${row.project_id}|${this.providerIdMap.get(row.provider_id) ?? row.provider_id}|${row.plugin_id}`,
      ),
    );
    for (const row of this.inProjectsAll<{
      project_id: string;
      provider_id: string;
      plugin_id: string;
    }>(
      'SELECT project_id, provider_id, plugin_id FROM project_provider_plugin_overrides WHERE project_id IN',
    )) {
      if (keep.has(`${row.project_id}|${row.provider_id}|${row.plugin_id}`)) continue;
      this.write(
        'project_provider_plugin_overrides',
        `${row.project_id}:${row.provider_id}:${row.plugin_id}`,
        () =>
          this.run(
            'DELETE FROM project_provider_plugin_overrides WHERE project_id = ? AND provider_id = ? AND plugin_id = ?',
            row.project_id,
            row.provider_id,
            row.plugin_id,
          ),
      );
    }
  }

  /** `sessions.agent_id` is RESTRICT: an agent's home sessions go before the agent. */
  private deleteAgents(keep: Set<string>): void {
    const gone = this.inProjectsAll<{ id: string }>('SELECT id FROM agents WHERE project_id IN')
      .map((row) => row.id)
      .filter((id) => !keep.has(id));
    for (const agentId of gone) {
      this.write('sessions', agentId, () =>
        this.run('DELETE FROM sessions WHERE agent_id = ?', agentId),
      );
      this.write('agents', agentId, () => this.run('DELETE FROM agents WHERE id = ?', agentId));
    }
  }

  /** Deletes the rows `select` returns (first column `id`) that `keep` does not hold. */
  private deleteNotIn(
    table: string,
    select: string,
    keep: Set<string>,
    leadingParams: readonly string[] = [],
  ): void {
    const rows = this.all<{ id: string }>(
      `${select} (${this.projectIds.map(() => '?').join(', ')})`,
      ...leadingParams,
      ...this.projectIds,
    );
    for (const { id } of rows) {
      if (!keep.has(id)) {
        this.write(table, id, () => this.run(`DELETE FROM ${table} WHERE id = ?`, id));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private targetProviderId(config: ProjectReplicaRow<'profile_provider_configs'>): string {
    const target = this.providerIdMap.get(config.provider_id);
    if (!target) {
      throw new ReplicaApplyError(
        'profile_provider_configs',
        config.id,
        'provider is not in the payload',
      );
    }
    return target;
  }

  /**
   * Replaces the junction rows of each parent with the payload's set. These
   * tables have no unique key, so `ON CONFLICT` has nothing to target.
   */
  private reconcileJunction(
    table: 'prompt_tags' | 'agent_profile_prompts',
    parentColumn: 'prompt_id' | 'profile_id',
    childColumn: 'tag_id' | 'prompt_id',
    parents: Array<{ id: string }>,
    rows: Row[],
  ): void {
    const wanted = new Map<string, Map<string, unknown>>();
    for (const parent of parents) wanted.set(parent.id, new Map());
    for (const row of rows) {
      wanted.get(String(row[parentColumn]))?.set(String(row[childColumn]), row.created_at);
    }
    for (const [parentId, children] of wanted) {
      const existing = this.all<Row>(
        `SELECT ${childColumn} FROM ${table} WHERE ${parentColumn} = ?`,
        parentId,
      ).map((row) => String(row[childColumn]));
      for (const childId of existing) {
        if (!children.has(childId)) {
          this.write(table, parentId, () =>
            this.run(
              `DELETE FROM ${table} WHERE ${parentColumn} = ? AND ${childColumn} = ?`,
              parentId,
              childId,
            ),
          );
        }
      }
      for (const [childId, createdAt] of children) {
        if (!existing.includes(childId)) {
          this.write(table, parentId, () =>
            this.run(
              `INSERT INTO ${table} (${parentColumn}, ${childColumn}, created_at) VALUES (?, ?, ?)`,
              parentId,
              childId,
              createdAt,
            ),
          );
        }
      }
    }
  }

  /**
   * `INSERT ... ON CONFLICT DO UPDATE` that writes only when a column differs,
   * so re-applying an identical payload changes nothing. Column names come from
   * the strict payload schema.
   */
  private upsertAll<T extends Row>(
    table: string,
    rows: T[] | undefined,
    onChange?: (row: T) => void,
    key: readonly string[] = ['id'],
  ): void {
    for (const row of rows ?? []) {
      const columns = Object.keys(row);
      const update = columns.filter((column) => !key.includes(column));
      const conflict = update.length
        ? `DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(', ')}
           WHERE (${update.map((c) => `${table}.${c}`).join(', ')}) IS NOT (${update
             .map((c) => `excluded.${c}`)
             .join(', ')})`
        : 'DO NOTHING';
      const sql = `INSERT INTO ${table} (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
        ON CONFLICT(${key.join(', ')}) ${conflict}`;
      const rowId = key.map((column) => String(row[column])).join(':');
      const changes = this.write(table, rowId, () =>
        this.run(sql, ...columns.map((column) => row[column])),
      );
      if (changes > 0) onChange?.(row);
    }
  }

  private inProjects(sqlPrefix: string, suffix = ''): void {
    this.inIds(sqlPrefix, this.projectIds, suffix);
  }

  private inIds(sqlPrefix: string, ids: readonly string[], suffix = ''): void {
    if (ids.length === 0) return;
    this.write(tableOf(sqlPrefix), 'park', () =>
      this.run(`${sqlPrefix} (${ids.map(() => '?').join(', ')})${suffix}`, ...ids),
    );
  }

  private inProjectsAll<T>(sqlPrefix: string): T[] {
    return this.inIdsAll<T>(sqlPrefix, this.projectIds);
  }

  private inIdsAll<T>(sqlPrefix: string, ids: readonly string[]): T[] {
    if (ids.length === 0) return [];
    return this.all<T>(`${sqlPrefix} (${ids.map(() => '?').join(', ')})`, ...ids);
  }

  private write(table: string, rowId: string, fn: () => number): number {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ReplicaApplyError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ReplicaApplyError(table, rowId, reason);
    }
  }

  private run(sql: string, ...params: unknown[]): number {
    return this.statement(sql).run(...params).changes;
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

/** Orders rows so each row follows its parent when the parent is in the same list. */
function parentsFirst<T extends { id: string }>(rows: T[], parentKey: keyof T): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (row: T): void => {
    if (state.get(row.id)) return;
    state.set(row.id, 'visiting');
    const parentId = row[parentKey];
    const parent = typeof parentId === 'string' ? byId.get(parentId) : undefined;
    if (parent) visit(parent);
    state.set(row.id, 'done');
    ordered.push(row);
  };
  rows.forEach(visit);
  return ordered;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tableOf(sql: string): string {
  return /^UPDATE\s+(\w+)/i.exec(sql)?.[1] ?? 'unknown';
}
