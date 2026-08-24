import { CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState, type KeyboardEvent, type MutableRefObject } from 'react';
import type { ExternalTaskLinkStateSummary } from '@/modules/external-integrations/models/external-provider.models';
import { Button } from '@/ui/components/ui/button';
import type {
  ExternalTaskMoveSource,
  ExternalTaskMoveTarget,
} from '@/ui/hooks/board/useExternalTaskMove';
import { cn } from '@/ui/lib/utils';
import type { ExternalKanbanColumn, ExternalKanbanTask } from '@/ui/lib/external-work-area';

export interface ExternalTaskKanbanProps {
  columns: ExternalKanbanColumn[];
  onOpenTask: (task: ExternalKanbanTask) => void;
  links?: ExternalTaskLinkStateSummary[];
  /**
   * Link-lookup fetch/error state for the current data. The quick action stays
   * hidden until the lookup has settled so an unresolved card never offers an
   * import that a current link state would forbid.
   */
  linksFetching?: boolean;
  linksError?: boolean;
  /**
   * Live card-button registry keyed by stable remote task ID. The page uses it
   * as the focus target when the task dialog closes: cards remount on
   * status-driven column moves, so only the current element is a valid target.
   */
  cardFocusRegistry?: Map<string, HTMLButtonElement>;
  /** Focus fallback for close-to-board when the card no longer exists. */
  boardFocusFallbackRef?: MutableRefObject<HTMLDivElement | null>;
  /** Move wiring; absent when the surface renders read-only. */
  moves?: ExternalTaskKanbanMoves;
  /** Opens the import flow directly from an unlinked card. */
  onQuickImport?: (task: ExternalKanbanTask) => void;
  /** Remote task ID whose quick import is pending; blocks every quick action. */
  quickImportPendingTaskId?: string | null;
  /**
   * Live quick-action button registry keyed by stable remote task ID. The page
   * uses it to restore focus after a card-origin import closes or fails.
   */
  quickActionFocusRegistry?: Map<string, HTMLButtonElement>;
}

export interface ExternalTaskKanbanMoves {
  /** Arrow-key movement is unavailable where column order is not a workflow order. */
  keyboardMovesEnabled: boolean;
  dragSource: ExternalTaskMoveSource | null;
  pendingTaskId: string | null;
  isReceivingColumn: (column: ExternalKanbanColumn) => boolean;
  onCardDragStart: (source: ExternalTaskMoveSource) => void;
  onCardDragEnd: () => void;
  onCardDrop: (source: ExternalTaskMoveSource, target: ExternalTaskMoveTarget) => void;
  onKeyboardMove: (source: ExternalTaskMoveSource, target: ExternalTaskMoveTarget) => void;
  onKeyboardBoundary: () => void;
}

function columnToTarget(column: ExternalKanbanColumn): ExternalTaskMoveTarget {
  return {
    columnKey: column.key,
    name: column.name,
    remoteId: column.remoteId,
    remoteStatusIds: column.remoteStatusIds,
    synthetic: column.synthetic,
  };
}

// Module-level singleton: Intl.DateTimeFormat construction is expensive and the
// board re-renders often.
const DUE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDate(value: string): string {
  return DUE_DATE_FORMAT.format(new Date(value));
}

function groupedSubtaskCountText(count: number): string {
  return count === 1 ? '1 subtask' : `${count} subtasks`;
}

function openTaskLabel(task: ExternalKanbanTask): string {
  const parts = [`Open ${task.title}`];
  if (task.isSubtask) parts.push('Subtask');
  if (task.groupedSubtaskCount > 0) {
    parts.push(`with ${groupedSubtaskCountText(task.groupedSubtaskCount)} grouped under it`);
  }
  return parts.join(', ');
}

