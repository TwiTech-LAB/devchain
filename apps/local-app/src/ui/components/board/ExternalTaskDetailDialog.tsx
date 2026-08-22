import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import { ExternalTaskCommentsPanel } from '@/ui/components/board/ExternalTaskCommentsPanel';
import { ExternalTaskTimeTracking } from '@/ui/components/board/ExternalTaskTimeTracking';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Label } from '@/ui/components/ui/label';
import { useExternalTaskController } from '@/ui/hooks/board/useExternalTaskController';
import { useExternalRichDescriptionEdit } from '@/ui/hooks/board/useExternalRichDescriptionEdit';
import { ExternalTaskRichDescription } from '@/ui/components/board/ExternalTaskRichDescription';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import {
  externalBoardProviderLabel,
  externalTaskStatusOptionLabel,
  safeExternalTaskUrl,
} from '@/ui/lib/external-board';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

export interface ExternalTaskDetailDialogProps {
  provider: ExternalBoardProvider;
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateDevChainTask?: (detail: ExternalTaskDetail) => void;
  enabled?: boolean;
  connectionEpoch: IntegrationConnectionEpoch | null;
  /**
   * When set, this dialog is the DevChain linked-task workspace: detail,
   * comments, composer, and actions stay hidden until the loaded task links
   * to exactly this Epic, so a replaced connection cannot expose another
   * account's task that merely reuses the remote ID.
   */
  expectedLinkedEpicId?: string | null;
  /** Focus target when this dialog closes; defaults to the heading fallback. */
  returnFocusTo?: () => HTMLElement | null;
  /**
   * Receives the dialog's Import return-focus resolver: the Create button when
   * present, otherwise the heading. The page passes it to the nested Import
   * dialog so closing Import refocuses this dialog's real origin.
   */
  onImportFocusTargetReady?: (resolve: (() => HTMLElement | null) | null) => void;
}

function supports(detail: ExternalTaskDetail, action: string): boolean {
  return detail.actions.some((capability) => capability.action === action && capability.supported);
}

function currentStatusOptionValue(detail: ExternalTaskDetail): string {
  return `current-status:${detail.status.remoteId ?? detail.status.name}`;
}

/** `add_comment` is absent on purpose: its success is announced by the comments panel. */
function mutationSuccessLabel(action: string | undefined): string | null {
  if (action === 'change_status') return 'Status updated.';
  return null;
}

function taskDialogDescription(
  providerLabel: string,
  detail: ExternalTaskDetail | undefined,
  identityMismatch: boolean,
): string {
  if (identityMismatch) return `${providerLabel} · Linked task unavailable`;
  if (detail) return `${providerLabel} · ${detail.remoteKey} · ${detail.location.workAreaName}`;
  return `${providerLabel} · Loading task detail`;
}

