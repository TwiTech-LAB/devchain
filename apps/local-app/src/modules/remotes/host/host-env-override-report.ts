import { z } from 'zod';
import type { ListResult } from '../../storage/interfaces/storage.interface';
import type {
  EnvScopesMap,
  ProfileProviderConfig,
  Project,
  Provider,
} from '../../storage/models/domain.models';
import { readHostEnvFile } from './host-provider-auth.service';

/** Where the overriding value comes from, as launch resolves it. */
export type HostEnvOverrideSource = 'provider-env' | 'provider-env-scoped' | 'provider-config';

/**
 * One stored key that shadows a `host.env` login at launch. Names only —
 * values never leave the instance.
 */
export interface HostEnvOverrideEntry {
  key: string;
  source: HostEnvOverrideSource;
  provider: string;
  /** Project names a scoped provider-env key applies to. */
  projects?: string[];
  /** The provider configuration whose env carries the key. */
  config?: string;
}

export const HostEnvOverridesSchema = z.array(
  z.object({
    key: z.string(),
    source: z.enum(['provider-env', 'provider-env-scoped', 'provider-config']),
    provider: z.string(),
    projects: z.array(z.string()).optional(),
    config: z.string().optional(),
  }),
);

/** The read-only rows the report joins; a narrowing of the storage service. */
export interface HostEnvOverrideReportStorage {
  listProviders(): Promise<ListResult<Provider>>;
  listEnvScopesByProviderIds(providerIds: string[]): Map<string, EnvScopesMap>;
  listAllProfileProviderConfigs(): Promise<ProfileProviderConfig[]>;
  listProjects(): Promise<ListResult<Project>>;
}

export function buildHostEnvOverrideReport(input: {
  hostEnv: Record<string, string>;
  providers: Provider[];
  envScopesByProvider: Map<string, EnvScopesMap>;
  configs: ProfileProviderConfig[];
  projects: Project[];
}): HostEnvOverrideEntry[] {
  const hostKeys = new Set(Object.keys(input.hostEnv));
  if (hostKeys.size === 0) return [];
  const projectName = new Map(input.projects.map((project) => [project.id, project.name]));
  const providerName = new Map(input.providers.map((provider) => [provider.id, provider.name]));

  const entries: HostEnvOverrideEntry[] = [];
  for (const provider of input.providers) {
    if (!provider.env) continue;
    const scopes = input.envScopesByProvider.get(provider.id) ?? {};
    for (const key of Object.keys(provider.env)) {
      if (!hostKeys.has(key)) continue;
      const scopedTo = scopes[key];
      if (!scopedTo || scopedTo.length === 0) {
        entries.push({ key, source: 'provider-env', provider: provider.name });
      } else {
        entries.push({
          key,
          source: 'provider-env-scoped',
          provider: provider.name,
          projects: [...new Set(scopedTo)].map((id) => projectName.get(id) ?? id).sort(),
        });
      }
    }
  }
  for (const config of input.configs) {
    if (!config.env) continue;
    for (const key of Object.keys(config.env)) {
      if (!hostKeys.has(key)) continue;
      entries.push({
        key,
        source: 'provider-config',
        provider: config.providerName ?? providerName.get(config.providerId) ?? config.providerId,
        config: config.name,
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.key.localeCompare(b.key) ||
      a.source.localeCompare(b.source) ||
      a.provider.localeCompare(b.provider),
  );
}

/**
 * The override report `/api/runtime` serves: which keys stored in this
 * instance's database (provider env and provider-config env) shadow the
 * logins `host.env` applied at claim time. On an instance without `host.env`
 * the answer is always empty.
 */
export async function readHostEnvOverrideReport(
  storage: HostEnvOverrideReportStorage,
): Promise<HostEnvOverrideEntry[]> {
  const hostEnv = await readHostEnvFile();
  // Nothing can shadow an empty host.env; skip the database reads.
  if (Object.keys(hostEnv).length === 0) return [];
  const [{ items: providers }, { items: projects }, configs] = await Promise.all([
    storage.listProviders(),
    storage.listProjects(),
    storage.listAllProfileProviderConfigs(),
  ]);
  const envScopesByProvider = storage.listEnvScopesByProviderIds(providers.map((p) => p.id));
  return buildHostEnvOverrideReport({ hostEnv, providers, envScopesByProvider, configs, projects });
}
