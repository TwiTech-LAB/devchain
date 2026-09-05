import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { ChevronRight, Clock3, ExternalLink, PencilLine } from 'lucide-react';
import type {
  ExternalTaskTimeEntry,
  ExternalTaskTimeEntryInput,
} from '@/modules/external-integrations/models/external-provider.models';
import type { ExternalTimeEntryDeleteResult } from '@/modules/external-integrations/models/external-time-mutation.models';
import { ExternalEstimateTimePanel } from '@/ui/components/board/ExternalEstimateTimePanel';
import { ExternalTimeEntryEditDialog } from '@/ui/components/board/ExternalTimeEntryEditDialog';
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
import { useExternalEstimateTimeLog } from '@/ui/hooks/board/useExternalEstimateTimeLog';
import { useEpicTimeDetail } from '@/ui/hooks/useEpicTimeDetail';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { formatDurationMs, parseDurationInput, resolveStartedAtMs } from '@/ui/lib/external-time';
import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

const INVALID_DURATION_MESSAGE =
  'Enter a duration like 15m, 5h, 1h 30m, or bare minutes such as 30 (max 7 days).';

export interface ExternalTaskTimeTrackingProps {
  provider: ExternalBoardProvider;
  taskId: string | null;
  linkedEpicId: string | null;
  projectId: string | null;
  remoteScopeKey: string | null;
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

function entryCanEdit(entry: ExternalTaskTimeEntry): boolean {
  return entry.canEdit && entry.durationMs % 60_000 === 0;
}

function updateOutcomeMessage(outcome: 'updated' | 'not_applied' | 'outcome_unknown'): string {
  switch (outcome) {
    case 'updated':
      return 'Time entry updated.';
    case 'not_applied':
      return 'No provider changes were needed.';
    case 'outcome_unknown':
      return 'The update result is unconfirmed. Verify it before making another change.';
  }
}

function unknownOperationCopy(
  kind: 'create' | 'update' | 'delete' | null,
  canVerify: boolean,
): { title: string; description: string; acknowledge: string; consequence: string } {
  if (kind === 'update') {
    return {
      title: 'Last edit unconfirmed',
      description:
        'The provider was contacted but the edit result is unknown, so time-entry writes are locked. Verify it, open it in the source, or acknowledge the uncertainty to continue.',
      acknowledge: 'Acknowledge uncertainty',
      consequence:
        'Acknowledging accepts that the provider entry may contain either version; it unlocks time-entry writes without sending anything.',
    };
  }
  return {
    title: 'Last submission unconfirmed',
    description: canVerify
      ? 'The provider was contacted but the result is unknown, so this form is locked. Verify it, open it in the source, or acknowledge the duplicate risk before logging time again.'
      : 'The provider was contacted, but this outcome cannot be verified automatically. Open the entry in the source and check it, then acknowledge the duplicate risk to unlock this form.',
    acknowledge: 'Acknowledge duplicate risk',
    consequence:
      'Acknowledging accepts that the provider may hold a duplicate entry; it unlocks this form without sending anything.',
  };
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
  projectId,
  remoteScopeKey,
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
  const estimateSummaryEnabled = blockAccepted && timeTrackingEnabled && linkedEpicId !== null;
  const epicTime = useEpicTimeDetail(linkedEpicId, {
    enabled: estimateSummaryEnabled,
  });
  const estimateLog = useExternalEstimateTimeLog(provider, taskId, {
    enabled: estimateSummaryEnabled,
    connectionEpoch,
    projectId,
    remoteScopeKey,
  });
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [exactStart, setExactStart] = useState('');
  const [showExactStart, setShowExactStart] = useState(false);
  const [durationError, setDurationError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [editTarget, setEditTarget] = useState<ExternalTaskTimeEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExternalTaskTimeEntry | null>(null);
  const [focusRestoreIndex, setFocusRestoreIndex] = useState<number | null>(null);

  const timeToggleRef = useRef<HTMLButtonElement | null>(null);
  const durationInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    setDuration('');
    setNote('');
    setExactStart('');
    setShowExactStart(false);
    setDurationError(null);
    setAnnouncement('');
    setEditTarget(null);
    setDeleteTarget(null);
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
    if (deleteTarget !== null || editTarget !== null || focusRestoreIndex === null) return;
    if (timeEntries.delete.isPending || timeEntries.update.isPending) return;
    const rows = listRef.current
      ? [...listRef.current.querySelectorAll<HTMLLIElement>('li[data-entry-id]')]
      : [];
    const row = rows[focusRestoreIndex] ?? rows[rows.length - 1];
    const actionButton = row?.querySelector<HTMLButtonElement>(
      'button[data-entry-edit], button[data-entry-delete]',
    );
    if (actionButton) {
      actionButton.focus();
    } else if (durationInputRef.current) {
      durationInputRef.current.focus();
    } else {
      timeToggleRef.current?.focus();
    }
    setFocusRestoreIndex(null);
  }, [
    deleteTarget,
    editTarget,
    focusRestoreIndex,
    timeEntries.delete.isPending,
    timeEntries.update.isPending,
    timeEntries.history.data,
  ]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (writeBlocked) return;
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
    if (timeEntries.create.isSuccess && timeEntries.create.data?.outcome === 'created') {
      setDuration('');
      setNote('');
      setExactStart('');
      setAnnouncement('Time entry added.');
    }
  }, [timeEntries.create.isSuccess, timeEntries.create.data]);

  useEffect(() => {
    if (timeEntries.update.isSuccess && timeEntries.update.data) {
      const outcome = timeEntries.update.data.outcome;
      setAnnouncement(updateOutcomeMessage(outcome));
      if (outcome !== 'outcome_unknown') {
        setEditTarget(null);
      }
    }
  }, [timeEntries.update.isSuccess, timeEntries.update.data]);

  useEffect(() => {
    if (timeEntries.update.isError) {
      setAnnouncement('The time entry could not be updated.');
    }
  }, [timeEntries.update.isError]);

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

  const requestEdit = (entry: ExternalTaskTimeEntry) => {
    timeEntries.update.reset();
    setEditTarget(entry);
  };

  const confirmEdit = (input: ExternalTaskTimeEntryInput) => {
    if (!editTarget || timeEntries.update.isPending || writeBlocked) return;
    const entries = timeEntries.history.data?.entries ?? [];
    setFocusRestoreIndex(entries.findIndex((entry) => entry.remoteId === editTarget.remoteId));
    timeEntries.submitUpdate(editTarget.remoteId, input);
  };

  const confirmDelete = () => {
    if (!deleteTarget || timeEntries.delete.isPending || writeBlocked) return;
    const entries = timeEntries.history.data?.entries ?? [];
    setFocusRestoreIndex(entries.findIndex((entry) => entry.remoteId === deleteTarget.remoteId));
    timeEntries.submitDelete(deleteTarget.remoteId);
    // deleteTarget stays set: the dialog remains mounted until the mutation
    // settles so the error renderer survives a rejection.
  };

  const history = timeEntries.history;
  const summaryTotal =
    taskTotalDurationMs !== null ? formatDurationMs(taskTotalDurationMs) : 'No time tracked';
  const currentEstimateMinutes = epicTime.summary?.totalMinutes ?? null;
  const loggedEstimateMinutes = estimateLog.state?.loggedMinutes ?? null;
  const newUnloggedMinutes =
    currentEstimateMinutes !== null && loggedEstimateMinutes !== null
      ? Math.max(0, currentEstimateMinutes - loggedEstimateMinutes)
      : null;
  const currentEstimateLabel =
    currentEstimateMinutes === null ? '—' : formatEpicTimeMinutes(currentEstimateMinutes);
  const loggedEstimateLabel =
    loggedEstimateMinutes === null ? '—' : formatEpicTimeMinutes(loggedEstimateMinutes);
  const newUnloggedLabel =
    newUnloggedMinutes === null ? '—' : formatEpicTimeMinutes(newUnloggedMinutes);
  const manualCreatePending = timeEntries.create.isPending;
  const manualCreateError = timeEntries.create.isError;
  const writeBlocked = timeEntries.writeBlocked || estimateLog.writeBlocked;
  const unknownCopy = unknownOperationCopy(
    timeEntries.unknownOperationKind,
    timeEntries.canVerifyUnknown,
  );

  return (
    <section
      className="space-y-4 rounded-md border bg-card p-4"
      aria-labelledby="external-task-time-heading"
    >
      <h3 id="external-task-time-heading" className="sr-only">
        Time tracked
      </h3>
      <button
        ref={timeToggleRef}
        type="button"
        className="flex w-full flex-wrap items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`${timeOpen ? 'Collapse' : 'Expand'} Time tracked`}
        aria-describedby={
          estimateSummaryEnabled && !timeOpen ? 'external-task-time-header-metrics' : undefined
        }
        aria-expanded={timeOpen}
        aria-controls="external-task-time-content"
        onClick={toggleTimeDisclosure}
      >
        <Clock3 className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-base font-semibold text-balance">Time tracked</span>
          <span className="block text-xs text-muted-foreground">Provider total {summaryTotal}</span>
        </span>
        {estimateSummaryEnabled && !timeOpen ? (
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="whitespace-nowrap">
              <span className="text-muted-foreground">Current estimate </span>
              <span className="font-semibold tabular-nums">{currentEstimateLabel}</span>
            </span>
            <span className="whitespace-nowrap">
              <span className="text-muted-foreground">Logged </span>
              <span className="font-semibold tabular-nums">{loggedEstimateLabel}</span>
            </span>
            <span className="whitespace-nowrap">
              <span className="text-muted-foreground">New unlogged </span>
              <span className="font-semibold tabular-nums">{newUnloggedLabel}</span>
            </span>
          </span>
        ) : null}
        <ChevronRight
          className={timeOpen ? 'h-4 w-4 shrink-0 rotate-90' : 'h-4 w-4 shrink-0'}
          aria-hidden="true"
        />
      </button>
      {estimateSummaryEnabled ? (
        <span id="external-task-time-header-metrics" className="sr-only">
          Current estimate {currentEstimateMinutes === null ? 'unavailable' : currentEstimateLabel}.
          Logged {loggedEstimateMinutes === null ? 'unavailable' : loggedEstimateLabel}. New
          unlogged {newUnloggedMinutes === null ? 'unavailable' : newUnloggedLabel}.
        </span>
      ) : null}
      <div id="external-task-time-content" hidden={!timeOpen}>
        {blockAccepted ? (
          <div className="space-y-4">
            {timeTrackingEnabled ? (
              <>
                {linkedEpicId !== null ? (
                  <>
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
                    {epicTime.summary && remoteScopeKey ? (
                      <ExternalEstimateTimePanel
                        key={disclosureScope}
                        focalEpicId={linkedEpicId}
                        summary={epicTime.summary}
                        estimateLog={estimateLog}
                        remoteScopeKey={remoteScopeKey}
                        sourceUrl={sourceUrl}
                        writeBlocked={writeBlocked}
                        onAnnounce={setAnnouncement}
                        onRecapture={() => {
                          void epicTime.query.refetch();
                          void estimateLog.refetchCheckpoint();
                        }}
                        timeZone={epicTime.timeZone}
                      />
                    ) : null}
                  </>
                ) : null}
                <div className="grid items-start gap-4 xl:grid-cols-2">
                  <section className="space-y-3 rounded-md border bg-background/30 p-4">
                    <div className="space-y-1">
                      <h4 className="flex items-center gap-2 text-base font-semibold">
                        <PencilLine className="h-5 w-5 text-primary" aria-hidden="true" />
                        Log time manually
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Add time that is not included in the DevChain estimate.
                      </p>
                    </div>
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
                          aria-describedby={
                            durationError ? 'external-task-duration-error' : undefined
                          }
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
                          {showExactStart
                            ? 'Hide exact start time'
                            : 'Add exact start time (optional)'}
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
                      <Button type="submit" disabled={writeBlocked}>
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
                        <AlertTitle>{unknownCopy.title}</AlertTitle>
                        <AlertDescription>
                          <p>{unknownCopy.description}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {timeEntries.canVerifyUnknown ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  timeEntries.verifyUnknown(timeEntries.unknownOperationId!)
                                }
                                disabled={timeEntries.verify.isPending}
                              >
                                {timeEntries.verify.isPending ? 'Verifying…' : 'Verify'}
                              </Button>
                            ) : null}
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
                              {unknownCopy.acknowledge}
                            </Button>
                          </div>
                          <p className="mt-2 text-xs">{unknownCopy.consequence}</p>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </section>

                  <details
                    open={historyOpen}
                    className="group rounded-md border bg-background/30"
                    onToggle={handleHistoryToggle}
                  >
                    <summary
                      aria-label="Recent time entries"
                      className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden"
                    >
                      <Clock3 className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-semibold">Recent time entries</span>
                        <span className="block text-sm text-muted-foreground">Last 30 days</span>
                      </span>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="space-y-2 border-t px-3 py-3">
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
                                  {entryCanEdit(entry) || entry.canDelete ? (
                                    <div className="flex justify-self-start gap-1 sm:justify-self-end">
                                      {entryCanEdit(entry) ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          data-entry-edit
                                          aria-label={`Edit ${formatDurationMs(entry.durationMs)} entry started ${new Date(entry.startedAt).toLocaleString()}`}
                                          onClick={() => requestEdit(entry)}
                                          disabled={writeBlocked}
                                        >
                                          Edit
                                        </Button>
                                      ) : null}
                                      {entry.canDelete ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          className="text-destructive"
                                          data-entry-delete
                                          aria-label={`Delete ${formatDurationMs(entry.durationMs)} entry started ${new Date(entry.startedAt).toLocaleString()}`}
                                          onClick={() => requestDeleteConfirmation(entry)}
                                          disabled={writeBlocked}
                                        >
                                          Delete
                                        </Button>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : null}
                    </div>
                  </details>
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
      </div>

      {editTarget ? (
        <ExternalTimeEntryEditDialog
          key={editTarget.remoteId}
          entry={editTarget}
          pending={timeEntries.update.isPending}
          writeBlocked={writeBlocked}
          operationError={timeEntries.update.error}
          onCancel={() => setEditTarget(null)}
          onSubmit={confirmEdit}
        />
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
                disabled={writeBlocked}
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
    </section>
  );
}
