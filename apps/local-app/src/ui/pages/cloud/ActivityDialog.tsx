import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import {
  OperationDetail,
  OperationStateChip,
  operationSummary,
  operationTitle,
  type ActivityActions,
  type ActivityNames,
} from './OperationDetail';
import { newestFirst } from './remote-status';

export type ActivityView =
  | { mode: 'list' }
  /** `fromList` gives the detail a back link to the list. */
  | { mode: 'detail'; operationId: string; fromList: boolean };

const VIEW_PARAM = 'activity';
const FROM_PARAM = 'activityFrom';
const LIST = 'list';

function writeActivityView(params: URLSearchParams, value: string | null, fromList: boolean) {
  if (value) params.set(VIEW_PARAM, value);
  else params.delete(VIEW_PARAM);
  if (fromList) params.set(FROM_PARAM, LIST);
  else params.delete(FROM_PARAM);
}

/**
 * Writes the Activity view into `params`: the operation's detail, or the list
 * when there is no operation. A detail opened over the list keeps its back link.
 */
export function openActivityInParams(params: URLSearchParams, operationId: string | null): void {
  if (operationId) writeActivityView(params, operationId, params.get(VIEW_PARAM) === LIST);
  else writeActivityView(params, LIST, false);
}

/**
 * Which Activity view is open; closing only hides it and never cancels anything.
 * The view lives in the URL: a Connect of the project selected in the header
 * switches the backend and remounts the page, and the URL outlives the remount.
 */
export function useActivityView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const shown = searchParams.get(VIEW_PARAM);
  const view: ActivityView | null = !shown
    ? null
    : shown === LIST
      ? { mode: 'list' }
      : {
          mode: 'detail',
          operationId: shown,
          fromList: searchParams.get(FROM_PARAM) === LIST,
        };
  const update = useCallback(
    (write: (params: URLSearchParams) => void) =>
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        write(next);
        return next;
      }),
    [setSearchParams],
  );
  const openList = useCallback(() => update((next) => openActivityInParams(next, null)), [update]);
  /** Opens the detail, or moves an open dialog to it. */
  const openDetail = useCallback(
    (operationId: string) => update((next) => openActivityInParams(next, operationId)),
    [update],
  );
  const close = useCallback(() => update((next) => writeActivityView(next, null, false)), [update]);
  return { view, openList, openDetail, close };
}

/** A titled list of operations; each opens its detail. */
export function ActivityGroup({
  title,
  operations,
  names,
  onOpen,
}: {
  title: string;
  operations: RemoteOperationDto[];
  names: ActivityNames;
  onOpen: (operationId: string) => void;
}) {
  if (operations.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <ul className="divide-y rounded-md border">
        {operations.map((operation) => (
          <li key={operation.id}>
            <button
              type="button"
              onClick={() => onOpen(operation.id)}
              className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {operationTitle(operation, names)}
                </span>
                <span className="block break-words text-muted-foreground">
                  {operationSummary(operation)}
                </span>
              </span>
              <OperationStateChip state={operation.state} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Progress of every VM and project operation: a list of running, failed and
 * recently finished work, and the detail of one operation with its actions.
 */
export function ActivityDialog({
  view,
  operations,
  recentFinished,
  names,
  pending,
  error,
  actions,
  onOpenList,
  onOpenDetail,
  onClose,
}: {
  view: ActivityView | null;
  operations: RemoteOperationDto[];
  recentFinished: RemoteOperationDto[];
  names: ActivityNames;
  pending: boolean;
  error: string | null;
  actions: ActivityActions;
  onOpenList: () => void;
  onOpenDetail: (operationId: string) => void;
  onClose: () => void;
}) {
  const running = useMemo(
    () => operations.filter((operation) => operation.state === 'running').sort(newestFirst),
    [operations],
  );
  const failed = useMemo(
    () => operations.filter((operation) => operation.state === 'failed').sort(newestFirst),
    [operations],
  );
  const detail =
    view?.mode === 'detail'
      ? (operations.find((operation) => operation.id === view.operationId) ?? null)
      : null;

  return (
    <Dialog open={view !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto sm:w-full">
        {view?.mode === 'detail' ? (
          <>
            <DialogHeader className="space-y-2">
              {view.fromList && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-auto w-fit px-2 py-1"
                  onClick={onOpenList}
                >
                  <ChevronLeft aria-hidden="true" className="mr-1 h-4 w-4" />
                  All activity
                </Button>
              )}
              <DialogTitle className="break-words pr-6">
                {detail ? operationTitle(detail, names) : 'Activity'}
              </DialogTitle>
              <DialogDescription className="sr-only">
                The steps, notes and actions of this operation.
              </DialogDescription>
            </DialogHeader>
            {detail ? (
              <OperationDetail
                operation={detail}
                names={names}
                pending={pending}
                error={error}
                actions={actions}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                This operation is no longer in the list.
              </p>
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Activity</DialogTitle>
              <DialogDescription>Work on your VMs and projects.</DialogDescription>
            </DialogHeader>
            {running.length + failed.length + recentFinished.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <div className="space-y-4">
                <ActivityGroup
                  title="Running"
                  operations={running}
                  names={names}
                  onOpen={onOpenDetail}
                />
                <ActivityGroup
                  title="Needs attention"
                  operations={failed}
                  names={names}
                  onOpen={onOpenDetail}
                />
                <ActivityGroup
                  title="Finished"
                  operations={recentFinished}
                  names={names}
                  onOpen={onOpenDetail}
                />
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
