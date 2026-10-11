import { fetchJsonWithMessageOrThrow } from './http-json';
import type { FetchFn } from '@/ui/lib/api-transport';

export type ProviderPluginPolicySource = 'project' | 'default';

export interface ProviderPlugin {
  pluginId: string;
  name: string;
  description: string | null;
  marketplaceName: string | null;
  version: string | null;
  installed: boolean;
  available: boolean;
  providerEnabled: boolean;
  installationScopes: string[];
  installCount: number | null;
  installPolicy: string | null;
  authPolicy: string | null;
  providerId: string;
  providerName: string;
}

export interface ProviderPluginPolicy {
  providerId: string;
  pluginId: string;
  enabled: boolean;
  source: ProviderPluginPolicySource;
}

interface ProviderPluginCatalogResponse {
  items: ProviderPlugin[];
  total?: number;
}

interface ProviderPluginPolicyResponse {
  items: ProviderPluginPolicy[];
}

function normalizeCatalogResponse(payload: unknown): ProviderPluginCatalogResponse {
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && 'items' in payload && Array.isArray(payload.items)
      ? payload.items
      : [];

  return {
    items: items as ProviderPlugin[],
    total:
      payload &&
      typeof payload === 'object' &&
      'total' in payload &&
      typeof payload.total === 'number'
        ? payload.total
        : items.length,
  };
}

export async function fetchProviderPlugins(
  fetchFn: FetchFn,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderPlugin[]> {
  const payload = await fetchJsonWithMessageOrThrow<unknown>(
    fetchFn,
    '/api/provider-plugins',
    { signal: options.signal },
    'Failed to load provider plugins',
  );
  return normalizeCatalogResponse(payload).items;
}

export async function refreshProviderPlugins(fetchFn: FetchFn): Promise<ProviderPlugin[]> {
  const payload = await fetchJsonWithMessageOrThrow<unknown>(
    fetchFn,
    '/api/provider-plugins/refresh',
    { method: 'POST' },
    'Failed to refresh provider plugins',
  );
  return normalizeCatalogResponse(payload).items;
}

export async function installProviderPlugin(
  fetchFn: FetchFn,
  providerId: string,
  pluginId: string,
): Promise<void> {
  await fetchJsonWithMessageOrThrow<unknown>(
    fetchFn,
    '/api/provider-plugins/install',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, pluginId }),
    },
    'Failed to install plugin to provider',
  );
}

export async function fetchProviderPluginPolicies(
  fetchFn: FetchFn,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderPluginPolicy[]> {
  const params = new URLSearchParams({ projectId });
  const payload = await fetchJsonWithMessageOrThrow<ProviderPluginPolicyResponse>(
    fetchFn,
    `/api/provider-plugins/policy?${params.toString()}`,
    { signal: options.signal },
    'Failed to load plugin policies',
  );
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function setProviderPluginDefault(
  fetchFn: FetchFn,
  providerId: string,
  pluginId: string,
  enabled: boolean,
): Promise<ProviderPluginPolicy> {
  return fetchJsonWithMessageOrThrow<ProviderPluginPolicy>(
    fetchFn,
    '/api/provider-plugins/policy/default',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, pluginId, enabled }),
    },
    'Failed to update DevChain Default policy',
  );
}

export async function resetProviderPluginDefault(
  fetchFn: FetchFn,
  providerId: string,
  pluginId: string,
): Promise<void> {
  const params = new URLSearchParams({ providerId, pluginId });
  await fetchJsonWithMessageOrThrow<unknown>(
    fetchFn,
    `/api/provider-plugins/policy/default?${params.toString()}`,
    { method: 'DELETE' },
    'Failed to reset DevChain Default policy',
  );
}

export async function setProjectProviderPluginPolicy(
  fetchFn: FetchFn,
  projectId: string,
  providerId: string,
  pluginId: string,
  enabled: boolean,
): Promise<ProviderPluginPolicy> {
  return fetchJsonWithMessageOrThrow<ProviderPluginPolicy>(
    fetchFn,
    '/api/provider-plugins/policy/project',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, providerId, pluginId, enabled }),
    },
    'Failed to update This Project policy',
  );
}

export async function resetProjectProviderPluginPolicy(
  fetchFn: FetchFn,
  projectId: string,
  providerId: string,
  pluginId: string,
): Promise<void> {
  const params = new URLSearchParams({ projectId, providerId, pluginId });
  await fetchJsonWithMessageOrThrow<unknown>(
    fetchFn,
    `/api/provider-plugins/policy/project?${params.toString()}`,
    { method: 'DELETE' },
    'Failed to reset This Project policy',
  );
}
