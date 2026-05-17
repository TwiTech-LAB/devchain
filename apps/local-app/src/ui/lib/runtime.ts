export type DevchainRuntimeMode = 'normal' | 'orchestrator' | 'main' | string;

export interface RuntimeInfo {
  mode: DevchainRuntimeMode;
  version: string;
  bootId: string;
  dockerAvailable: boolean;
  runtimeToken?: string;
  features?: {
    cloudUi?: boolean;
  };
}

export async function fetchRuntimeInfo(): Promise<RuntimeInfo> {
  const response = await fetch('/api/runtime', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch runtime info: HTTP ${response.status}`);
  }
  return (await response.json()) as RuntimeInfo;
}
