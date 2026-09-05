import { useState } from 'react';
import type {
  ExternalTaskTimeEntry,
  ExternalTaskTimeEntryInput,
} from '@/modules/external-integrations/models/external-provider.models';
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
import { parseDurationInput, resolveStartedAtMs } from '@/ui/lib/external-time';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

const INVALID_DURATION_MESSAGE =
  'Enter a duration like 15m, 5h, 1h 30m, or bare minutes such as 30 (max 7 days).';

function toLocalDateTimeValue(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${milliseconds}`;
}

interface ExternalTimeEntryEditDialogProps {
  entry: ExternalTaskTimeEntry;
  pending: boolean;
  writeBlocked: boolean;
  operationError: unknown;
  onCancel: () => void;
  onSubmit: (input: ExternalTaskTimeEntryInput) => void;
}

export function ExternalTimeEntryEditDialog({
  entry,
  pending,
  writeBlocked,
  operationError,
  onCancel,
  onSubmit,
}: ExternalTimeEntryEditDialogProps) {
  const [duration, setDuration] = useState(`${entry.durationMs / 60_000}m`);
  const [note, setNote] = useState(entry.note ?? '');
  const [startedAt, setStartedAt] = useState(toLocalDateTimeValue(entry.startedAt));
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = () => {
    if (pending || writeBlocked) return;
    const durationMs = parseDurationInput(duration);
    if (durationMs === null) {
      setValidationError(INVALID_DURATION_MESSAGE);
      return;
    }
    const startedAtMs = resolveStartedAtMs(durationMs, startedAt, Date.now());
    if (startedAtMs === null) {
      setValidationError('Enter a valid start time.');
      return;
    }
    setValidationError(null);
    onSubmit({
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs,
      note: note.trim() || null,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogContent
        className="max-w-lg"
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit time entry</DialogTitle>
          <DialogDescription>
            This changes the provider entry only. DevChain&apos;s Already logged value will not
            change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="external-task-edit-duration">Duration</Label>
            <Input
              id="external-task-edit-duration"
              value={duration}
              onChange={(event) => {
                setDuration(event.target.value);
                if (validationError) setValidationError(null);
              }}
              autoComplete="off"
              inputMode="numeric"
              disabled={pending}
              aria-invalid={validationError !== null}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-task-edit-started-at">Started at</Label>
            <Input
              id="external-task-edit-started-at"
              type="datetime-local"
              step="0.001"
              value={startedAt}
              onChange={(event) => {
                setStartedAt(event.target.value);
                if (validationError) setValidationError(null);
              }}
              disabled={pending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-task-edit-note">Note (optional)</Label>
            <Textarea
              id="external-task-edit-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={10_000}
              disabled={pending}
            />
          </div>
          {validationError ? (
            <p role="alert" className="text-xs text-destructive">
              {validationError}
            </p>
          ) : null}
          {operationError ? (
            <p role="alert" className="text-xs text-destructive">
              {getErrorMessage(operationError, 'The time entry could not be updated.')}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={writeBlocked}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
