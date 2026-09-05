import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ExternalTaskSubtaskSummary } from '@/modules/external-integrations/models/external-provider.models';
import { Button } from '@/ui/components/ui/button';
import type { ExternalSubtaskStatusEditor } from '@/ui/hooks/board/useExternalSubtaskStatusEditor';
import { useExternalSubtaskStatusEditor } from '@/ui/hooks/board/useExternalSubtaskStatusEditor';
import {
  externalTaskStatusOptionLabel,
  safeExternalTaskUrl,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

/** One shared announcement for a confirmed subtask status update. */
export const SUBTASK_STATUS_UPDATED_ANNOUNCEMENT = 'Subtask status updated.';

function currentStatusOptionValue(status: { remoteId: string | null; name: string }): string {
  return `current-status:${status.remoteId ?? status.name}`;
}

function statusPill(name: string) {
  return (
    <span className="inline-flex max-w-full break-words rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      {name}
    </span>
  );
}

function SubtaskStatusValue({
  subtask,
  editor,
  summaryStatusLabel,
  onSelect,
}: {
  subtask: ExternalTaskSubtaskSummary;
  editor: ExternalSubtaskStatusEditor | null;
  summaryStatusLabel: string;
  onSelect: (actionValue: string) => void;
}) {
  switch (editor?.phase) {
    case 'ready':
      return (
        <select
          aria-label={`Change status for ${subtask.remoteKey}`}
          autoComplete="off"
          value={currentStatusOptionValue(editor.currentStatus)}
          onChange={(event) => onSelect(event.target.value)}
          className="h-8 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value={currentStatusOptionValue(editor.currentStatus)} disabled>
            {editor.currentStatus.name}
          </option>
          {editor.options.map((option) => (
            <option key={option.actionValue} value={option.actionValue}>
              {externalTaskStatusOptionLabel(option)}
            </option>
          ))}
        </select>
      );
    case 'pending':
      return statusPill(externalTaskStatusOptionLabel(editor.selectedStatus));
    case 'unavailable':
      return statusPill(editor.currentStatus.name);
    default:
      return statusPill(summaryStatusLabel);
  }
}

/**
 * Projection of a parent task's direct remote subtasks. Each row renders its
 * current status from the parent detail alone; the status control performs no
 * child request until it is activated, and every loading, unsupported, error,
 * retry, pending, and success state stays inside the activated row. A row
 * links out only when the shared provider-origin URL policy accepts the child
 * URL, and no row offers comment, time, import, DevChain-link, or bulk
 * actions. An empty complete list renders nothing; only a provider-reported
 * partial list keeps the section visible, with its incomplete notice.
 */
export function ExternalTaskSubtasksPanel({
  provider,
  projectId,
  subtasks,
  subtasksTruncated,
  connectionEpoch,
  parentTaskId,
  identityAccepted,
}: {
  provider: ExternalBoardProvider;
  projectId: string | null;
  subtasks: ExternalTaskSubtaskSummary[];
  subtasksTruncated: boolean;
  connectionEpoch: IntegrationConnectionEpoch | null;
  parentTaskId: string | null;
  identityAccepted: boolean;
}) {
  const statusEditor = useExternalSubtaskStatusEditor(provider, {
    projectId,
    connectionEpoch,
    parentTaskId,
    enabled: identityAccepted,
  });
  const editor = statusEditor.editor;
  // The parent detail refetch can serve the pre-update subtask summary while
  // the confirmed write settles, so hold the confirmed label until the
  // refreshed summary no longer shows the pre-update status name.
  const [confirmedHold, setConfirmedHold] = useState<{
    taskId: string;
    label: string;
    previousName: string;
  } | null>(null);
  // Each distinct success publication is a new editor object, so identity
  // here separates "a new confirmed transition" from "the same success
  // re-rendered by a summary update".
  const lastSuccessRef = useRef<Extract<ExternalSubtaskStatusEditor, { phase: 'success' }> | null>(
    null,
  );

  useEffect(() => {
    if (editor?.phase !== 'success') return;
    if (lastSuccessRef.current === editor) return;
    lastSuccessRef.current = editor;
    const summary = subtasks.find((candidate) => candidate.remoteId === editor.taskId);
    if (!summary) return;
    setConfirmedHold({
      taskId: editor.taskId,
      label: externalTaskStatusOptionLabel(editor.confirmedStatus),
      previousName: summary.status.name,
    });
  }, [editor, subtasks]);

  // A hold belongs to one workspace scope: a reused child ID in another
  // parent, connection, or identity admission must not inherit its label.
  const scopeMountedRef = useRef(false);
  useEffect(() => {
    if (!scopeMountedRef.current) {
      scopeMountedRef.current = true;
      return;
    }
    lastSuccessRef.current = null;
    setConfirmedHold(null);
  }, [provider, projectId, connectionEpoch, parentTaskId, identityAccepted]);

  if (subtasks.length === 0 && !subtasksTruncated) return null;

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-4 sm:p-5"
      aria-labelledby="external-task-subtasks-heading"
    >
      <h3 id="external-task-subtasks-heading" className="font-semibold">
        Subtasks
      </h3>
      {subtasksTruncated ? (
        <p className="text-xs text-muted-foreground">
          Incomplete list — the provider did not return every direct subtask.
        </p>
      ) : null}
      <ul className="space-y-2">
        {subtasks.map((subtask) => {
          const sourceUrl = safeExternalTaskUrl(provider, subtask.webUrl);
          const rowEditor = editor?.taskId === subtask.remoteId ? editor : null;
          const holdActive =
            confirmedHold?.taskId === subtask.remoteId &&
            confirmedHold.previousName === subtask.status.name;
          const summaryStatusLabel = holdActive ? confirmedHold.label : subtask.status.name;
          return (
            <li key={subtask.remoteId} className="space-y-1.5 rounded-md border bg-background p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all text-xs font-semibold text-muted-foreground">
                  {subtask.remoteKey}
                </span>
                <SubtaskStatusValue
                  subtask={subtask}
                  editor={rowEditor}
                  summaryStatusLabel={summaryStatusLabel}
                  onSelect={statusEditor.selectStatus}
                />
              </div>
              <p className="break-words text-sm">{subtask.title}</p>
              {identityAccepted ? (
                <div className="space-y-1.5">
                  {rowEditor?.phase === 'loading' ? (
                    <div
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      role="status"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Loading status options
                    </div>
                  ) : null}
                  {rowEditor?.phase === 'unavailable' ? (
                    <p className="text-xs text-muted-foreground">
                      {rowEditor.reason === 'unsupported'
                        ? 'Status changes are unavailable for this subtask.'
                        : 'No status changes are available for this subtask.'}
                    </p>
                  ) : null}
                  {rowEditor?.phase === 'pending' ? (
                    <div
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      role="status"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Updating status
                    </div>
                  ) : null}
                  {rowEditor?.phase === 'error' ? (
                    <>
                      <p className="text-xs text-destructive" role="alert">
                        {rowEditor.error.message}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={statusEditor.retry}
                      >
                        Retry
                      </Button>
                    </>
                  ) : null}
                  {rowEditor?.phase === 'success' && holdActive ? (
                    <p className="text-xs font-medium text-primary" role="status">
                      {SUBTASK_STATUS_UPDATED_ANNOUNCEMENT}
                    </p>
                  ) : null}
                  {rowEditor === null || rowEditor.phase === 'success' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => statusEditor.activate(subtask.remoteId)}
                      disabled={statusEditor.isStatusPending}
                    >
                      Change status<span className="sr-only"> for {subtask.remoteKey}</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${subtask.remoteKey} in source`}
                  className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
                >
                  Open in source <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
