import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ExternalTaskTimeEntry } from '@/modules/external-integrations/models/external-provider.models';
import type { ExternalTimeEntryDeleteResult } from '@/modules/external-integrations/models/external-time-mutation.models';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { useExternalTaskTimeEntries } from '@/ui/hooks/board/useExternalTaskTimeEntries';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { formatDurationMs, parseDurationInput, resolveStartedAtMs } from '@/ui/lib/external-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

const INVALID_DURATION_MESSAGE =
  'Enter a duration like 15m, 5h, 1h 30m, or bare minutes such as 30 (max 7 days).';

export interface ExternalTaskTimeTrackingProps {
  provider: ExternalBoardProvider;
  taskId: string | null;
  connectionEpoch: IntegrationConnectionEpoch | null;
  enabled: boolean;
  identityAccepted: boolean;
  /** Server capability: ClickUp always; Jira only when the site enables it. */
  timeTrackingEnabled: boolean;
  /** From task detail, so the summary total survives history failures. */
  taskTotalDurationMs: number | null;
  sourceUrl: string | null;
}

function verifyResolutionMessage(resolution: string): string {
  switch (resolution) {
    case 'created':
      return 'Verified: the time entry was created.';
    case 'deleted':
      return 'Verified: the entry was deleted.';
    case 'already_deleted':
      return 'Verified: the entry was already deleted.';
    case 'not_applied':
      return 'Verified: the change never reached the provider.';
    case 'completeness_not_provable':
      return 'The provider cannot prove what happened. Acknowledge the risk to continue.';
    default:
      return 'The outcome could not be verified yet. Try again or open the source.';
  }
}

function deleteOutcomeMessage(outcome: ExternalTimeEntryDeleteResult['outcome']): string {
  switch (outcome) {
    case 'already_deleted':
      return 'Entry was already deleted.';
    case 'not_applied':
      return 'The entry was not applied; nothing was deleted.';
    case 'outcome_unknown':
      return 'The delete result is unconfirmed. Verify it before retrying.';
    case 'deleted':
      return 'Time entry deleted.';
  }
}

/**
 * The "Time tracked" block: a collapsed summary of the task's total tracked
 * time and an expanded duration-first form plus the connected user's own
 * last-30-days entries with safe owned-entry deletion. Every state —
 * loading, empty, error, incomplete, running timer, unknown outcome — stays
 * local to this block.
 */
