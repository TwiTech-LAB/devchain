export interface ScheduledEpic {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  templateTitle: string;
  templateDescription: string | null;
  templateStatusId: string | null;
  templateAgentId: string | null;
  templateParentId: string | null;
  templateTags: string[] | null;
  templateSkillsRequired: string[] | null;
  templateData: Record<string, unknown> | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  cooldownMs: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEpicRun {
  id: string;
  scheduledEpicId: string;
  epicId: string | null;
  status: 'success' | 'failed' | 'skipped';
  error: string | null;
  scheduledAt: string;
  executedAt: string;
}

export interface CreateScheduledEpicData {
  projectId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  cronExpression: string;
  timezone?: string;
  templateTitle: string;
  templateDescription?: string | null;
  templateStatusId?: string | null;
  templateAgentId?: string | null;
  templateParentId?: string | null;
  templateTags?: string[] | null;
  templateSkillsRequired?: string[] | null;
  templateData?: Record<string, unknown> | null;
  maxOccurrences?: number | null;
  cooldownMs?: number;
  position?: number;
}

export interface UpdateScheduledEpicData {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  templateTitle?: string;
  templateDescription?: string | null;
  templateStatusId?: string | null;
  templateAgentId?: string | null;
  templateParentId?: string | null;
  templateTags?: string[] | null;
  templateSkillsRequired?: string[] | null;
  templateData?: Record<string, unknown> | null;
  maxOccurrences?: number | null;
  cooldownMs?: number;
  position?: number;
}

export interface CronPreset {
  label: string;
  cronExpression: string;
  description: string;
}

export async function fetchCronPresets(): Promise<CronPreset[]> {
  const response = await fetch('/api/schedules/presets');
  if (!response.ok) throw new Error('Failed to fetch cron presets');
  const data = await response.json();
  return data.presets;
}

export async function fetchScheduledEpics(projectId: string): Promise<ScheduledEpic[]> {
  const params = new URLSearchParams({ projectId });
  const response = await fetch(`/api/schedules?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch scheduled epics');
  return response.json();
}

export async function fetchScheduledEpic(id: string): Promise<ScheduledEpic> {
  const response = await fetch(`/api/schedules/${id}`);
  if (!response.ok) throw new Error('Failed to fetch scheduled epic');
  return response.json();
}

export async function createScheduledEpic(data: CreateScheduledEpicData): Promise<ScheduledEpic> {
  const response = await fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create scheduled epic' }));
    throw new Error(error.message || 'Failed to create scheduled epic');
  }
  return response.json();
}

export async function updateScheduledEpic(
  id: string,
  data: UpdateScheduledEpicData,
): Promise<ScheduledEpic> {
  const response = await fetch(`/api/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to update scheduled epic' }));
    throw new Error(error.message || 'Failed to update scheduled epic');
  }
  return response.json();
}

export async function deleteScheduledEpic(id: string): Promise<void> {
  const response = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete scheduled epic');
}

export async function toggleScheduledEpic(
  id: string,
  enabled: boolean,
): Promise<ScheduledEpic> {
  const response = await fetch(`/api/schedules/${id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error('Failed to toggle scheduled epic');
  return response.json();
}

export async function fetchScheduledEpicRuns(id: string): Promise<ScheduledEpicRun[]> {
  const response = await fetch(`/api/schedules/${id}/runs`);
  if (!response.ok) throw new Error('Failed to fetch scheduled epic runs');
  return response.json();
}

export function describeCron(expression: string, presets: CronPreset[]): string {
  const match = presets.find((p) => p.cronExpression === expression);
  return match?.label ?? expression;
}

export function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return 'Not scheduled';
  const date = new Date(nextRunAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs < 0) return 'Overdue';
  if (diffMs < 60_000) return 'In less than a minute';
  if (diffMs < 3_600_000) return `In ${Math.ceil(diffMs / 60_000)} minutes`;
  if (diffMs < 86_400_000) return `In ${Math.ceil(diffMs / 3_600_000)} hours`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