export function ExternalTaskDetailDialog({
  provider,
  taskId,
  open,
  onOpenChange,
  onCreateDevChainTask,
  enabled = true,
  connectionEpoch,
  expectedLinkedEpicId,
  returnFocusTo,
  onImportFocusTargetReady,
}: ExternalTaskDetailDialogProps) {
  const controller = useExternalTaskController(provider, taskId, {
    enabled: enabled && open,
    connectionEpoch,
    expectedLinkedEpicId,
  });
  const detail = enabled ? controller.detail.data : undefined;
  const richEdit = useExternalRichDescriptionEdit(provider, connectionEpoch, taskId, {
    enabled: enabled && open && controller.identityAccepted,
  });
  const sourceUrl = detail ? safeExternalTaskUrl(provider, detail.webUrl) : null;
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!onImportFocusTargetReady) return;
    onImportFocusTargetReady(() => createButtonRef.current ?? headingRef.current);
    return () => onImportFocusTargetReady(null);
  }, [onImportFocusTargetReady]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setStatus('');
    controller.mutation.reset();
  }, [taskId]);

  useEffect(() => {
    setStatus('');
  }, [detail?.status.name, detail?.status.remoteId]);

  const handleStatusChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextStatus = event.target.value;
    if (!detail || !nextStatus || controller.mutation.isPending) return;
    const selected = detail.allowedStatuses.find(
      (candidate) => candidate.actionValue === nextStatus,
    );
    if (!selected) return;
    setStatus(nextStatus);
    controller.mutation.mutate(
      {
        action: 'change_status',
        input: { status: selected.actionValue },
      },
      {
        onError: () => setStatus(''),
      },
    );
  };

  const handleCreate = () => {
    if (detail) onCreateDevChainTask?.(detail);
  };

  const successMessage = mutationSuccessLabel(controller.mutation.data?.action);
  const providerLabel = externalBoardProviderLabel(provider);
  let devChainAction: ReactNode = null;
  if (expectedLinkedEpicId == null && detail?.linkState.linked && detail.linkState.epicId) {
    devChainAction = (
      <Button asChild variant="outline" size="sm">
        <Link to={`/epics/${detail.linkState.epicId}`}>Open linked DevChain task</Link>
      </Button>
    );
  } else if (expectedLinkedEpicId == null && detail) {
    devChainAction = (
      <Button
        type="button"
        size="sm"
        onClick={handleCreate}
        disabled={!onCreateDevChainTask}
        ref={createButtonRef}
      >
        Create DevChain task
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 p-0 sm:rounded-lg"
        onCloseAutoFocus={(event) => {
          // Prefer the owner's Kanban focus target; fall back to this dialog's
          // heading so focus never lands on document.body.
          const target = returnFocusTo?.() ?? headingRef.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader className="flex flex-none flex-wrap items-start justify-between gap-3 border-b p-5 pr-14">
          <div className="min-w-0">
            {/* The fallback ref keeps the last attached node: on unmount React
                nulls refs before Radix runs onCloseAutoFocus, and the heading
                must stay resolvable through the close lifecycle. */}
            <DialogTitle
              className="break-words"
              tabIndex={-1}
              ref={(node) => {
                if (node) headingRef.current = node;
              }}
            >
              {detail?.title ?? 'Remote task'}
            </DialogTitle>
            <DialogDescription>
              {taskDialogDescription(providerLabel, detail, controller.identityMismatch)}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sourceUrl ? (
              <Button asChild type="button" variant="outline" size="sm">
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  Open in source <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </Button>
            ) : null}
            {/* The linked workspace already sits on the expected Epic's own
                context, so devChainAction is intentionally empty there. */}
            {devChainAction}
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[65fr_35fr]">
          <div className="min-h-0 space-y-6 overflow-y-auto overscroll-contain p-5">
            {controller.detail.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading task detail
              </div>
            ) : null}

            {controller.detail.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Task detail unavailable</AlertTitle>
                <AlertDescription>
                  {getErrorMessage(controller.detail.error, 'Task detail could not be loaded.')}
                </AlertDescription>
              </Alert>
            ) : null}

            {controller.identityMismatch && expectedLinkedEpicId != null ? (
              <Alert variant="destructive">
                <AlertTitle>Linked task unavailable for the current connection</AlertTitle>
                <AlertDescription>
                  <p>The remote task is not linked to the expected DevChain task.</p>
                  <Link
                    to={`/epics/${expectedLinkedEpicId}`}
                    className="text-sm font-medium underline underline-offset-4"
                  >
                    Open expected DevChain task
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}

            {detail ? (
              <>
                <section className="space-y-3" aria-labelledby="external-task-properties-heading">
                  <h3 id="external-task-properties-heading" className="font-semibold">
                    Properties
                  </h3>
                  <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
                    <dt className="text-muted-foreground">
                      {supports(detail, 'change_status') && detail.allowedStatuses.length > 0 ? (
                        <Label htmlFor="external-task-status">Status</Label>
                      ) : (
                        'Status'
                      )}
                    </dt>
                    <dd className="min-w-0">
                      {supports(detail, 'change_status') && detail.allowedStatuses.length > 0 ? (
                        <select
                          id="external-task-status"
                          value={status || currentStatusOptionValue(detail)}
                          onChange={handleStatusChange}
                          disabled={controller.mutation.isPending}
                          aria-busy={controller.mutation.isPending}
                          className="flex h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium disabled:cursor-wait disabled:opacity-70"
                        >
                          <option value={currentStatusOptionValue(detail)} disabled>
                            {detail.status.name}
                          </option>
                          {detail.allowedStatuses.map((candidate) => (
                            <option key={candidate.actionValue} value={candidate.actionValue}>
                              {externalTaskStatusOptionLabel(candidate)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="inline-flex rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium">
                          {detail.status.name}
                        </span>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Priority</dt>
                    <dd className="font-medium">{detail.priority?.name ?? 'None'}</dd>
                    <dt className="text-muted-foreground">Due</dt>
                    <dd className="font-medium">
                      {detail.dueAt ? new Date(detail.dueAt).toLocaleString() : 'None'}
                    </dd>
                  </dl>
                </section>

                <ExternalTaskRichDescription
                  detail={detail}
                  controller={richEdit}
                  provider={provider}
                  webUrl={detail.webUrl}
                  identityAccepted={controller.identityAccepted}
                />

                <ExternalTaskTimeTracking
                  provider={provider}
                  taskId={taskId}
                  connectionEpoch={connectionEpoch}
                  enabled={enabled && open}
                  identityAccepted={controller.identityAccepted}
                  timeTrackingEnabled={supports(detail, 'log_time')}
                  taskTotalDurationMs={detail.taskTotalDurationMs ?? null}
                  sourceUrl={sourceUrl}
                />

                {controller.mutation.isError &&
                controller.mutation.variables?.action !== 'add_comment' ? (
                  <Alert variant="destructive">
                    <AlertTitle>Remote action failed</AlertTitle>
                    <AlertDescription>
                      {getErrorMessage(
                        controller.mutation.error,
                        'The remote action could not be completed.',
                      )}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {successMessage ? (
                  <p className="text-sm text-emerald-600" role="status">
                    {successMessage}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Mounted only after identity acceptance: an unaccepted linked route
              must not expose cached comments or a composer, and a disabled
              query would still surface its cached data through the panel. */}
          {controller.identityAccepted ? (
            <div className="flex min-h-0 flex-col border-t p-5 lg:border-l lg:border-t-0">
              <ExternalTaskCommentsPanel
                provider={provider}
                taskId={taskId}
                controller={controller}
                canComment={Boolean(detail && supports(detail, 'add_comment'))}
                richEditEnabled={Boolean(richEdit.description?.canEdit)}
                ownedDeleteEnabled={Boolean(richEdit.description?.canDeleteOwnedComments)}
                className="flex min-h-0 flex-1 flex-col border-t-0 pt-0"
                historyClassName="max-h-none min-h-24 flex-1"
              />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
