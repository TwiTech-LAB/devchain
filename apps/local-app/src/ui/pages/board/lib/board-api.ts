import type { Agent, Epic } from '@/ui/types';

export type BoardArchivedFilter = 'active' | 'archived' | 'all';

export type BulkUpdateEpicsPayload = {
  parentId?: string | null;
  updates: Array<{ id: string; statusId?: string; agentId?: string | null; version: number }>;
};

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (input, init) => {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return window.fetch.call(window, input as RequestInfo, init);
  }
  return Promise.reject(new Error('fetch not available'));
};

export async function fetchStatuses(projectId: string, fetchFn: FetchFn = defaultFetch) {
  const res = await fetchFn(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

export async function fetchEpics(
  projectId: string,
  archived: BoardArchivedFilter = 'active',
  fetchFn: FetchFn = defaultFetch,
) {
  const params = new URLSearchParams({ projectId, limit: '1000', type: archived });
  const res = await fetchFn(`/api/epics?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch epics');
  return res.json();
}

export async function fetchSubEpics(parentId: string, fetchFn: FetchFn = defaultFetch) {
  const res = await fetchFn(`/api/epics?parentId=${parentId}`);
  if (!res.ok) throw new Error('Failed to fetch sub-epics');
  return res.json();
}

export async function fetchSubEpicCounts(
  epicId: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<Record<string, number>> {
  const res = await fetchFn(`/api/epics/${epicId}/sub-epics/counts`);
  if (!res.ok) throw new Error('Failed to fetch sub-epic counts');
  return res.json();
}

export async function fetchAgents(
  projectId: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<{ items: Agent[] }> {
  const res = await fetchFn(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

export async function createEpic(data: Partial<Epic>, fetchFn: FetchFn = defaultFetch) {
  const res = await fetchFn('/api/epics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create epic' }));
    throw new Error(error.message || 'Failed to create epic');
  }
  return res.json();
}

export async function updateEpic(id: string, data: Partial<Epic>, fetchFn: FetchFn = defaultFetch) {
  const res = await fetchFn(`/api/epics/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update epic' }));
    throw new Error(error.message || 'Failed to update epic');
  }
  return res.json();
}

export async function bulkUpdateEpicsApi(
  payload: BulkUpdateEpicsPayload,
  fetchFn: FetchFn = defaultFetch,
) {
  const res = await fetchFn('/api/epics/bulk-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update epics' }));
    throw new Error(error.message || 'Failed to apply bulk updates');
  }
  return res.json();
}

export async function deleteEpic(id: string, fetchFn: FetchFn = defaultFetch) {
  const res = await fetchFn(`/api/epics/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete epic' }));
    throw new Error(error.message || 'Failed to delete epic');
  }
}
