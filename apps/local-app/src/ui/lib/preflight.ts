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
  usedByAgents?: string[];
  requiresProjectContext?: boolean;
}

export interface PreflightResult {
  overall: PreflightStatus;
  checks: PreflightCheck[];
  providers: ProviderCheck[];
  supportedMcpProviders: string[];
  timestamp: string;
}

export async function fetchPreflightChecks(
  projectPath?: string,
  opts?: { includeAllProviders?: boolean },
): Promise<PreflightResult> {
  const params = new URLSearchParams();
  if (projectPath) params.set('projectPath', projectPath);
  if (opts?.includeAllProviders === true) params.set('all', '1');
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`/api/preflight${query}`);
  if (!res.ok) {
    throw new Error('Failed to fetch preflight checks');
  }
  return res.json();
}
