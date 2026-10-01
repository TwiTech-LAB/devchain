import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

export interface RuntimeInfo {
  version: string;
  bootId: string;
  runtimeToken?: string;
  features?: {
    cloudUi?: boolean;
  };
  integrationAdmission?:
    | { allowed: true; reason: null }
    | { allowed: false; reason: 'child_runtime' | 'non_loopback_host' };
}

export async function fetchRuntimeInfo(): Promise<RuntimeInfo> {
  const response = await apiFetch(
    '/api/runtime',
    {
      headers: { accept: 'application/json' },
    },
    { backend: HOME_BACKEND },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch runtime info: HTTP ${response.status}`);
  }
  return (await response.json()) as RuntimeInfo;
}
