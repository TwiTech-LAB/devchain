import type {
  ExternalMyWorkResult,
  ExternalTaskStatusCategory,
  ExternalTaskSummary,
  ExternalWorkArea,
} from '@/modules/external-integrations/models/external-provider.models';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';

export interface ExternalKanbanTask {
  remoteId: string;
  title: string;
  statusName: string;
  statusCategory: ExternalTaskStatusCategory;
  updatedAt: string;
  dueAt: string | null;
  webUrl: string | null;
}

export interface ExternalKanbanColumn {
  key: string;
  name: string;
  color: string;
  tasks: ExternalKanbanTask[];
  /** Destination status identity for move resolution; null when unmapped. */
  remoteId: string | null;
  remoteStatusIds: string[];
  /** True for projected-only columns (ClickUp Other) that never receive a move. */
  synthetic: boolean;
}

export interface ExternalWorkAreaBoard {
  workArea: ExternalWorkArea;
  columns: ExternalKanbanColumn[];
  /**
   * False when columns carry observed status order rather than the provider's
   * workflow order. Directional movement is meaningless in that order, so the
   * board — not its callers — decides where arrow moves make sense.
   */
  workflowOrdered: boolean;
}

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

/** Mirrors the Jira adapter's synthetic area for tasks outside a board. */
const JIRA_OTHER_ASSIGNED_WORK_AREA_ID = 'other-assigned';

function taskModel(task: ExternalTaskSummary): ExternalKanbanTask {
  return {
    remoteId: task.remoteId,
    title: task.title,
    statusName: task.status.name,
    statusCategory: task.status.category,
    updatedAt: task.updatedAt,
    dueAt: task.dueAt,
    webUrl: task.webUrl,
  };
}

function observedStatusColor(category: ExternalTaskStatusCategory): string {
  return category === 'completed' ? '#36b37e' : '#6b778c';
}

function observedStatusColumns(tasks: ExternalTaskSummary[]): ExternalKanbanColumn[] {
  const columns = new Map<string, ExternalKanbanColumn>();
  for (const task of tasks) {
    const key = task.status.remoteId ?? `name:${task.status.name}`;
    const existing = columns.get(key);
    if (existing) {
      existing.tasks.push(taskModel(task));
      continue;
    }
    columns.set(key, {
      key,
      name: task.status.name,
      color: observedStatusColor(task.status.category),
      tasks: [taskModel(task)],
      remoteId: task.status.remoteId ?? null,
      remoteStatusIds: task.status.remoteId ? [task.status.remoteId] : [],
      synthetic: false,
    });
  }
  return [...columns.values()];
}

function taskMatchesColumn(
  provider: ExternalBoardProvider,
  task: ExternalTaskSummary,
  column: ExternalWorkArea['workflow']['columns'][number],
): boolean {
  if (provider === 'jira') {
    return (
      task.status.remoteId !== null &&
      task.status.remoteId !== undefined &&
      (column.remoteStatusIds ?? []).includes(task.status.remoteId)
    );
  }
  if (
    task.status.remoteId !== null &&
    task.status.remoteId !== undefined &&
    column.remoteId !== null
  ) {
    return task.status.remoteId === column.remoteId;
  }
  return task.status.name === column.name;
}

export function buildExternalWorkAreaBoard(
  provider: ExternalBoardProvider,
  snapshot: SupportedSnapshot,
  workAreaId: string,
): ExternalWorkAreaBoard | null {
  const workArea = snapshot.workAreas.find((candidate) => candidate.remoteId === workAreaId);
  if (!workArea) return null;

  const tasks = snapshot.tasks
    .filter(
      (item) =>
        item.workArea.remoteId === workArea.remoteId &&
        item.workArea.scopeKey === workArea.scopeKey,
    )
    .map((item) => item.task);

  if (provider === 'jira' && workArea.remoteId === JIRA_OTHER_ASSIGNED_WORK_AREA_ID) {
    return { workArea, columns: observedStatusColumns(tasks), workflowOrdered: false };
  }

  const remaining = new Set(tasks.map((task) => task.remoteId));
  const columns = [...workArea.workflow.columns]
    .sort((left, right) => left.position - right.position)
    .map((column, index): ExternalKanbanColumn => {
      const matches = tasks.filter((task) => taskMatchesColumn(provider, task, column));
      matches.forEach((task) => remaining.delete(task.remoteId));
      return {
        key: column.remoteId ?? `column:${index}:${column.name}`,
        name: column.name,
        color: column.color,
        tasks: matches.map(taskModel),
        remoteId: column.remoteId,
        remoteStatusIds: column.remoteStatusIds ?? [],
        synthetic: false,
      };
    });

  if (provider === 'clickup' && remaining.size > 0) {
    columns.push({
      key: 'other',
      name: 'Other',
      color: '#6b7280',
      tasks: tasks.filter((task) => remaining.has(task.remoteId)).map(taskModel),
      remoteId: null,
      remoteStatusIds: [],
      synthetic: true,
    });
  }

  return { workArea, columns, workflowOrdered: true };
}
