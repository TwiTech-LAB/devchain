export type PreflightStatus = 'pass' | 'fail' | 'warn';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  message: string;
  details?: string;
  remediation?: string;
}

export interface ProviderCheck {
  id: string;
  name: string;
  status: PreflightStatus;
  message: string;
  details?: string;
  binPath: string | null;
  binaryStatus: PreflightStatus;
  binaryMessage: string;
  binaryDetails?: string;
  mcpStatus?: PreflightStatus;
  mcpMessage?: string;
  mcpDetails?: string;
  mcpEndpoint?: string | null;
}

export interface PreflightResult {
  overall: PreflightStatus;
  checks: PreflightCheck[];
  providers: ProviderCheck[];
  timestamp: string;
}

export async function fetchPreflightChecks(projectPath?: string): Promise<PreflightResult> {
  const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
  const res = await fetch(`/api/preflight${query}`);
  if (!res.ok) {
    throw new Error('Failed to fetch preflight checks');
  }
  return res.json();
}
