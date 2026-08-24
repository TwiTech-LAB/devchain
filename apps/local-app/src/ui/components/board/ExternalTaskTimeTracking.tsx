import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { ExternalTaskTimeEntry } from '@/modules/external-integrations/models/external-provider.models';
import type { ExternalTimeEntryDeleteResult } from '@/modules/external-integrations/models/external-time-mutation.models';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
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
import type { ExternalTaskTimeEntriesController } from '@/ui/hooks/board/useExternalTaskTimeEntries';
import { useEpicTimeDetail } from '@/ui/hooks/useEpicTimeDetail';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import {
  formatDurationMs,
  MAX_TRACKED_DURATION_MS,
  parseDurationInput,
  resolveStartedAtMs,
} from '@/ui/lib/external-time';
import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

const INVALID_DURATION_MESSAGE =
  'Enter a duration like 15m, 5h, 1h 30m, or bare minutes such as 30 (max 7 days).';

export interface ExternalTaskTimeTrackingProps {
  provider: ExternalBoardProvider;
  taskId: string | null;
  linkedEpicId: string | null;
  connectionEpoch: IntegrationConnectionEpoch | null;
  enabled: boolean;
  identityAccepted: boolean;
  /** Server capability: ClickUp always; Jira only when the site enables it. */
  timeTrackingEnabled: boolean;
  /** From task detail, so the summary total survives history failures. */
  taskTotalDurationMs: number | null;
  sourceUrl: string | null;
  timeEntries: ExternalTaskTimeEntriesController;
  onHistoryOpenChange: (open: boolean) => void;
}

interface EstimateConfirmationSnapshot {
  durationMs: number;
  durationLabel: string;
  scopeLabel: string;
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
 * The "Time tracked" block: a collapsed task-total heading that expands to a
 * duration-first form plus a separate, lazy disclosure for the connected
 * user's own last-30-days entries with safe owned-entry deletion. Every state
 * — loading, empty, error, incomplete, running timer, unknown outcome — stays
 * local here.
 */
export function ExternalTaskTimeTracking({
  provider,
  taskId,
  linkedEpicId = null,
  connectionEpoch,
  enabled,
  identityAccepted,
  timeTrackingEnabled,
  taskTotalDurationMs,
  sourceUrl,
  timeEntries,
  onHistoryOpenChange,
}: ExternalTaskTimeTrackingProps) {
  const disclosureScope = `${provider}:${connectionEpoch ?? ''}:${taskId ?? ''}`;
  const [timeDisclosure, setTimeDisclosure] = useState({
    scope: disclosureScope,
    open: false,
  });
  const [historyDisclosure, setHistoryDisclosure] = useState({
    scope: disclosureScope,
    open: false,
  });
  const timeOpen = timeDisclosure.scope === disclosureScope && timeDisclosure.open;
  const historyOpen =
    timeOpen && historyDisclosure.scope === disclosureScope && historyDisclosure.open;
  const blockAccepted = enabled && identityAccepted;
  const epicTime = useEpicTimeDetail(linkedEpicId, {
    enabled: blockAccepted && timeOpen && timeTrackingEnabled && linkedEpicId !== null,
  });
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [exactStart, setExactStart] = useState('');
  const [showExactStart, setShowExactStart] = useState(false);
  const [durationError, setDurationError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ExternalTaskTimeEntry | null>(null);
  const [focusRestoreIndex, setFocusRestoreIndex] = useState<number | null>(null);
  const [estimateSnapshot, setEstimateSnapshot] = useState<EstimateConfirmationSnapshot | null>(
    null,
  );

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
    setEstimateSnapshot(null);
  }, [taskId, connectionEpoch, provider]);

  useEffect(
    () => () => {
      onHistoryOpenChange(false);
    },
    [onHistoryOpenChange],
  );

  const toggleTimeDisclosure = () => {
    const open = !timeOpen;
    setTimeDisclosure({ scope: disclosureScope, open });
    if (!open) {
      setHistoryDisclosure({ scope: disclosureScope, open: false });
      onHistoryOpenChange(false);
    }
  };