export function ExternalTaskKanban({
  columns,
  onOpenTask,
  links = [],
  linksFetching = false,
  linksError = false,
  cardFocusRegistry,
  boardFocusFallbackRef,
  moves,
  onQuickImport,
  quickImportPendingTaskId = null,
  quickActionFocusRegistry,
}: ExternalTaskKanbanProps) {
  const linksByTaskId = new Map(links.map((link) => [link.taskId, link]));
  // Hovered receiving column during a drag; mirrors the native Board pattern
  // where every receiving column hints and the hovered one highlights.
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  // React detaches a ref (null) before attaching its replacement, so a remount
  // always re-registers after this delete.
  const registerCard = (taskId: string, element: HTMLButtonElement | null): void => {
    if (!cardFocusRegistry) return;
    if (element) {
      cardFocusRegistry.set(taskId, element);
    } else {
      cardFocusRegistry.delete(taskId);
    }
  };
  // Quick-action focus registry entries are owned by the element that
  // registered them: cleanup removes the stored button only when it is still
  // the one this ref closure attached, so a remounted replacement registered
  // first can never be deleted by the old element's cleanup.
  const quickActionRef = (taskId: string) => {
    let attached: HTMLButtonElement | null = null;
    return (element: HTMLButtonElement | null): void => {
      if (!quickActionFocusRegistry) return;
      if (element) {
        attached = element;
        quickActionFocusRegistry.set(taskId, element);
      } else if (attached !== null && quickActionFocusRegistry.get(taskId) === attached) {
        quickActionFocusRegistry.delete(taskId);
        attached = null;
      }
    };
  };
  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    task: ExternalKanbanTask,
    columnIndex: number,
  ): void => {
    if (!moves?.keyboardMovesEnabled) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // The board scrolls horizontally; the arrow keys belong to movement.
    event.preventDefault();
    if (moves.pendingTaskId === task.remoteId) return;
    const source: ExternalTaskMoveSource = {
      taskId: task.remoteId,
      columnKey: columns[columnIndex]!.key,
    };
    const adjacent = columns[columnIndex + (event.key === 'ArrowLeft' ? -1 : 1)];
    if (!adjacent) {
      moves.onKeyboardBoundary();
      return;
    }
    moves.onKeyboardMove(source, columnToTarget(adjacent));
  };
  return (
    <div
      className="flex h-full min-w-0 snap-x gap-3 overflow-x-auto pb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      aria-label="Task board"
      tabIndex={-1}
      ref={boardFocusFallbackRef}
    >
      {columns.map((column, columnIndex) => (
        <section
          key={column.key}
          className={cn(
            'flex h-full min-w-[280px] max-w-[420px] flex-1 snap-start flex-col rounded-lg border bg-muted/30 transition-colors',
            moves?.dragSource && moves.isReceivingColumn(column) && 'border-primary/50',
            dropTargetKey === column.key && 'bg-primary/5',
          )}
          aria-labelledby={`external-column-${columnIndex}`}
          onDragOver={(event) => {
            if (!moves?.dragSource || !moves.isReceivingColumn(column)) return;
            event.preventDefault();
            setDropTargetKey((current) => (current === column.key ? current : column.key));
          }}
          onDragLeave={(event) => {
            // dragleave bubbles, so crossing between cards inside this column
            // must not clear the highlight the next dragover would re-set.
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
            setDropTargetKey((current) => (current === column.key ? null : current));
          }}
          onDrop={(event) => {
            if (!moves?.dragSource || !moves.isReceivingColumn(column)) return;
            event.preventDefault();
            setDropTargetKey(null);
            moves.onCardDrop(moves.dragSource, columnToTarget(column));
          }}
        >
          <header className="flex items-center gap-2 rounded-t-lg border-b bg-card p-3">
            <span
              className="flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white"
              style={{ backgroundColor: column.color }}
              aria-hidden="true"
            >
              {column.tasks.length}
            </span>
            <h2 id={`external-column-${columnIndex}`} className="text-sm font-semibold">
              {column.name}
            </h2>
          </header>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {column.tasks.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No assigned tasks</p>
            ) : null}
            {column.tasks.map((task) => {
              const link = linksByTaskId.get(task.remoteId);
              const isPending = moves?.pendingTaskId === task.remoteId;
              const isDragged = moves?.dragSource?.taskId === task.remoteId;
              const quickImportAvailable =
                Boolean(onQuickImport) && !linksFetching && !linksError && link?.linked === false;
              const quickImportPending = quickImportPendingTaskId !== null;
              const hasGroupedSubtasks = task.groupedSubtaskCount > 0;
              const taskLabel = openTaskLabel(task);
              const ariaLabel = moves?.keyboardMovesEnabled
                ? `${taskLabel}. Press Enter for details, press Left or Right arrow keys to move between columns.`
                : taskLabel;
              return (
                <article
                  key={task.remoteId}
                  draggable={Boolean(moves)}
                  onDragStart={(event) => {
                    if (!moves || isPending) {
                      event.preventDefault();
                      return;
                    }
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', task.remoteId);
                    }
                    moves.onCardDragStart({ taskId: task.remoteId, columnKey: column.key });
                  }}
                  onDragEnd={() => {
                    setDropTargetKey(null);
                    moves?.onCardDragEnd();
                  }}
                  className={cn(
                    'select-none rounded-md border bg-card p-3 transition-opacity',
                    isDragged && 'opacity-50',
                    isPending && 'cursor-wait opacity-70',
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal p-0 text-left hover:bg-transparent"
                    onClick={() => {
                      if (isPending) return;
                      onOpenTask(task);
                    }}
                    onKeyDown={(event) => handleCardKeyDown(event, task, columnIndex)}
                    aria-label={ariaLabel}
                    aria-disabled={isPending || undefined}
                    data-task-id={task.remoteId}
                    ref={(element) => registerCard(task.remoteId, element)}
                  >
                    <span className="min-w-0 space-y-2">
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{task.remoteId}</span>
                        {task.isSubtask ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Subtask
                          </span>
                        ) : null}
                        {hasGroupedSubtasks ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {groupedSubtaskCountText(task.groupedSubtaskCount)}
                          </span>
                        ) : null}
                      </span>
                      <span className="block font-medium leading-snug">{task.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        Status:{' '}
                        <span className="font-medium text-foreground">{task.statusName}</span>
                      </span>
                      {task.dueAt ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarDays className="h-3 w-3" aria-hidden="true" />
                          Due {formatDate(task.dueAt)}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  {link?.linked && link.epicId ? (
                    <div className="mt-3 border-t pt-2 text-xs">
                      <span className="text-muted-foreground">
                        DevChain project: {link.projectName ?? 'Unknown'}
                      </span>{' '}
                      <Link
                        to={`/epics/${link.epicId}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        Open DevChain task
                      </Link>
                    </div>
                  ) : quickImportAvailable ? (
                    <div className="mt-3 border-t pt-2 text-xs">
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-xs font-medium underline-offset-4"
                        onClick={() => {
                          if (quickImportPending) return;
                          onQuickImport?.(task);
                        }}
                        aria-disabled={quickImportPending || undefined}
                        data-quick-task-id={task.remoteId}
                        ref={quickActionRef(task.remoteId)}
                      >
                        Create DevChain task
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
