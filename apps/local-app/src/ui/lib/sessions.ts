import type { FetchFn } from './api-transport';
import type { PreflightResult, ProviderCheck } from './preflight';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';

export interface ActiveSession {
  id: string;
  epicId: string | null;
  agentId: string | null;
  tmuxSessionId: string | null;
  status: 'running' | 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  name?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * API error payload shape from backend AllExceptionsFilter.
 * Matches the response format in http-exception.filter.ts
 */
export interface ApiErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  details?: {
    code?: string;
    providerId?: string;
    providerName?: string;
    mcpStatus?: string;
    mcpMessage?: string;
    [key: string]: unknown;
  };
  timestamp: string;
  path: string;
}

/**
 * Custom error class for session API errors that includes HTTP status code and full payload.
 * Allows callers to make decisions based on specific error types (404, 409, MCP_NOT_CONFIGURED, etc.).
 */
export class SessionApiError extends Error {
  public readonly status: number;
  public readonly payload?: ApiErrorPayload;

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message);
    this.name = 'SessionApiError';
    this.status = status;
    this.payload = payload;
  }

  /**
   * Check if this error has a specific error code in the details.
   * Useful for handling specific error types like MCP_NOT_CONFIGURED.
   */
  hasCode(code: string): boolean {
    return this.payload?.details?.code === code;
  }
}

export type { FetchFn };

/**
 * Extract error message from API response payload.
 * Handles { message: string } format common in our API responses.
 */
function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    return String((payload as { message: unknown }).message);
  }
  return fallback;
}

/**
 * Standardized fetch helper that parses JSON responses and throws SessionApiError on failure.
 * Preserves server-provided error messages and full payload for error handling.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @param fallbackError - Error message to use if server doesn't provide one
 * @returns Parsed JSON response of type T
 * @throws SessionApiError with server message, HTTP status code, and full payload
 */
export async function fetchJsonOrThrow<T>(
  url: string,
  options: RequestInit = {},
  fallbackError: string = 'Request failed',
  fetchFn: FetchFn,
): Promise<T> {
  const response = await fetchFn(url, options);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = extractErrorMessage(payload, fallbackError);
    throw new SessionApiError(message, response.status, payload ?? undefined);
  }

  return response.json();
}

/**
 * Standardized fetch helper for requests that don't return a body (e.g., DELETE).
 * Throws SessionApiError on failure with server-provided message and full payload.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @param fallbackError - Error message to use if server doesn't provide one
 * @throws SessionApiError with server message, HTTP status code, and full payload
 */
export async function fetchOrThrow(
  url: string,
  options: RequestInit = {},
  fallbackError: string = 'Request failed',
  fetchFn: FetchFn,
): Promise<void> {
  const response = await fetchFn(url, options);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = extractErrorMessage(payload, fallbackError);
    throw new SessionApiError(message, response.status, payload ?? undefined);
  }
}

/**
 * Result of a restart session operation.
 * Includes the new session and optional warning if terminate failed unexpectedly.
 */
export interface RestartSessionResult {
  session: ActiveSession;
  /** Warning message if terminate failed with non-whitelisted error (non-404/409) */
  terminateWarning?: string;
}

export interface EpicSummary {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  parentId: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  projectId: string;
  profileId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Provider ID (enriched by backend to eliminate fetch chain) */
  providerId?: string;
  /** Provider name (enriched by backend to eliminate fetch chain) */
  providerName?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchActiveSessions(
  projectId: string | undefined,
  fetchFn: FetchFn,
): Promise<ActiveSession[]> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set('projectId', projectId);
  }
  const url = `/api/sessions${params.size > 0 ? `?${params.toString()}` : ''}`;
  return fetchJsonOrThrow<ActiveSession[]>(url, {}, 'Failed to fetch active sessions', fetchFn);
}

export async function terminateSession(sessionId: string, fetchFn: FetchFn): Promise<void> {
  return fetchOrThrow(
    `/api/sessions/${sessionId}`,
    { method: 'DELETE' },
    'Failed to terminate session',
    fetchFn,
  );
}

/**
 * Launch a new session for an agent within a project.
 * Centralized helper to avoid duplicating fetch logic across pages.
 */
export async function launchSession(
  agentId: string,
  projectId: string,
  options: { silent?: boolean } | undefined,
  fetchFn: FetchFn,
): Promise<ActiveSession> {
  const payload: { agentId: string; projectId: string; options?: { silent?: boolean } } = {
    agentId,
    projectId,
  };
  if (typeof options?.silent === 'boolean') {
    payload.options = { silent: options.silent };
  }

  return fetchJsonOrThrow<ActiveSession>(
    '/api/sessions/launch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Failed to launch session',
    fetchFn,
  );
}

