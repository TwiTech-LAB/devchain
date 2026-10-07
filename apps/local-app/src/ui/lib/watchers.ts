/**
 * Watchers API functions
 * Provides centralized API layer for watcher management.
 */
import type { FetchFn } from '@/ui/lib/api-transport';

// ============================================
// TYPES
// ============================================

export interface TriggerCondition {
  type: ConditionType;
  pattern: string;
  flags?: string;
}

export type ConditionType = 'contains' | 'regex' | 'not_contains';

export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
  contains: 'Contains',
  regex: 'Regex',
  not_contains: 'Not Contains',
};

export function getConditionTypeLabel(type: ConditionType): string {
  return CONDITION_TYPE_LABELS[type];
}

export interface Watcher {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scope: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId: string | null;
  pollIntervalMs: number;
  viewportLines: number;
  condition: TriggerCondition;
  idleAfterSeconds: number;
  cooldownMs: number;
  cooldownMode: 'time' | 'until_clear';
  eventName: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatcherData {
  projectId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  scope?: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId?: string | null;
  pollIntervalMs?: number;
  viewportLines?: number;
  condition: TriggerCondition;
  idleAfterSeconds?: number;
  cooldownMs?: number;
  cooldownMode?: 'time' | 'until_clear';
  eventName: string;
}

export interface UpdateWatcherData {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  scope?: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId?: string | null;
  pollIntervalMs?: number;
  viewportLines?: number;
  condition?: TriggerCondition;
  idleAfterSeconds?: number;
  cooldownMs?: number;
  cooldownMode?: 'time' | 'until_clear';
  eventName?: string;
}

export interface WatcherTestSessionResult {
  sessionId: string;
  agentId: string | null;
  tmuxSessionId: string | null;
  viewport: string | null;
  viewportHash: string | null;
  conditionMatched: boolean;
}

export interface WatcherTestResult {
  watcher: Watcher;
  sessionsChecked: number;
  results: WatcherTestSessionResult[];
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Fetch all watchers for a project.
 */
export async function fetchWatchers(fetchFn: FetchFn, projectId: string): Promise<Watcher[]> {
  const params = new URLSearchParams({ projectId });
  const response = await fetchFn(`/api/watchers?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch watchers');
  }
  return response.json();
}

/**
 * Fetch a single watcher by ID.
 */
export async function fetchWatcher(fetchFn: FetchFn, id: string): Promise<Watcher> {
  const response = await fetchFn(`/api/watchers/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch watcher');
  }
  return response.json();
}

/**
 * Create a new watcher.
 */
export async function createWatcher(fetchFn: FetchFn, data: CreateWatcherData): Promise<Watcher> {
  const response = await fetchFn('/api/watchers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create watcher' }));
    throw new Error(error.message || 'Failed to create watcher');
  }
  return response.json();
}

/**
 * Update an existing watcher.
 */
export async function updateWatcher(
  fetchFn: FetchFn,
  id: string,
  data: UpdateWatcherData,
): Promise<Watcher> {
  const response = await fetchFn(`/api/watchers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to update watcher' }));
    throw new Error(error.message || 'Failed to update watcher');
  }
  return response.json();
}

/**
 * Delete a watcher.
 */
export async function deleteWatcher(fetchFn: FetchFn, id: string): Promise<void> {
  const response = await fetchFn(`/api/watchers/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete watcher');
  }
}

/**
 * Toggle a watcher's enabled status.
 */
export async function toggleWatcher(
  fetchFn: FetchFn,
  id: string,
  enabled: boolean,
): Promise<Watcher> {
  const response = await fetchFn(`/api/watchers/${id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error('Failed to toggle watcher');
  }
  return response.json();
}

/**
 * Test a watcher against current terminal viewports.
 */
export async function testWatcher(fetchFn: FetchFn, id: string): Promise<WatcherTestResult> {
  const response = await fetchFn(`/api/watchers/${id}/test`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to test watcher');
  }
  return response.json();
}
