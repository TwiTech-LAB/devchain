import { Injectable } from '@nestjs/common';
import {
  PROJECT_REPLICA_VERSION,
  ProjectReplicaV1Schema,
  type ProjectReplicaAttachTables,
  type ProjectReplicaIdSets,
  type ProjectReplicaDetachTables,
  type ProjectReplicaLiveTables,
  type ProjectReplicaOfScope,
  type ProjectReplicaPreflightError,
  type ProjectReplicaRow,
  type ProjectReplicaScope,
  type ProjectReplicaSettingKey,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type {
  ProjectReplicaSource,
  ProjectReplicaStorage,
} from '../../storage/interfaces/storage.interface';

const logger = createLogger('ProjectReplicaBuilder');

export interface BuildProjectReplicaRequest<S extends ProjectReplicaScope> {
  projectIds: readonly [string, ...string[]];
  scope: S;
  /**
   * Provider names on the receiving instance. When given, every provider the
   * replica references must match one by name.
   */
  targetProviderNames?: readonly string[];
  /** Live changes feed: only epics (and segments) changed after this ISO time; small tables stay whole. */
  changedSince?: string;
  /** Adds the complete epic, comment, relation and segment ID sets for delete detection. */
  includeIdSets?: boolean;
}

export type ProjectReplicaBuildResult<S extends ProjectReplicaScope> =
  | {
      ok: true;
      replica: ProjectReplicaOfScope<S>;
      /** Relations left out because their other end is in a project outside the request. */
      excludedRelationCount: number;
      idSets?: ProjectReplicaIdSets;
    }
  | { ok: false; errors: ProjectReplicaPreflightError[] };

type RowRef = { table: string; id: string };

/**
 * Builds a `ProjectReplicaV1` from storage. Nest-free apart from `@Injectable`
 * so a CLI can construct it with any replica source reader.
 */
@Injectable()
export class ProjectReplicaBuilder {
  constructor(private readonly storage: Pick<ProjectReplicaStorage, 'readProjectReplicaSource'>) {}

  async build<S extends ProjectReplicaScope>(
    request: BuildProjectReplicaRequest<S>,
  ): Promise<ProjectReplicaBuildResult<S>> {
    const source = await this.storage.readProjectReplicaSource(request.projectIds, {
      includeConfiguration: request.scope !== 'live',
      includeSessions: request.scope !== 'live',
      includeWorkspaceGrants: request.scope === 'attach',
      changedSince: request.changedSince,
      includeIdSets: request.includeIdSets,
    });
    const result = assembleProjectReplica(source, request);
    if (result.ok) {
      logger.info(
        {
          projectIds: request.projectIds,
          scope: request.scope,
          epics: result.replica.tables.epics.length,
          excludedRelationCount: result.excludedRelationCount,
        },
        'Built project replica',
      );
    } else {
      logger.warn(
        {
          projectIds: request.projectIds,
          scope: request.scope,
          errorCodes: result.errors.map((error) => error.code),
        },
        'Project replica preflight failed',
      );
    }
    return result;
  }
}

function assembleProjectReplica<S extends ProjectReplicaScope>(
  source: ProjectReplicaSource,
  request: BuildProjectReplicaRequest<S>,
): ProjectReplicaBuildResult<S> {
  const errors = new PreflightErrors();
  const projectIds = new Set(source.projects.map((project) => project.id));
  for (const projectId of new Set(request.projectIds)) {
    if (!projectIds.has(projectId)) errors.add({ code: 'PROJECT_NOT_FOUND', projectId });
  }

  const workspaceIds = [...new Set(source.projects.map((project) => project.workspace_id))];
  if (workspaceIds.length > 1) {
    errors.add({ code: 'WORKSPACE_MISMATCH', workspaceIds });
  }
  const workspace = source.workspaces.find((row) => row.id === workspaceIds[0]);
  if (workspaceIds.length === 1 && !workspace) {
    errors.add({
      code: 'REFERENCED_ROW_UNAVAILABLE',
      table: 'project_workspaces',
      id: workspaceIds[0],
      reason: 'missing',
      referencedBy: { table: 'projects', id: source.projects[0].id },
    });
  }

  const travels = (row: { project_id: string | null }): boolean =>
    row.project_id === null || projectIds.has(row.project_id);

  const references = new ReferenceChecker(source, travels, errors);
  for (const agent of source.agents) {
    const ref = { table: 'agents', id: agent.id };
    references.profile(agent.profile_id, ref);
    references.config(agent.provider_config_id, ref);
  }
  for (const row of source.team_profiles) {
    references.profile(row.profile_id, { table: 'team_profiles', id: row.team_id });
  }
  for (const row of source.team_profile_configs) {
    const ref = { table: 'team_profile_configs', id: row.team_id };
    references.profile(row.profile_id, ref);
    references.config(row.provider_config_id, ref);
  }

  const profiles = source.agent_profiles.filter(travels);
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const configs = source.profile_provider_configs.filter((config) =>
    profileIds.has(config.profile_id),
  );

  const providersById = new Map(source.providers.map((provider) => [provider.id, provider]));
  const referencedProviderIds = new Set<string>();
  for (const config of configs) {
    if (providersById.has(config.provider_id)) {
      referencedProviderIds.add(config.provider_id);
    } else {
      errors.add({
        code: 'PROVIDER_ROW_MISSING',
        providerId: config.provider_id,
        referencedBy: { table: 'profile_provider_configs', id: config.id },
      });
    }
  }

  const includeConfiguration = request.scope !== 'live';
  for (const row of includeConfiguration ? source.agent_profile_prompts : []) {
    if (profileIds.has(row.profile_id)) {
      references.prompt(row.prompt_id, { table: 'agent_profiles', id: row.profile_id });
    }
  }
  const prompts = source.prompts.filter(travels);
  const promptIds = new Set(prompts.map((prompt) => prompt.id));
  const promptTags = source.prompt_tags.filter((row) => promptIds.has(row.prompt_id));
  for (const row of promptTags) {
    references.tag(row.tag_id, { table: 'prompts', id: row.prompt_id });
  }

  if (includeConfiguration) {
    for (const scope of source.provider_env_scopes) {
      if (projectIds.has(scope.project_id) && providersById.has(scope.provider_id)) {
        referencedProviderIds.add(scope.provider_id);
      }
    }
    for (const watcher of source.terminal_watchers) {
      if (
        watcher.scope === 'provider' &&
        watcher.scope_filter_id &&
        providersById.has(watcher.scope_filter_id)
      ) {
        referencedProviderIds.add(watcher.scope_filter_id);
      }
    }
    for (const override of source.project_provider_plugin_overrides) {
      if (providersById.has(override.provider_id)) {
        referencedProviderIds.add(override.provider_id);
      }
    }
  }

  const providers = source.providers
    .filter((provider) => referencedProviderIds.has(provider.id))
    .map(({ id, name }) => ({ id, name }));
  if (request.targetProviderNames) {
    const targetNames = new Set(request.targetProviderNames);
    for (const provider of providers) {
      if (!targetNames.has(provider.name)) {
        errors.add({ code: 'PROVIDER_NOT_ON_TARGET', providerName: provider.name });
      }
    }
  }

  const providerInstanceTables =
    request.scope === 'attach'
      ? buildProviderInstanceTables(source, providersById, referencedProviderIds, configs, errors)
      : undefined;

  if (!errors.isEmpty() || !workspace) {
    return { ok: false, errors: errors.list() };
  }

  let excludedRelationCount = 0;
  const relations: ProjectReplicaRow<'epic_relations'>[] = [];
  for (const { left_project_id, right_project_id, ...relation } of source.epic_relations) {
    if (projectIds.has(left_project_id) && projectIds.has(right_project_id)) {
      relations.push(relation);
    } else {
      excludedRelationCount += 1;
    }
  }

  const live: ProjectReplicaLiveTables = {
    projects: source.projects,
    statuses: source.statuses,
    tags: source.tags.filter(travels),
    providers,
    agent_profiles: profiles,
    profile_provider_configs: configs,
    agents: source.agents,
    epics: source.epics,
    epic_tags: source.epic_tags,
    epic_comments: source.epic_comments,
    epic_relations: relations,
    epic_time_segments: source.epic_time_segments,
  };
  const configuration = {
    prompts,
    prompt_tags: promptTags,
    agent_profile_prompts: source.agent_profile_prompts.filter((row) =>
      profileIds.has(row.profile_id),
    ),
    teams: source.teams,
    team_members: source.team_members,
    team_profiles: source.team_profiles,
    team_profile_configs: source.team_profile_configs,
    terminal_watchers: source.terminal_watchers,
    automation_subscribers: source.automation_subscribers,
    scheduled_epics: source.scheduled_epics,
    project_settings: buildProjectSettings(source.settings, [...projectIds]),
    project_provider_plugin_overrides: source.project_provider_plugin_overrides,
    sender_skill_slugs: source.sender_skill_slugs,
    skill_project_disabled: source.skill_project_disabled,
    source_project_enabled: source.source_project_enabled,
    reviews: source.reviews,
    review_comments: source.review_comments,
  };

  const envelope = {
    version: PROJECT_REPLICA_VERSION,
    generatedAt: source.readAt,
    workspace: { id: workspace.id, name: workspace.name },
  };
  const scope: ProjectReplicaScope = request.scope;
  const handoff = () => ({
    ...live,
    ...configuration,
    sessions: source.sessions,
    epic_time_session_watermarks: buildSessionWatermarks(source),
  });
  let replica: unknown;
  switch (scope) {
    case 'live':
      replica = { ...envelope, scope, tables: live };
      break;
    case 'attach':
      replica = {
        ...envelope,
        scope,
        tables: {
          ...handoff(),
          instance_settings: source.instanceSettings,
          authorityKids: source.authorityKids,
          paired_device_workspace_grants: source.paired_device_workspace_grants.filter(
            (grant) =>
              grant.workspace_id === workspace.id &&
              source.authorityKids.includes(grant.device_kid),
          ),
          ...providerInstanceTables!,
        } satisfies ProjectReplicaAttachTables,
      };
      break;
    case 'detach':
      replica = {
        ...envelope,
        scope,
        tables: handoff() satisfies ProjectReplicaDetachTables,
      };
      break;
  }

  // Parsing guards the wire contract against storage drift (e.g. a new column).
  const parsed = ProjectReplicaV1Schema.parse(replica);
  return {
    ok: true,
    // The switch above built the variant whose scope equals `request.scope`.
    replica: parsed as ProjectReplicaOfScope<S>,
    excludedRelationCount,
    ...(source.idSets && {
      idSets: {
        ...source.idSets,
        epic_relations: relations.map((relation) => relation.id),
      },
    }),
  };
}

/**
 * Validates that rows the project points at may travel: they must exist and
 * belong to a requested project or be global (`project_id NULL`).
 */
class ReferenceChecker {
  private readonly profiles: Map<string, { project_id: string | null }>;
  private readonly configs: Map<string, { profile_id: string }>;
  private readonly prompts: Map<string, { project_id: string | null }>;
  private readonly tags: Map<string, { project_id: string | null }>;

  constructor(
    source: ProjectReplicaSource,
    private readonly travels: (row: { project_id: string | null }) => boolean,
    private readonly errors: PreflightErrors,
  ) {
    this.profiles = new Map(source.agent_profiles.map((row) => [row.id, row]));
    this.configs = new Map(source.profile_provider_configs.map((row) => [row.id, row]));
    this.prompts = new Map(source.prompts.map((row) => [row.id, row]));
    this.tags = new Map(source.tags.map((row) => [row.id, row]));
  }

  profile(id: string, referencedBy: RowRef): void {
    this.check('agent_profiles', this.profiles.get(id), id, referencedBy);
  }

  config(id: string, referencedBy: RowRef): void {
    const config = this.configs.get(id);
    if (!config) {
      this.errors.add({
        code: 'REFERENCED_ROW_UNAVAILABLE',
        table: 'profile_provider_configs',
        id,
        reason: 'missing',
        referencedBy,
      });
      return;
    }
    this.profile(config.profile_id, { table: 'profile_provider_configs', id });
  }

  prompt(id: string, referencedBy: RowRef): void {
    this.check('prompts', this.prompts.get(id), id, referencedBy);
  }

  tag(id: string, referencedBy: RowRef): void {
    this.check('tags', this.tags.get(id), id, referencedBy);
  }

  private check(
    table: 'agent_profiles' | 'prompts' | 'tags',
    row: { project_id: string | null } | undefined,
    id: string,
    referencedBy: RowRef,
  ): void {
    if (row && this.travels(row)) return;
    this.errors.add({
      code: 'REFERENCED_ROW_UNAVAILABLE',
      table,
      id,
      reason: row ? 'other_project' : 'missing',
      referencedBy,
    });
  }
}

/** Keeps the first error per failing row; later paths to the same row add nothing. */
class PreflightErrors {
  private readonly errors = new Map<string, ProjectReplicaPreflightError>();

  add(error: ProjectReplicaPreflightError): void {
    const key = JSON.stringify('referencedBy' in error ? { ...error, referencedBy: null } : error);
    if (!this.errors.has(key)) this.errors.set(key, error);
  }

  isEmpty(): boolean {
    return this.errors.size === 0;
  }

  list(): ProjectReplicaPreflightError[] {
    return [...this.errors.values()];
  }
}

/**
 * Every travelling session gets a watermark at or after its last activity, so
 * the receiving instance's sweep finds no unreconciled activity to turn into
 * new time: the copied settled segments are the whole of that session's time.
 */
function buildSessionWatermarks(
  source: ProjectReplicaSource,
): ProjectReplicaRow<'epic_time_session_watermarks'>[] {
  const projectByAgent = new Map(source.agents.map((agent) => [agent.id, agent.project_id]));
  const bySession = new Map(
    source.epic_time_session_watermarks.map((watermark) => [watermark.session_id, watermark]),
  );
  for (const session of source.sessions) {
    const activityAt = session.last_activity_at;
    if (!activityAt || Number.isNaN(Date.parse(activityAt))) continue;
    const existing = bySession.get(session.id);
    if (existing && Date.parse(existing.last_activity_at) >= Date.parse(activityAt)) continue;
    const projectId =
      existing?.project_id ?? (session.agent_id && projectByAgent.get(session.agent_id));
    if (!projectId) continue;
    bySession.set(session.id, {
      session_id: session.id,
      project_id: projectId,
      last_activity_at: activityAt,
      created_at: existing?.created_at ?? source.readAt,
      updated_at: source.readAt,
    });
  }
  return [...bySession.values()].sort((left, right) =>
    left.session_id.localeCompare(right.session_id),
  );
}

/** Returns `null` for no env, `undefined` when the stored JSON is not a string map. */
function parseEnv(envJson: string | null): Record<string, string> | null | undefined {
  if (!envJson) return null;
  try {
    const parsed: unknown = JSON.parse(envJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    return entries.every(([, value]) => typeof value === 'string')
      ? (Object.fromEntries(entries) as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Instance-level provider tables for the referenced providers: scalars, the
 * two catalogs (with configured-but-uncataloged names synthesized so the
 * host's pickers keep them) and the plugin defaults.
 */
function buildProviderInstanceTables(
  source: ProjectReplicaSource,
  providersById: Map<string, ProjectReplicaSource['providers'][number]>,
  referencedProviderIds: Set<string>,
  configs: ProjectReplicaRow<'profile_provider_configs'>[],
  errors: PreflightErrors,
): Pick<
  ProjectReplicaAttachTables,
  'provider_settings' | 'provider_models' | 'provider_efforts' | 'provider_plugin_defaults'
> {
  const providerName = (providerId: string): string | undefined =>
    providersById.get(providerId)?.name;
  /** Rows of the referenced providers, keyed by provider name. */
  const byProviderName = <T extends { provider_id: string }, R>(
    rows: T[],
    toRow: (row: T, name: string) => R,
  ): R[] => {
    const result: R[] = [];
    for (const row of rows) {
      if (!referencedProviderIds.has(row.provider_id)) continue;
      const name = providerName(row.provider_id);
      if (name) result.push(toRow(row, name));
    }
    return result;
  };

  const scopesByProvider = new Map<string, Map<string, string[]>>();
  for (const scope of source.provider_env_scopes) {
    const scopes = scopesByProvider.get(scope.provider_id) ?? new Map<string, string[]>();
    const projects = scopes.get(scope.env_key) ?? [];
    projects.push(scope.project_id);
    scopes.set(scope.env_key, projects);
    scopesByProvider.set(scope.provider_id, scopes);
  }
  const provider_settings = byProviderName(source.provider_settings, (row, name) => {
    const env = parseEnv(providersById.get(row.provider_id)!.env);
    if (env === undefined) errors.add({ code: 'PROVIDER_ENV_INVALID', providerName: name });
    return {
      providerName: name,
      env: env ?? null,
      envScopes: Object.fromEntries(scopesByProvider.get(row.provider_id) ?? []),
      auto_compact_threshold: row.auto_compact_threshold,
      claude_launch_settings_json: row.claude_launch_settings_json,
    };
  });

  const configured = configuredCatalogNames(source, configs);
  const provider_models = buildCatalogRows(
    source.provider_models,
    configured.models,
    referencedProviderIds,
    providerName,
    source.readAt,
  );
  const provider_efforts = buildCatalogRows(
    source.provider_efforts,
    configured.efforts,
    referencedProviderIds,
    providerName,
    source.readAt,
  );

  const provider_plugin_defaults = byProviderName(source.provider_plugin_defaults, (row, name) => ({
    providerName: name,
    plugin_id: row.plugin_id,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return { provider_settings, provider_models, provider_efforts, provider_plugin_defaults };
}

/** Model and effort names the project's configs and agents are set to, per provider. */
function configuredCatalogNames(
  source: ProjectReplicaSource,
  configs: ProjectReplicaRow<'profile_provider_configs'>[],
): { models: Map<string, string[]>; efforts: Map<string, string[]> } {
  const models = new Map<string, string[]>();
  const efforts = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, providerId: string, name: string | null): void => {
    if (!name) return;
    const names = map.get(providerId) ?? [];
    names.push(name);
    map.set(providerId, names);
  };
  for (const config of configs) {
    add(models, config.provider_id, config.model);
    add(efforts, config.provider_id, config.effort);
  }
  const configById = new Map(source.profile_provider_configs.map((config) => [config.id, config]));
  for (const agent of source.agents) {
    const providerId = configById.get(agent.provider_config_id)?.provider_id;
    if (!providerId) continue;
    add(models, providerId, agent.model_override);
    add(efforts, providerId, agent.effort_override);
  }
  return { models, efforts };
}

/**
 * The provider's catalog rows in stored order, then every configured name the
 * catalog lacks (case-insensitively), so a value the picker needs to keep
 * survives even when the sender's own catalog never listed it.
 */
function buildCatalogRows(
  catalog: ProjectReplicaSource['provider_models'],
  configuredNames: Map<string, string[]>,
  referencedProviderIds: Set<string>,
  providerName: (providerId: string) => string | undefined,
  synthesizedAt: string,
): ProjectReplicaAttachTables['provider_models'] {
  const rows: ProjectReplicaAttachTables['provider_models'] = [];
  const seen = new Map<string, Set<string>>();
  const mark = (providerId: string, name: string): boolean => {
    let names = seen.get(providerId);
    if (!names) {
      names = new Set<string>();
      seen.set(providerId, names);
    }
    const key = name.toLowerCase();
    if (names.has(key)) return false;
    names.add(key);
    return true;
  };
  for (const row of catalog) {
    if (!referencedProviderIds.has(row.provider_id)) continue;
    const name = providerName(row.provider_id);
    if (!name || !mark(row.provider_id, row.name)) continue;
    rows.push({ providerName: name, name: row.name, created_at: row.created_at });
  }
  for (const [providerId, candidates] of configuredNames) {
    if (!referencedProviderIds.has(providerId)) continue;
    const name = providerName(providerId);
    if (!name) continue;
    for (const candidate of candidates) {
      if (!mark(providerId, candidate)) continue;
      rows.push({ providerName: name, name: candidate, created_at: synthesizedAt });
    }
  }
  return rows;
}

function buildProjectSettings(
  rows: ProjectReplicaSource['settings'],
  projectIds: string[],
): ProjectReplicaAttachTables['project_settings'] {
  const entries: ProjectReplicaAttachTables['project_settings'] = [];
  for (const row of rows) {
    let map: unknown;
    try {
      map = JSON.parse(row.value);
    } catch {
      // Unreadable maps are ignored by the settings readers too.
      continue;
    }
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    for (const projectId of projectIds) {
      const value = (map as Record<string, unknown>)[projectId];
      if (value !== undefined) {
        entries.push({
          project_id: projectId,
          key: row.key as ProjectReplicaSettingKey,
          value,
        });
      }
    }
  }
  return entries;
}
