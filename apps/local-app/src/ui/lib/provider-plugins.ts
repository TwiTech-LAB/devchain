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

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  ) {
    return payload.message;
  }
  return fallback;
}

async function fetchJsonOrThrow<T>(
  url: string,
  options: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, fallbackError));
  }
  return response.json() as Promise<T>;
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
  options: { signal?: AbortSignal } = {},
): Promise<ProviderPlugin[]> {
  const payload = await fetchJsonOrThrow<unknown>(
    '/api/provider-plugins',
    { signal: options.signal },
    'Failed to load provider plugins',
  );
  return normalizeCatalogResponse(payload).items;
}

export async function refreshProviderPlugins(): Promise<ProviderPlugin[]> {
  const payload = await fetchJsonOrThrow<unknown>(
    '/api/provider-plugins/refresh',
    { method: 'POST' },
    'Failed to refresh provider plugins',
  );
  return normalizeCatalogResponse(payload).items;
}

export async function installProviderPlugin(providerId: string, pluginId: string): Promise<void> {
  await fetchJsonOrThrow<unknown>(
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
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderPluginPolicy[]> {
  const params = new URLSearchParams({ projectId });
  const payload = await fetchJsonOrThrow<ProviderPluginPolicyResponse>(
    `/api/provider-plugins/policy?${params.toString()}`,
    { signal: options.signal },
    'Failed to load plugin policies',
  );
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function setProviderPluginDefault(
  providerId: string,
  pluginId: string,
  enabled: boolean,
): Promise<ProviderPluginPolicy> {
  return fetchJsonOrThrow<ProviderPluginPolicy>(
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
  providerId: string,
  pluginId: string,
): Promise<void> {
  const params = new URLSearchParams({ providerId, pluginId });
  await fetchJsonOrThrow<unknown>(
    `/api/provider-plugins/policy/default?${params.toString()}`,
    { method: 'DELETE' },
    'Failed to reset DevChain Default policy',
  );
}

export async function setProjectProviderPluginPolicy(
  projectId: string,
  providerId: string,
  pluginId: string,
  enabled: boolean,
): Promise<ProviderPluginPolicy> {
  return fetchJsonOrThrow<ProviderPluginPolicy>(
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
  projectId: string,
  providerId: string,
  pluginId: string,
): Promise<void> {
  const params = new URLSearchParams({ projectId, providerId, pluginId });
  await fetchJsonOrThrow<unknown>(
    `/api/provider-plugins/policy/project?${params.toString()}`,
    { method: 'DELETE' },
    'Failed to reset This Project policy',
  );
}
