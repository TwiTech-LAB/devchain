import type Database from 'better-sqlite3';
import type { EnvScopesMap } from '../models/domain.models';

type ProjectId = string | null | undefined;

const DIRECT_PROJECT_COLUMNS = {
  epic: 'epics',
  agent: 'agents',
  prompt: 'prompts',
  tag: 'tags',
  profile: 'agent_profiles',
  guest: 'guests',
  status: 'statuses',
  watcher: 'terminal_watchers',
  subscriber: 'automation_subscribers',
  review: 'reviews',
  schedule: 'scheduled_epics',
} as const;

const PROJECT_HOPS = {
  record: ['records', 'epic_id', 'epic'],
  epicComment: ['epic_comments', 'epic_id', 'epic'],
  reviewComment: ['review_comments', 'review_id', 'review'],
  scheduledRun: ['scheduled_epic_runs', 'schedule_id', 'schedule'],
  profileConfig: ['profile_provider_configs', 'profile_id', 'profile'],
} as const;

export type ProjectWriteEntity =
  | keyof typeof DIRECT_PROJECT_COLUMNS
  | keyof typeof PROJECT_HOPS
  | 'session';

export class ProjectWriteLookup {
  constructor(private readonly sqlite: Database.Database) {}

  projectIds(entity: ProjectWriteEntity, id: ProjectId): readonly (string | null)[] {
    if (!id) return [null];
    if (entity === 'session') {
      return [
        ...this.projectIds('agent', this.column('sessions', 'agent_id', id)),
        ...this.projectIds('epic', this.column('sessions', 'epic_id', id)),
      ];
    }
    if (entity in PROJECT_HOPS) {
      const [table, column, owner] = PROJECT_HOPS[entity as keyof typeof PROJECT_HOPS];
      return this.projectIds(owner, this.column(table, column, id));
    }
    return [
      this.column(
        DIRECT_PROJECT_COLUMNS[entity as keyof typeof DIRECT_PROJECT_COLUMNS],
        'project_id',
        id,
      ),
    ];
  }

  changedProviderScopeProjects(
    providerId: string,
    envScopes: EnvScopesMap | undefined,
    currentEnvKeys: readonly string[],
  ): string[] {
    const changes = readProviderScopeChanges(this.sqlite, providerId, envScopes, currentEnvKeys);
    return [...new Set([...changes.removed, ...changes.added].map((row) => row.projectId))];
  }

  private column(table: string, column: string, id: string): string | null {
    const row = this.sqlite
      .prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`)
      .get(id.trim()) as { value: string | null } | undefined;
    return row?.value ?? null;
  }
}

export type StorageScopeResolver<Args extends readonly unknown[]> = (
  args: Args,
  lookup: ProjectWriteLookup,
) => readonly (string | null)[];

export function projectIds<Args extends readonly unknown[]>(
  select: (args: Args) => readonly ProjectId[],
): StorageScopeResolver<Args> {
  return (args) => select(args).map((id) => id?.trim() || null);
}

export function entityProjects<Args extends readonly unknown[]>(
  entity: ProjectWriteEntity,
  select: (args: Args) => readonly ProjectId[],
): StorageScopeResolver<Args> {
  return (args, lookup) => select(args).flatMap((id) => lookup.projectIds(entity, id));
}

/** Scope for a writer whose first argument is the ID of the entity that owns the project. */
export function ownedBy<Args extends readonly [ProjectId, ...unknown[]]>(
  entity: ProjectWriteEntity,
): StorageScopeResolver<Args> {
  return entityProjects(entity, ([id]) => [id]);
}

export function combineScopes<Args extends readonly unknown[]>(
  ...scopes: readonly StorageScopeResolver<Args>[]
): StorageScopeResolver<Args> {
  return (args, lookup) => scopes.flatMap((scope) => scope(args, lookup));
}

export interface ProviderScopeMembership {
  envKey: string;
  projectId: string;
}

export function readProviderScopeChanges(
  sqlite: Database.Database,
  providerId: string,
  envScopes: EnvScopesMap | undefined,
  currentEnvKeys: readonly string[],
): { removed: ProviderScopeMembership[]; added: ProviderScopeMembership[] } {
  const existing = sqlite
    .prepare('SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ?')
    .all(providerId) as Array<{ env_key: string; project_id: string }>;
  const before = new Map<string, ProviderScopeMembership>();
  const after = new Map<string, ProviderScopeMembership>();
  const key = (envKey: string, projectId: string): string => JSON.stringify([envKey, projectId]);
  for (const row of existing) {
    const membership = { envKey: row.env_key, projectId: row.project_id };
    before.set(key(row.env_key, row.project_id), membership);
    if (envScopes === undefined && currentEnvKeys.includes(row.env_key)) {
      after.set(key(row.env_key, row.project_id), membership);
    }
  }
  if (envScopes !== undefined) {
    for (const [envKey, projectIds] of Object.entries(envScopes)) {
      if (!currentEnvKeys.includes(envKey)) continue;
      for (const projectId of projectIds) {
        after.set(key(envKey, projectId), { envKey, projectId });
      }
    }
  }
  return {
    removed: [...before].filter(([entry]) => !after.has(entry)).map(([, row]) => row),
    added: [...after].filter(([entry]) => !before.has(entry)).map(([, row]) => row),
  };
}