  const handleHistoryToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const open = event.currentTarget.open;
    setHistoryDisclosure({ scope: disclosureScope, open });
    onHistoryOpenChange(open);
  };

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
    timeEntries.submitCreate(
      {
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs,
        note: note.trim() || null,
      },
      'manual',
    );
  };

  useEffect(() => {
    if (timeEntries.create.isSuccess && timeEntries.create.data?.outcome === 'created') {
      if (timeEntries.createOrigin === 'manual') {
        setDuration('');
        setNote('');
        setExactStart('');
        setAnnouncement('Time entry added.');
      } else if (timeEntries.createOrigin === 'estimate') {
        setAnnouncement('DevChain estimate added.');
      }
    }
  }, [timeEntries.create.isSuccess, timeEntries.create.data, timeEntries.createOrigin]);

  useEffect(() => {
    if (timeEntries.delete.isSuccess && timeEntries.delete.data) {
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
    if (timeEntries.verify.isSuccess && timeEntries.verify.data) {
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

  const openEstimateConfirmation = () => {
    const summary = epicTime.summary;
    if (!summary || summary.totalMinutes <= 0 || timeEntries.writeBlocked) return;
    const durationMs = summary.totalMinutes * 60_000;
    if (durationMs > MAX_TRACKED_DURATION_MS) return;
    setEstimateSnapshot({
      durationMs,
      durationLabel: formatEpicTimeMinutes(summary.totalMinutes),
      scopeLabel: summary.isRoot
        ? 'Total including sub-epics'
        : (summary.taskItems[0]?.epicTitle ?? 'Task total'),
    });
  };

  const confirmEstimate = () => {
    if (!estimateSnapshot || timeEntries.writeBlocked) return;
    const confirmedAtMs = Date.now();
    const startedAtMs = resolveStartedAtMs(estimateSnapshot.durationMs, '', confirmedAtMs);
    if (startedAtMs === null) return;
    timeEntries.submitCreate(
      {
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: estimateSnapshot.durationMs,
        note: 'DevChain estimated agent time',
      },
      'estimate',
    );
  };

  const history = timeEntries.history;
  const summaryTotal =
    taskTotalDurationMs !== null ? formatDurationMs(taskTotalDurationMs) : 'No time tracked';
  const manualCreatePending = timeEntries.create.isPending && timeEntries.createOrigin === 'manual';
  const manualCreateError = timeEntries.create.isError && timeEntries.createOrigin === 'manual';
  const estimateCreateError = timeEntries.create.isError && timeEntries.createOrigin === 'estimate';

  return (
    <section
      className="space-y-4 rounded-md border border-l-4 border-l-primary bg-card p-4"
      aria-labelledby="external-task-time-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="external-task-time-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-semibold text-balance"
        >
          Time tracked
        </h3>
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{summaryTotal}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`${timeOpen ? 'Collapse' : 'Expand'} Time tracked`}
            aria-expanded={timeOpen}
            aria-controls="external-task-time-content"
            onClick={toggleTimeDisclosure}
          >
            <ChevronRight
              className={timeOpen ? 'h-4 w-4 rotate-90' : 'h-4 w-4'}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      <div id="external-task-time-content" hidden={!timeOpen}>
        {blockAccepted ? (
          <div className="space-y-4">
            {timeTrackingEnabled ? (
              <>
                {linkedEpicId !== null ? (
                  <section
                    className="space-y-3 rounded-md border bg-muted/30 p-3"
                    aria-labelledby="devchain-time-estimate-heading"
                  >
                    <div className="space-y-1">
                      <h4 id="devchain-time-estimate-heading" className="text-sm font-semibold">
                        DevChain estimated time tracked
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        DevChain derives this estimate from agent activity.
                      </p>
                    </div>
                    {epicTime.query.isLoading ? (
                      <p className="text-sm text-muted-foreground" role="status">
                        Loading DevChain estimate…
                      </p>
                    ) : null}
                    {epicTime.query.isError ? (
                      <p className="text-sm text-destructive" role="alert">
                        DevChain estimate is unavailable.
                      </p>
                    ) : null}
                    {epicTime.summary ? (
                      <>
                        {epicTime.summary.totalMinutes === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No estimated agent time recorded yet.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-3 text-sm">
                              <span className="font-medium">
                                {epicTime.summary.isRoot ? 'Total including sub-epics' : 'Total'}
                              </span>
                              <span className="font-semibold tabular-nums">
                                {formatEpicTimeMinutes(epicTime.summary.totalMinutes)}
                              </span>
                            </div>
                            <ul className="space-y-1" aria-label="Contributing DevChain tasks">
                              {epicTime.summary.taskItems.map((item) => (
                                <li
                                  key={item.epicId}
                                  className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
                                >
                                  <span className="min-w-0 break-words">{item.epicTitle}</span>
                                  <span className="shrink-0 tabular-nums">
                                    {formatEpicTimeMinutes(item.minutes)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {epicTime.summary.totalMinutes * 60_000 > MAX_TRACKED_DURATION_MS ? (
                              <p className="text-xs text-destructive">
                                The estimate exceeds the 7-day limit for one time entry.
                              </p>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                onClick={openEstimateConfirmation}
                                disabled={timeEntries.writeBlocked}
                              >
                                Log full estimate —{' '}
                                {formatEpicTimeMinutes(epicTime.summary.totalMinutes)}
                              </Button>
                            )}
                            {estimateCreateError ? (
                              <p role="alert" className="text-xs text-destructive">
                                {getErrorMessage(
                                  timeEntries.create.error,
                                  'The DevChain estimate could not be submitted.',
                                )}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </>
                    ) : null}
                  </section>
                ) : null}
                <form className="space-y-3" onSubmit={handleSubmit} aria-label="Log time">
                  <div className="space-y-1.5">
                    <Label htmlFor="external-task-duration">Duration</Label>
                    <Input
                      id="external-task-duration"
                      ref={durationInputRef}
                      type="text"
                      name="duration"
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="Example: 15m, 5h, 1h 30m, or 30…"
                      value={duration}
                      onChange={(event) => {
                        setDuration(event.target.value);
                        if (durationError) setDurationError(null);
                      }}
                      aria-invalid={durationError !== null}
                      aria-describedby={durationError ? 'external-task-duration-error' : undefined}
                      disabled={manualCreatePending}
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
                      name="note"
                      autoComplete="off"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={10_000}
                      disabled={manualCreatePending}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={showExactStart}
                      aria-controls="external-task-exact-start"
                      onClick={() => setShowExactStart((value) => !value)}
                    >
                      {showExactStart ? 'Hide exact start time' : 'Add exact start time (optional)'}
                    </Button>
                    {showExactStart ? (
                      <div id="external-task-exact-start" className="space-y-1.5">
                        <Label htmlFor="external-task-started-at">Started at</Label>
                        <Input
                          id="external-task-started-at"
                          type="datetime-local"
                          name="startedAt"
                          autoComplete="off"
                          value={exactStart}
                          onChange={(event) => setExactStart(event.target.value)}
                          disabled={manualCreatePending}
                        />
                      </div>
                    ) : null}
                  </div>
                  <Button type="submit" disabled={timeEntries.writeBlocked}>
                    {manualCreatePending ? 'Submitting…' : 'Log time'}
                  </Button>
                  {manualCreateError ? (
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
                        The provider was contacted but the result is unknown, so this form is
                        locked. Check the entry in the source before logging time again.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => timeEntries.verifyUnknown(timeEntries.unknownOperationId!)}
                          disabled={timeEntries.verify.isPending}
                          hidden={!timeEntries.canVerifyUnknown}
                        >
                          {timeEntries.verify.isPending ? 'Verifying…' : 'Verify'}
                        </Button>
                        {sourceUrl ? (
                          <Button asChild size="sm" variant="outline">
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
                        Acknowledging accepts that the provider may hold a duplicate entry; it
                        unlocks this form without sending anything.
                      </p>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <details
                  open={historyOpen}
                  className="rounded-md border bg-background/40"
                  onToggle={handleHistoryToggle}
                >
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    Recent time entries
                  </summary>
                  <div className="space-y-2 border-t px-3 py-3">
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
                                className="grid min-w-0 gap-3 rounded-md border px-3 py-2 text-sm sm:grid-cols-[minmax(5rem,auto)_minmax(10rem,1fr)_minmax(0,2fr)_auto] sm:items-center"
                              >
                                <div className="min-w-0">
                                  <span className="block text-xs text-muted-foreground sm:sr-only">
                                    Duration
                                  </span>
                                  <span className="block font-medium tabular-nums">
                                    {formatDurationMs(entry.durationMs)}
                                  </span>
                                </div>
                                <div className="min-w-0">
                                  <span className="block text-xs text-muted-foreground sm:sr-only">
                                    Started
                                  </span>
                                  <time
                                    dateTime={entry.startedAt}
                                    className="block text-xs text-muted-foreground tabular-nums"
                                  >
                                    {new Date(entry.startedAt).toLocaleString()}
                                  </time>
                                </div>
                                <div className="min-w-0">
                                  <span className="block text-xs text-muted-foreground sm:sr-only">
                                    Note
                                  </span>
                                  {entry.note ? (
                                    <p className="break-words text-xs text-muted-foreground">
                                      {entry.note}
                                      {entry.noteTruncated ? ' (note was shortened)' : ''}
                                    </p>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">No note</span>
                                  )}
                                </div>
                                {entry.canDelete ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="justify-self-start text-destructive sm:justify-self-end"
                                    data-entry-delete
                                    aria-label={`Delete ${formatDurationMs(entry.durationMs)} entry started ${new Date(entry.startedAt).toLocaleString()}`}
                                    onClick={() => requestDeleteConfirmation(entry)}
                                    disabled={timeEntries.writeBlocked}
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
                </details>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Time tracking is unavailable.</p>
            )}
            <p role="status" className="sr-only">
              {announcement}
            </p>
          </div>
        ) : null}
      </div>

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
                disabled={timeEntries.writeBlocked}
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
      <ConfirmDialog
        open={estimateSnapshot !== null}
        onOpenChange={(open) => {
          if (!open) setEstimateSnapshot(null);
        }}
        title="Log the full DevChain estimate?"
        description={
          estimateSnapshot ? (
            <span className="space-y-2">
              <span className="block font-medium text-foreground">
                {estimateSnapshot.scopeLabel}: {estimateSnapshot.durationLabel}
              </span>
              <span className="block">
                This creates a new full-total time entry. DevChain does not deduct existing provider
                time or earlier estimate entries.
              </span>
              <span className="block">
                Confirming again later creates another full-total entry.
              </span>
            </span>
          ) : (
            ''
          )
        }
        confirmText="Log full estimate"
        cancelText="Cancel"
        onConfirm={confirmEstimate}
      />
    </section>
  );
}
