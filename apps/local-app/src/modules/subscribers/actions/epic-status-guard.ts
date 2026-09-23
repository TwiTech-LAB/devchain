import type { Status } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ActionInputDefinition, ActionResult } from './action.interface';
import { compareText } from './family-agent-targets';

export type StatusGuardStorage = Pick<StorageService, 'listStatuses' | 'listProjectEpics'>;

export interface BlockingStatus {
  statusId: string;
  label: string;
  count: number;
}

export type StatusGuardResult =
  | { ok: true; blocking: BlockingStatus[] }
  | { ok: false; unknownLabels: string[] };

export const STATUS_GUARD_INPUT_NAME = 'skipWhileEpicsInStatuses';

/** Shared input definition for every action that supports the status guard. */
export const statusGuardInput: ActionInputDefinition = {
  name: STATUS_GUARD_INPUT_NAME,
  label: 'Skip while epics are in statuses',
  type: 'select',
  multiple: true,
  optionsSource: 'project_statuses',
  allowedSources: ['custom'],
  required: false,
  description:
    'Optional: select statuses. When any visible epic in this project is in one of these statuses, the action skips and changes nothing. A label that matches no status in this project fails the action and changes nothing.',
};

/**
 * Parse a comma-separated label list: trimmed, empties dropped, duplicates
 * removed case-insensitively keeping the first spelling. Shared by the action
 * runtime and the subscriber dialog so a stored value round-trips identically.
 */
export function parseStatusLabels(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of raw.split(',')) {
    const label = part.trim();
    if (label === '') {
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

/** Labels with no case-insensitive match among the option values. */
export function findUnknownLabels(labels: string[], options: Array<{ value: string }>): string[] {
  const known = new Set(options.map((option) => option.value.toLowerCase()));
  return labels.filter((label) => !known.has(label.toLowerCase()));
}

/**
 * Resolve the user-selected status labels against the project's statuses and
 * count visible epics per matched status. Labels are not unique per project
 * (only project + position is), so one label can match several status rows.
 * Counting must go through listProjectEpics with excludeMcpHidden so epics in
 * hidden statuses — and all their descendants — do not block the guard;
 * countEpicsByStatus ignores that hierarchy and would count stale sub-epics
 * under an archived parent.
 */
export async function resolveStatusGuard(
  storage: StatusGuardStorage,
  projectId: string,
  raw: unknown,
): Promise<StatusGuardResult> {
  const labels = parseStatusLabels(raw);
  if (labels.length === 0) {
    return { ok: true, blocking: [] };
  }
  const statuses = await storage.listStatuses(projectId, { limit: 1000, offset: 0 });
  const statusesByLabel = new Map<string, Status[]>();
  for (const status of statuses.items) {
    const key = status.label.trim().toLowerCase();
    statusesByLabel.set(key, [...(statusesByLabel.get(key) ?? []), status]);
  }
  const unknownLabels = labels.filter((label) => !statusesByLabel.has(label.toLowerCase()));
  if (unknownLabels.length > 0) {
    return { ok: false, unknownLabels };
  }
  const blocking: BlockingStatus[] = [];
  for (const label of labels) {
    const matches = [...(statusesByLabel.get(label.toLowerCase()) ?? [])].sort((left, right) =>
      compareText(left.id, right.id),
    );
    for (const status of matches) {
      // Only `total` is read; limit 0 skips the row fetch and tag batch.
      const result = await storage.listProjectEpics(projectId, {
        statusId: status.id,
        excludeMcpHidden: true,
        limit: 0,
        offset: 0,
      });
      if (result.total > 0) {
        blocking.push({ statusId: status.id, label, count: result.total });
      }
    }
  }
  return { ok: true, blocking };
}

export function describeBlocking(blocking: BlockingStatus[]): string {
  const total = blocking.reduce((sum, entry) => sum + entry.count, 0);
  const labels = [...new Set(blocking.map((entry) => entry.label))];
  return `Skipped: ${total} epic(s) still in ${labels.join(', ')}`;
}

export function describeUnknownLabels(projectId: string, unknownLabels: string[]): string {
  return `Unknown status label(s) in project ${projectId}: ${unknownLabels.join(', ')}. Nothing changed.`;
}

export function skippedResult(blocking: BlockingStatus[]): ActionResult {
  return {
    success: true,
    message: describeBlocking(blocking),
    data: { skipped: true, blocking },
    retryable: false,
  };
}