export function ExternalTaskTimeTracking({
  provider,
  taskId,
  connectionEpoch,
  enabled,
  identityAccepted,
  timeTrackingEnabled,
  taskTotalDurationMs,
  sourceUrl,
}: ExternalTaskTimeTrackingProps) {
  const [expanded, setExpanded] = useState(false);
  const blockAccepted = enabled && identityAccepted;
  const timeEntries = useExternalTaskTimeEntries(provider, taskId, {
    enabled: enabled && expanded,
    connectionEpoch,
    identityAccepted,
    timeTrackingEnabled,
  });
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [exactStart, setExactStart] = useState('');
  const [showExactStart, setShowExactStart] = useState(false);
  const [durationError, setDurationError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ExternalTaskTimeEntry | null>(null);
  const [focusRestoreIndex, setFocusRestoreIndex] = useState<number | null>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const durationInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    setDuration('');
    setNote('');
    setExactStart('');
    setShowExactStart(false);
    setDurationError(null);
    setAnnouncement('');
    setDeleteTarget(null);
  }, [taskId, connectionEpoch]);

  // Focus restoration runs only after the confirmation dialog has closed, so
  // focus never moves behind an active modal: the next remaining row's
  // Delete button, else the duration form, else the section heading.
  useEffect(() => {
    if (deleteTarget !== null || focusRestoreIndex === null) return;
    if (timeEntries.delete.isPending) return;
    const rows = listRef.current
      ? [...listRef.current.querySelectorAll<HTMLLIElement>('li[data-entry-id]')]
      : [];
    const row = rows[focusRestoreIndex] ?? rows[rows.length - 1];
    const deleteButton = row?.querySelector<HTMLButtonElement>('button[data-entry-delete]');
    if (deleteButton) {
      deleteButton.focus();
    } else if (durationInputRef.current) {
      durationInputRef.current.focus();
    } else {
      headingRef.current?.focus();
    }
    setFocusRestoreIndex(null);
  }, [deleteTarget, focusRestoreIndex, timeEntries.delete.isPending, timeEntries.history.data]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const durationMs = parseDurationInput(duration);
    if (durationMs === null) {
      setDurationError(INVALID_DURATION_MESSAGE);
      return;
    }
    // One browser timestamp per submit; without an exact start the interval
    // ends at that moment.
    const startedAtMs = resolveStartedAtMs(
      durationMs,
      showExactStart ? exactStart : '',
      Date.now(),
    );
    if (startedAtMs === null) {
      setDurationError('Enter a valid exact start time.');
      return;
    }
    setDurationError(null);
    timeEntries.submitCreate({
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs,
      note: note.trim() || null,
    });
  };

  useEffect(() => {
    if (timeEntries.create.isSuccess && timeEntries.create.data.outcome === 'created') {
      setDuration('');
      setNote('');
      setExactStart('');
      setAnnouncement('Time entry added.');
    }
  }, [timeEntries.create.isSuccess, timeEntries.create.data]);

  useEffect(() => {
    if (timeEntries.delete.isSuccess) {
      const outcome = timeEntries.delete.data.outcome;
      setAnnouncement(deleteOutcomeMessage(outcome));
      if (outcome === 'outcome_unknown') {
        return;
      }
      setDeleteTarget(null);
    }
  }, [timeEntries.delete.isSuccess, timeEntries.delete.data]);

  useEffect(() => {
    if (timeEntries.delete.isError) {
      // The confirmation stays mounted; the live region carries the same
      // failure to assistive technology.
      setAnnouncement('The time entry could not be deleted.');
    }
  }, [timeEntries.delete.isError]);

  useEffect(() => {
    if (timeEntries.verify.isSuccess) {
      setAnnouncement(verifyResolutionMessage(timeEntries.verify.data.resolution));
    }
  }, [timeEntries.verify.isSuccess, timeEntries.verify.data]);

  const requestDeleteConfirmation = (entry: ExternalTaskTimeEntry) => {
    // A fresh confirmation must never inherit the previous entry's failure.
    timeEntries.delete.reset();
    setDeleteTarget(entry);
  };

  const confirmDelete = () => {
    if (!deleteTarget || timeEntries.delete.isPending || timeEntries.blockedByUnknown) return;
    const entries = timeEntries.history.data?.entries ?? [];
    setFocusRestoreIndex(entries.findIndex((entry) => entry.remoteId === deleteTarget.remoteId));
    timeEntries.submitDelete(deleteTarget.remoteId);
    // deleteTarget stays set: the dialog remains mounted until the mutation
    // settles so the error renderer survives a rejection.
  };

  const history = timeEntries.history;
  const summaryTotal =
    taskTotalDurationMs !== null ? formatDurationMs(taskTotalDurationMs) : 'No time tracked';

  return (
    <details
      className="group rounded-md border"
      onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}
    >
      <summary
        className="cursor-pointer select-none p-3 text-sm font-medium"
        onClick={() => setExpanded((value) => !value)}
      >
        Time tracked <span className="ml-1 font-normal text-muted-foreground">{summaryTotal}</span>
      </summary>
      {blockAccepted ? (
        <div className="space-y-4 p-3 pt-0">
          <h4
            id="external-task-time-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold"
          >
            Time tracked
          </h4>
          {timeTrackingEnabled ? (
            <>
              <form className="space-y-3" onSubmit={handleSubmit} aria-label="Log time">
                <div className="space-y-1.5">
                  <Label htmlFor="external-task-duration">Duration</Label>
                  <Input
                    id="external-task-duration"
                    ref={durationInputRef}
                    type="text"
                    inputMode="numeric"
                    placeholder="15m, 5h, 1h 30m, or 30"
                    value={duration}
                    onChange={(event) => {
                      setDuration(event.target.value);
                      if (durationError) setDurationError(null);
                    }}
                    aria-invalid={durationError !== null}
                    aria-describedby={durationError ? 'external-task-duration-error' : undefined}
                    disabled={timeEntries.create.isPending}
                  />
                  {durationError ? (
                    <p id="external-task-duration-error" className="text-xs text-destructive">
                      {durationError}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="external-task-time-note">Note (optional)</Label>
                  <Textarea
                    id="external-task-time-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    maxLength={10_000}
                    disabled={timeEntries.create.isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <button
                    type="button"
                    className="text-xs underline underline-offset-4"
                    aria-expanded={showExactStart}
                    onClick={() => setShowExactStart((value) => !value)}
                  >
                    Add exact start time (optional)
                  </button>
                  {showExactStart ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="external-task-started-at">Started at</Label>
                      <Input
                        id="external-task-started-at"
                        type="datetime-local"
                        value={exactStart}
                        onChange={(event) => setExactStart(event.target.value)}
                        disabled={timeEntries.create.isPending}
                      />
                    </div>
                  ) : null}
                </div>
                <Button
                  type="submit"
                  disabled={timeEntries.create.isPending || timeEntries.blockedByUnknown}
                >
                  {timeEntries.create.isPending ? 'Submitting…' : 'Log time'}
                </Button>
                {timeEntries.create.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {getErrorMessage(
                      timeEntries.create.error,
                      'The time entry could not be submitted.',
                    )}
                  </p>
                ) : null}
              </form>

              {timeEntries.blockedByUnknown && timeEntries.unknownOperationId ? (
                <Alert variant="destructive">
                  <AlertTitle>Last submission unconfirmed</AlertTitle>
                  <AlertDescription>
                    <p>
                      The provider was contacted but the result is unknown, so this form is locked.
                      Check the entry in the source before logging time again.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => timeEntries.verifyUnknown(timeEntries.unknownOperationId!)}
                        disabled={timeEntries.verify.isPending}
                      >
                        {timeEntries.verify.isPending ? 'Verifying…' : 'Verify'}
                      </Button>
                      {sourceUrl ? (
                        <Button asChild type="button" size="sm" variant="outline">
                          <a href={sourceUrl} target="_blank" rel="noreferrer">
                            Open in source{' '}
                            <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          timeEntries.acknowledgeUnknown(timeEntries.unknownOperationId!)
                        }
                        disabled={timeEntries.acknowledge.isPending}
                      >
                        Acknowledge duplicate risk
                      </Button>
                    </div>
                    <p className="mt-2 text-xs">
                      Acknowledging accepts that the provider may hold a duplicate entry; it unlocks
                      this form without sending anything.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <p className="text-sm font-medium">Your entries · last 30 days</p>
                {history.isLoading ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Loading time entries…
                  </p>
                ) : null}
                {history.isError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Time entries unavailable</AlertTitle>
                    <AlertDescription>
                      {getErrorMessage(history.error, 'Time entries could not be loaded.')}
                    </AlertDescription>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => void history.refetch()}
                    >
                      Retry
                    </Button>
                  </Alert>
                ) : null}
                {history.data ? (
                  <>
                    {history.data.hasRunningTimer ? (
                      <p className="text-xs text-muted-foreground" role="status">
                        A running timer is active in the provider.
                      </p>
                    ) : null}
                    {history.data.truncated ? (
                      <p className="text-xs text-muted-foreground">
                        Incomplete list — the provider did not return the full 30-day window.
                      </p>
                    ) : null}
                    {history.data.entries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No entries in the last 30 days.
                      </p>
                    ) : (
                      <ul ref={listRef} className="space-y-2" aria-label="Your time entries">
                        {history.data.entries.map((entry) => (
                          <li
                            key={entry.remoteId}
                            data-entry-id={entry.remoteId}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm"
                          >
                            <div className="min-w-0">
                              <span className="font-medium">
                                {formatDurationMs(entry.durationMs)}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                <time dateTime={entry.startedAt}>
                                  {new Date(entry.startedAt).toLocaleString()}
                                </time>
                              </span>
                              {entry.note ? (
                                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                                  {entry.note}
                                  {entry.noteTruncated ? ' (note was shortened)' : ''}
                                </p>
                              ) : null}
                            </div>
                            {entry.canDelete ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive"
                                data-entry-delete
                                onClick={() => requestDeleteConfirmation(entry)}
                                disabled={
                                  timeEntries.delete.isPending || timeEntries.blockedByUnknown
                                }
                              >
                                Delete
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Time tracking is unavailable.</p>
          )}
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </div>
      ) : null}

      {deleteTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            // While the deletion is in flight the dialog must not dismiss:
            // Escape, outside click, and the close button all stay inert.
            if (!open && timeEntries.delete.isPending) return;
            if (!open) setDeleteTarget(null);
          }}
        >
          <DialogContent
            className="max-w-md"
            showCloseButton={!timeEntries.delete.isPending}
            onEscapeKeyDown={(event) => {
              if (timeEntries.delete.isPending) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (timeEntries.delete.isPending) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (timeEntries.delete.isPending) event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete this time entry?</DialogTitle>
              <DialogDescription>
                This permanently removes the {formatDurationMs(deleteTarget.durationMs)} entry
                started {new Date(deleteTarget.startedAt).toLocaleString()} from the provider. This
                action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
                disabled={timeEntries.delete.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmDelete}
                disabled={timeEntries.delete.isPending || timeEntries.blockedByUnknown}
              >
                {timeEntries.delete.isPending ? 'Deleting…' : 'Delete entry'}
              </Button>
            </div>
            {timeEntries.delete.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {getErrorMessage(timeEntries.delete.error, 'The time entry could not be deleted.')}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </details>
  );
}
