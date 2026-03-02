import type { Agent, Epic } from '@/ui/types';

export type BoardArchivedFilter = 'active' | 'archived' | 'all';

export type BulkUpdateEpicsPayload = {
  parentId?: string | null;
  updates: Array<{ id: string; statusId?: string; agentId?: string | null; version: number }>;
};

export async function fetchStatuses(projectId: string) {
  const res = await fetch(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

export async function fetchEpics(projectId: string, archived: BoardArchivedFilter = 'active') {
  // Board: fetch a larger page of epics based on archived filter
  const params = new URLSearchParams({ projectId, limit: '1000', type: archived });
  const res = await fetch(`/api/epics?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch epics');
  return res.json();
}

export async function fetchSubEpics(parentId: string) {
  const res = await fetch(`/api/epics?parentId=${parentId}`);
  if (!res.ok) throw new Error('Failed to fetch sub-epics');
  return res.json();
}

export async function fetchSubEpicCounts(epicId: string): Promise<Record<string, number>> {
  const res = await fetch(`/api/epics/${epicId}/sub-epics/counts`);
  if (!res.ok) throw new Error('Failed to fetch sub-epic counts');
  return res.json();
}

export async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

export async function createEpic(data: Partial<Epic>) {
  const res = await fetch('/api/epics', {
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

export async function updateEpic(id: string, data: Partial<Epic>) {
  const res = await fetch(`/api/epics/${id}`, {
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

export async function bulkUpdateEpicsApi(payload: BulkUpdateEpicsPayload) {
  const res = await fetch('/api/epics/bulk-update', {
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

export async function deleteEpic(id: string) {
  const res = await fetch(`/api/epics/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete epic' }));
    throw new Error(error.message || 'Failed to delete epic');
  }
}
