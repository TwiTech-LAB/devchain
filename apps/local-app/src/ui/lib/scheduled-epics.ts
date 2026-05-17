/**
 * Scheduled Epics API functions
 * Provides centralized API layer for scheduled epic management.
 */

// ============================================
// ERROR TYPES
// ============================================

/**
 * API error with HTTP status code. Allows callers to detect version conflicts (409)
 * and other specific error conditions.
 */
export class ScheduledEpicApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ScheduledEpicApiError';
    this.status = status;
  }

  get isVersionConflict(): boolean {
    return this.status === 409;
  }
}

// ============================================
// TYPES
// ============================================

export type ScheduledEpicMissedRunPolicy = 'skip' | 'run_once' | 'run_all';
export type ScheduledEpicRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ScheduledEpicRunSource = 'scheduler' | 'manual';

export interface ScheduledEpic {
  id: string;
  projectId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  titleTemplate: string;
  descriptionTemplate: string | null;
  templateStatusId: string | null;
  templateParentEpicId: string | null;
  templateAgentId: string | null;
  templateTags: string[];
  allowOverlap: boolean;
  missedRunPolicy: ScheduledEpicMissedRunPolicy;
  configVersion: number;
  runCount: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEpicRun {
  id: string;
  scheduleId: string;
  plannedFor: string;
  source: ScheduledEpicRunSource;
  status: ScheduledEpicRunStatus;
  createdEpicId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEpicRunsPage {
  items: ScheduledEpicRun[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScheduledEpicRunNowResult {
  claimed: boolean;
  run: ScheduledEpicRun;
}

export interface CreateScheduledEpicData {
  projectId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled?: boolean;
  titleTemplate: string;
  descriptionTemplate?: string | null;
  templateStatusId?: string | null;
  templateParentEpicId?: string | null;
  templateAgentId?: string | null;
  templateTags?: string[];
  allowOverlap?: boolean;
  missedRunPolicy?: ScheduledEpicMissedRunPolicy;
  nextRunAt?: string | null;
}

export interface UpdateScheduledEpicData {
  configVersion: number;
  name?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  titleTemplate?: string;
  descriptionTemplate?: string | null;
  templateStatusId?: string | null;
  templateParentEpicId?: string | null;
  templateAgentId?: string | null;
  templateTags?: string[];
  allowOverlap?: boolean;
  missedRunPolicy?: ScheduledEpicMissedRunPolicy;
}

export interface FetchScheduledEpicsOptions {
  enabled?: boolean;
}

export interface FetchScheduledEpicRunsOptions {
  status?: ScheduledEpicRunStatus;
  limit?: number;
  offset?: number;
}

// ============================================
// TEMPLATE VARIABLE METADATA
// Runtime source of truth: scheduled-epic-runner.service.ts buildTemplateVars()
// ============================================

export interface TemplateVariableMeta {
  token: string;
  label: string;
  sample: string;
}

export const TEMPLATE_VARIABLES: TemplateVariableMeta[] = [
  { token: '{{schedule_name}}', label: 'Schedule Name', sample: 'Daily Standup' },
  { token: '{{date}}', label: 'Date (YYYY-MM-DD)', sample: '2026-05-17' },
  { token: '{{datetime}}', label: 'ISO 8601 Datetime', sample: '2026-05-17T09:00:00.000Z' },
  { token: '{{timestamp}}', label: 'Unix Timestamp (ms)', sample: '1779253200000' },
  { token: '{{run_source}}', label: 'Run Source', sample: 'scheduler' },
  { token: '{{project_id}}', label: 'Project ID', sample: 'a1b2c3d4-...' },
];

// ============================================
// CURSOR-SAFE VARIABLE INSERTION HELPER
// ============================================

export function insertAtCursor(
  input: HTMLInputElement | HTMLTextAreaElement,
  currentValue: string,
  insertText: string,
): { newValue: string; caretPosition: number } {
  const start = input.selectionStart ?? currentValue.length;
  const end = input.selectionEnd ?? currentValue.length;
  const newValue = currentValue.slice(0, start) + insertText + currentValue.slice(end);
  const caretPosition = start + insertText.length;
  return { newValue, caretPosition };
}

// ============================================
// CRON PRESETS (client-side only)
// ============================================

export interface CronPreset {
  label: string;
  expression: string;
  description: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every minute', expression: '* * * * *', description: 'Runs every minute' },
  { label: 'Every 5 minutes', expression: '*/5 * * * *', description: 'Runs every 5 minutes' },
  { label: 'Every 15 minutes', expression: '*/15 * * * *', description: 'Runs every 15 minutes' },
  { label: 'Every 30 minutes', expression: '*/30 * * * *', description: 'Runs every 30 minutes' },
  { label: 'Hourly', expression: '0 * * * *', description: 'Runs at the start of every hour' },
  {
    label: 'Daily at midnight',
    expression: '0 0 * * *',
    description: 'Runs every day at midnight',
  },
  { label: 'Daily at 9am', expression: '0 9 * * *', description: 'Runs every day at 9:00 AM' },
  {
    label: 'Weekly on Monday',
    expression: '0 9 * * 1',
    description: 'Runs every Monday at 9:00 AM',
  },
  {
    label: 'Monthly on 1st',
    expression: '0 9 1 * *',
    description: 'Runs on the 1st of every month at 9:00 AM',
  },
];

// ============================================
// API FUNCTIONS
// ============================================

async function throwOnError(response: Response, fallback: string): Promise<never> {
  const error = await response.json().catch(() => ({ message: fallback }));
  throw new ScheduledEpicApiError(error.message || fallback, response.status);
}

/**
 * Fetch all scheduled epics for a project.
 */
export async function fetchScheduledEpics(
  projectId: string,
  options?: FetchScheduledEpicsOptions,
): Promise<ScheduledEpic[]> {
  const params = new URLSearchParams({ projectId });
  if (options?.enabled !== undefined) {
    params.set('enabled', String(options.enabled));
  }
  const response = await fetch(`/api/scheduled-epics?${params.toString()}`);
  if (!response.ok) {
    await throwOnError(response, 'Failed to fetch scheduled epics');
  }
  return response.json();
}

/**
 * Fetch a single scheduled epic by ID.
 */
export async function fetchScheduledEpic(id: string): Promise<ScheduledEpic> {
  const response = await fetch(`/api/scheduled-epics/${id}`);
  if (!response.ok) {
    await throwOnError(response, 'Failed to fetch scheduled epic');
  }
  return response.json();
}

/**
 * Create a new scheduled epic.
 */
export async function createScheduledEpic(data: CreateScheduledEpicData): Promise<ScheduledEpic> {
  const response = await fetch('/api/scheduled-epics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await throwOnError(response, 'Failed to create scheduled epic');
  }
  return response.json();
}

/**
 * Update an existing scheduled epic. Requires configVersion for optimistic locking.
 * Throws ScheduledEpicApiError with status 409 on version conflict.
 */
export async function updateScheduledEpic(
  id: string,
  data: UpdateScheduledEpicData,
): Promise<ScheduledEpic> {
  const response = await fetch(`/api/scheduled-epics/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await throwOnError(response, 'Failed to update scheduled epic');
  }
  return response.json();
}

/**
 * Delete a scheduled epic.
 */
export async function deleteScheduledEpic(id: string): Promise<void> {
  const response = await fetch(`/api/scheduled-epics/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    await throwOnError(response, 'Failed to delete scheduled epic');
  }
}

/**
 * Toggle a scheduled epic's enabled status. Requires configVersion for optimistic locking.
 * Throws ScheduledEpicApiError with status 409 on version conflict.
 */
export async function toggleScheduledEpic(
  id: string,
  enabled: boolean,
  configVersion: number,
): Promise<ScheduledEpic> {
  const response = await fetch(`/api/scheduled-epics/${id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, configVersion }),
  });
  if (!response.ok) {
    await throwOnError(response, 'Failed to toggle scheduled epic');
  }
  return response.json();
}

/**
 * Trigger an immediate run of a scheduled epic.
 */
export async function runScheduledEpicNow(id: string): Promise<ScheduledEpicRunNowResult> {
  const response = await fetch(`/api/scheduled-epics/${id}/run-now`, {
    method: 'POST',
  });
  if (!response.ok) {
    await throwOnError(response, 'Failed to trigger scheduled epic run');
  }
  return response.json();
}

/**
 * Fetch paginated run history for a scheduled epic.
 */
export async function fetchScheduledEpicRuns(
  scheduleId: string,
  options?: FetchScheduledEpicRunsOptions,
): Promise<ScheduledEpicRunsPage> {
  const params = new URLSearchParams();
  if (options?.status !== undefined) params.set('status', options.status);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  const response = await fetch(
    `/api/scheduled-epics/${scheduleId}/runs${query ? `?${query}` : ''}`,
  );
  if (!response.ok) {
    await throwOnError(response, 'Failed to fetch scheduled epic runs');
  }
  return response.json();
}