/** Backend response shape for the restart endpoint */
interface RestartResponse {
  session: ActiveSession;
  terminateStatus: 'success' | 'not_found' | 'error';
  terminateWarning?: string;
}

/**
 * Restart an agent session using the backend restart endpoint.
 * The backend serializes terminate and launch through separate per-agent lock acquisitions.
 *
 * @param agentId - The agent to restart
 * @param projectId - The project the agent belongs to
 * @param _currentSessionId - Deprecated: no longer used (backend finds active session)
 * @returns Result containing the new session and optional warning
 */
export async function restartSession(
  agentId: string,
  projectId: string,
  _currentSessionId: string,
  fetchFn: FetchFn,
): Promise<RestartSessionResult> {
  const response = await fetchJsonOrThrow<RestartResponse>(
    `/api/agents/${agentId}/restart`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to restart session',
    fetchFn,
  );

  return {
    session: response.session,
    terminateWarning: response.terminateWarning,
  };
}

export async function restoreSession(
  sessionId: string,
  projectId: string,
  fetchFn: FetchFn,
): Promise<ActiveSession> {
  return fetchJsonOrThrow<ActiveSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to restore session',
    fetchFn,
  );
}

export async function renameSession(
  id: string,
  projectId: string,
  name: string | null,
  fetchFn: FetchFn,
): Promise<ActiveSession> {
  return fetchJsonOrThrow<ActiveSession>(
    `/api/sessions/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, name }),
    },
    'Failed to rename session',
    fetchFn,
  );
}

export async function deleteSessionHistoryItem(
  id: string,
  projectId: string,
  fetchFn: FetchFn,
): Promise<void> {
  return fetchOrThrow(
    `/api/sessions/${encodeURIComponent(id)}/record?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
    'Failed to delete session record',
    fetchFn,
  );
}

// Alias exports for API surface consistency with DoD
export async function launchAgentSession(
  agentId: string,
  projectId: string,
  fetchFn: FetchFn,
): Promise<ActiveSession> {
  return launchSession(agentId, projectId, undefined, fetchFn);
}

export async function restartAgentSession(
  agentId: string,
  projectId: string,
  currentSessionId: string,
  fetchFn: FetchFn,
): Promise<RestartSessionResult> {
  return restartSession(agentId, projectId, currentSessionId, fetchFn);
}

export async function fetchEpicSummary(epicId: string, fetchFn: FetchFn): Promise<EpicSummary> {
  return fetchJsonOrThrow<EpicSummary>(
    `/api/epics/${epicId}`,
    {},
    'Failed to fetch epic details',
    fetchFn,
  );
}

export async function fetchAgentSummary(agentId: string, fetchFn: FetchFn): Promise<AgentSummary> {
  return fetchJsonOrThrow<AgentSummary>(
    `/api/agents/${agentId}`,
    {},
    'Failed to fetch agent details',
    fetchFn,
  );
}

export async function fetchProjectSummary(
  projectId: string,
  fetchFn: FetchFn,
): Promise<ProjectSummary> {
  return fetchJsonOrThrow<ProjectSummary>(
    `/api/projects/${projectId}`,
    {},
    'Failed to fetch project details',
    fetchFn,
  );
}

