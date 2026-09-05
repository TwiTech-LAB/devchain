import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { useExternalTaskImport } from '@/ui/hooks/board/useExternalTaskImport';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

export interface ExternalTaskImportDialogProps {
  provider: ExternalBoardProvider;
  detail: ExternalTaskDetail | null;
  open: boolean;
  enabled: boolean;
  connectionEpoch: IntegrationConnectionEpoch | null;
  projectId: string | null;
  projectName?: string | null;
  onOpenChange: (open: boolean) => void;
  onImported: (epicId: string) => void;
  /**
   * Return-focus target when the dialog closes without importing. Radix has no
   * trigger ref for this controlled, triggerless dialog, so the owner supplies
   * the element explicitly.
   */
  returnFocusTo?: () => HTMLElement | null;
}

export function ExternalTaskImportDialog({
  provider,
  detail,
  open,
  enabled,
  connectionEpoch,
  projectId,
  projectName = null,
  onOpenChange,
  onImported,
  returnFocusTo,
}: ExternalTaskImportDialogProps) {
  const [statusId, setStatusId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const controller = useExternalTaskImport(provider, detail, projectId, {
    enabled: enabled && open,
    connectionEpoch,
    projectName,
  });
  const statuses = useMemo(
    () =>
      [...(controller.statuses.data?.items ?? [])].sort(
        (left, right) => left.position - right.position,
      ),
    [controller.statuses.data?.items],
  );

  useEffect(() => {
    if (!open || !detail) return;
    setStatusId('');
    setTitle(detail.title);
    setDescription(detail.description ?? '');
    controller.mutation.reset();
  }, [detail, open, projectId]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !projectId || !statusId || !title.trim()) return;
    controller.mutation.mutate(
      { statusId, title, description },
      { onSuccess: (result) => onImported(result.epic.id) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // Without a trigger, Radix would focus document.body; the owner's
          // Create button (or heading fallback) is the real origin.
          const target = returnFocusTo?.();
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create DevChain task</DialogTitle>
          <DialogDescription>
            Import this remote task into the current Board project. It will remain unassigned.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">DevChain project</p>
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {projectName ?? 'Current Board project'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-import-status">Status</Label>
            <select
              id="external-import-status"
              value={statusId}
              onChange={(event) => setStatusId(event.target.value)}
              required
              disabled={!projectId || controller.statuses.isLoading}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">Select a status</option>
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-import-title">Title</Label>
            <Input
              id="external-import-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={1_000}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="external-import-description">Description</Label>
            <Textarea
              id="external-import-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={65_536}
              rows={5}
            />
          </div>
          {controller.mutation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {getErrorMessage(controller.mutation.error, 'Task import failed.')}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!projectId || !statusId || !title.trim() || controller.mutation.isPending}
            >
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
