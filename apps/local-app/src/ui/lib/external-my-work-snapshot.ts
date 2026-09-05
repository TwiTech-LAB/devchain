import type {
  ExternalMyWorkResult,
  ExternalTaskStatusCategory,
} from '@/modules/external-integrations/models/external-provider.models';

export type ExternalMyWorkSupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

export interface ExternalTaskSnapshotStatus {
  remoteId: string | null;
  name: string;
  category: ExternalTaskStatusCategory;
}

export interface ExternalTaskStatusSnapshotPair {
  activeOnly?: ExternalMyWorkSupportedSnapshot;
  completedInclusive?: ExternalMyWorkSupportedSnapshot;
}

function snapshotWorkAreaKey(scopeKey: string, remoteId: string): string {
  return `${scopeKey}\u0000${remoteId}`;
}

/**
 * Confirms assignment proof for reopening a completed child: a supported,
 * same-provider completed-inclusive snapshot contains at least one
 * occurrence of the child. Completed My Work is time-bounded, so an empty
 * result cannot prove that the child is unassigned. This is not full
 * work-area reconstruction proof: the restore path attaches only the
 * occurrences whose exact work areas exist in the active snapshot.
 */
export function hasAuthoritativeExternalTaskOccurrence(
  activeOnly: ExternalMyWorkSupportedSnapshot,
  completedInclusive: ExternalMyWorkSupportedSnapshot,
  taskId: string,
): boolean {
  return (
    activeOnly.provider === completedInclusive.provider &&
    completedInclusive.tasks.some((entry) => entry.task.remoteId === taskId)
  );
}

/**
 * Applies a confirmed or optimistic status change to one landing snapshot.
 * Every task entry with the remote ID is patched. In an active-only scope, a
 * completed task is removed and each affected work-area count is decremented
 * once per removed entry. Unchanged entries and work areas retain identity.
 */
export function applyExternalTaskStatusSnapshot(
  snapshot: ExternalMyWorkSupportedSnapshot,
  taskId: string,
  status: ExternalTaskSnapshotStatus,
  activeOnlyScope: boolean,
): ExternalMyWorkSupportedSnapshot {
  const destination = {
    remoteId: status.remoteId,
    name: status.name,
    category: status.category,
  };
  if (!activeOnlyScope || status.category !== 'completed') {
    return {
      ...snapshot,
      tasks: snapshot.tasks.map((entry) =>
        entry.task.remoteId === taskId
          ? { ...entry, task: { ...entry.task, status: { ...destination } } }
          : entry,
      ),
    };
  }

  const removedByWorkArea = new Map<string, number>();
  const tasks = snapshot.tasks.filter((entry) => {
    if (entry.task.remoteId !== taskId) return true;
    const key = snapshotWorkAreaKey(entry.workArea.scopeKey, entry.workArea.remoteId);
    removedByWorkArea.set(key, (removedByWorkArea.get(key) ?? 0) + 1);
    return false;
  });
  const workAreas = snapshot.workAreas.map((workArea) => {
    const removed = removedByWorkArea.get(
      snapshotWorkAreaKey(workArea.scopeKey, workArea.remoteId),
    );
    if (!removed) return workArea;
    return { ...workArea, assignedTaskCount: Math.max(0, workArea.assignedTaskCount - removed) };
  });
  return { ...snapshot, tasks, workAreas };
}

function restoreActiveEntries(
  activeOnly: ExternalMyWorkSupportedSnapshot,
  completedInclusive: ExternalMyWorkSupportedSnapshot,
  taskId: string,
  status: ExternalTaskSnapshotStatus,
): ExternalMyWorkSupportedSnapshot {
  const patched = applyExternalTaskStatusSnapshot(activeOnly, taskId, status, true);
  const occurrenceCount = new Map<string, number>();
  for (const entry of patched.tasks) {
    if (entry.task.remoteId !== taskId) continue;
    const key = snapshotWorkAreaKey(entry.workArea.scopeKey, entry.workArea.remoteId);
    occurrenceCount.set(key, (occurrenceCount.get(key) ?? 0) + 1);
  }

  const workAreasByKey = new Map(
    patched.workAreas.map((workArea) => [
      snapshotWorkAreaKey(workArea.scopeKey, workArea.remoteId),
      workArea,
    ]),
  );
  const restoredWorkAreas = new Set<string>();
  const restoredEntries: ExternalMyWorkSupportedSnapshot['tasks'] = [];
  for (const entry of completedInclusive.tasks) {
    if (entry.task.remoteId !== taskId) continue;
    const key = snapshotWorkAreaKey(entry.workArea.scopeKey, entry.workArea.remoteId);
    const existing = occurrenceCount.get(key) ?? 0;
    if (existing > 0) {
      occurrenceCount.set(key, existing - 1);
      continue;
    }
    const workArea = workAreasByKey.get(key);
    if (!workArea) continue;
    restoredEntries.push({
      ...entry,
      workArea,
      task: {
        ...entry.task,
        status: { remoteId: status.remoteId, name: status.name, category: status.category },
      },
    });
    restoredWorkAreas.add(key);
  }
  if (restoredEntries.length === 0) return patched;

  return {
    ...patched,
    tasks: [...patched.tasks, ...restoredEntries],
    workAreas: patched.workAreas.map((workArea) =>
      restoredWorkAreas.has(snapshotWorkAreaKey(workArea.scopeKey, workArea.remoteId))
        ? { ...workArea, assignedTaskCount: workArea.assignedTaskCount + 1 }
        : workArea,
    ),
  };
}

/**
 * Settles the two landing scopes from one confirmed status change. The
 * completed-inclusive scope is the reconstruction source when reopening a
 * task filtered out of active-only data.
 */
export function settleExternalTaskStatusSnapshots(
  snapshots: ExternalTaskStatusSnapshotPair,
  taskId: string,
  status: ExternalTaskSnapshotStatus,
): ExternalTaskStatusSnapshotPair {
  const completedInclusive = snapshots.completedInclusive
    ? applyExternalTaskStatusSnapshot(snapshots.completedInclusive, taskId, status, false)
    : undefined;
  if (!snapshots.activeOnly) return { activeOnly: undefined, completedInclusive };

  const activeOnly =
    status.category !== 'completed' && snapshots.completedInclusive
      ? restoreActiveEntries(snapshots.activeOnly, snapshots.completedInclusive, taskId, status)
      : applyExternalTaskStatusSnapshot(snapshots.activeOnly, taskId, status, true);
  return { activeOnly, completedInclusive };
}