export interface ProfileSummary {
  id: string;
  projectId: string;
  name: string;
  providerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchProfileSummary(
  profileId: string,
  fetchFn: FetchFn,
): Promise<ProfileSummary> {
  return fetchJsonOrThrow<ProfileSummary>(
    `/api/profiles/${profileId}`,
    {},
    'Failed to fetch profile details',
    fetchFn,
  );
}

export async function fetchProviderSummary(
  providerId: string,
  fetchFn: FetchFn,
): Promise<ProviderSummary> {
  return fetchJsonOrThrow<ProviderSummary>(
    `/api/providers/${providerId}`,
    {},
    'Failed to fetch provider details',
    fetchFn,
  );
}

export interface AgentPresence {
  online: boolean;
  sessionId?: string;
  activityState?: 'idle' | 'busy' | null;
  lastActivityAt?: string | null;
  busySince?: string | null;
  currentActivityTitle?: string | null;
}

export interface AgentPresenceMap {
  [agentId: string]: AgentPresence;
}

/** Summary response from GET /api/sessions/:id/transcript/summary */
export interface TranscriptSummary {
  sessionId: string;
  providerName: string;
  metrics: UnifiedMetrics;
  messageCount: number;
  isOngoing: boolean;
}

export async function fetchTranscriptSummary(
  sessionId: string,
  fetchFn: FetchFn,
): Promise<TranscriptSummary> {
  return fetchJsonOrThrow<TranscriptSummary>(
    `/api/sessions/${sessionId}/transcript/summary`,
    {},
    'Failed to fetch transcript summary',
    fetchFn,
  );
}

// ============================================
// Paged Transcript API (Phase 4)
// ============================================

export interface TranscriptIndex {
  cursor: string;
  totals: { messageCount: number; chunkCount: number };
  chunkIds: string[];
  latestOutputPreview: string | null;
  providerName: string;
  isOngoing: boolean;
  pages?: TranscriptIndexPage[];
}

export interface TranscriptIndexPage {
  cursor: string;
  size: number;
  response: SerializedChunkedResponse;
}

export interface TranscriptIndexRequest {
  pageSize?: number;
  firstVirtualIndex?: number;
  lastVirtualIndex?: number;
  live?: boolean;
  signal?: AbortSignal;
}

export interface SerializedChunkedResponse {
  chunks: import('@/ui/hooks/useSessionTranscript').SerializedChunk[];
  nextCursor: string | null;
  prevCursor: string | null;
  totalCount: number;
}

export async function fetchTranscriptIndex(
  sessionId: string,
  fetchFn: FetchFn,
  options: TranscriptIndexRequest = {},
): Promise<TranscriptIndex> {
  const params = new URLSearchParams();
  for (const key of ['pageSize', 'firstVirtualIndex', 'lastVirtualIndex', 'live'] as const) {
    if (options[key] !== undefined) params.set(key, String(options[key]));
  }
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  return fetchJsonOrThrow<TranscriptIndex>(
    `/api/sessions/${sessionId}/transcript/index${qs}`,
    options.signal ? { signal: options.signal } : {},
    'Failed to fetch transcript index',
    fetchFn,
  );
}

export async function fetchTranscriptChunks(
  sessionId: string,
  cursor: string | undefined,
  limit: number | undefined,
  direction: 'forward' | 'backward' | undefined,
  fetchFn: FetchFn,
): Promise<SerializedChunkedResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  if (direction) params.set('direction', direction);
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  return fetchJsonOrThrow<SerializedChunkedResponse>(
    `/api/sessions/${sessionId}/transcript/chunks${qs}`,
    {},
    'Failed to fetch transcript chunks',
    fetchFn,
  );
}

export async function fetchAgentPresence(
  projectId: string,
  fetchFn: FetchFn,
): Promise<AgentPresenceMap> {
  const params = new URLSearchParams({ projectId });
  return fetchJsonOrThrow<AgentPresenceMap>(
    `/api/sessions/agents/presence?${params.toString()}`,
    {},
    'Failed to fetch agent presence',
    fetchFn,
  );
}

// ============================================
// MCP Configuration Check
// ============================================

/**
 * Result of checking MCP configuration for an agent.
 */
export interface McpConfigCheckResult {
  /** Whether MCP is configured (provider mcpStatus === 'pass') */
  configured: boolean;
  /** Provider check details (includes id, name, mcpStatus, mcpMessage) */
  provider?: ProviderCheck;
}

/**
 * Check if an agent's provider has MCP configured.
 * Uses agent.providerId (enriched from providerConfig) first, falls back to profile.providerId.
 *
 * @param agentId - The agent ID to check
 * @param preflight - The preflight result containing provider checks
 * @param agents - List of agents to search
 * @param profiles - Map of profile ID to profile summary
 * @returns Object with configured boolean and provider details
 */
export function checkMcpConfigured(
  agentId: string,
  preflight: PreflightResult,
  agents: AgentSummary[],
  profiles: Map<string, ProfileSummary>,
): McpConfigCheckResult {
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return { configured: false };
  }

  // Use agent.providerId first (enriched from providerConfig by backend)
  // Fall back to profile.providerId for backward compatibility
  let providerId = agent.providerId;
  if (!providerId) {
    const profile = profiles.get(agent.profileId);
    providerId = profile?.providerId;
  }

  if (!providerId) {
    return { configured: false };
  }

  const providerCheck = preflight.providers.find((p) => p.id === providerId);
  if (!providerCheck) {
    return { configured: false };
  }

  return {
    configured: providerCheck.mcpStatus === 'pass',
    provider: providerCheck,
  };
}
