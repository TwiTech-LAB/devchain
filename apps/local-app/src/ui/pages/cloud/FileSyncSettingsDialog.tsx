import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import { IgnoreListEditor } from './IgnoreListEditor';
import {
  FileListChangedError,
  useProjectIgnores,
  useSaveProjectIgnores,
  type IgnoreDraft,
} from './connect-ignores';
import { FileSyncAutoFixControls } from './FileSyncAutoFixControls';

export function FileSyncSettingsDialog({
  projectId,
  projectName,
  connected,
  busy,
  onClose,
}: {
  projectId: string;
  projectName: string;
  connected: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  const loaded = useProjectIgnores(projectId);
  const save = useSaveProjectIgnores();
  const { showSuccess } = useToastHelpers();
  const [draft, setDraft] = useState<IgnoreDraft | null>(null);
  const mutation = useMutation(
    {
      mutationFn: ({ ignores, revision }: { ignores: string[] | null; revision: number }) =>
        save(projectId, ignores, revision),
      onError: (error) => {
        if (error instanceof FileListChangedError) setDraft(null);
      },
      onSuccess: (result) => {
        showSuccess({ title: 'File sync settings saved', description: result.message });
        onClose();
      },
    },
    useHomeQueryClient(),
  );
  const disabled = busy || mutation.isPending;
  const list = draft?.list ?? loaded.data;

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>File sync settings · {projectName}</DialogTitle>
          <DialogDescription>
            {connected
              ? 'Save applies the list to the VM first, then this PC.'
              : 'Save keeps the list for the next Connect.'}
          </DialogDescription>
        </DialogHeader>
        {loaded.isPending && <BusyStatus>Loading file sync settings…</BusyStatus>}
        {loaded.error && (
          <p role="alert" className="text-sm text-destructive">
            {loaded.error.message}
          </p>
        )}
        {!loaded.error && list && (
          <IgnoreListEditor
            list={list}
            disabled={disabled}
            onChange={(next) => {
              mutation.reset();
              setDraft({ ...next, revision: draft?.revision ?? loaded.revision });
            }}
          />
        )}
        <FileSyncAutoFixControls projectId={projectId} disabled={disabled} />
        {mutation.error && (
          <p role="alert" className="text-sm text-destructive">
            {mutation.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Close
          </Button>
          <Button
            disabled={disabled || !list}
            pending={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                ignores: draft?.restored ? null : list!,
                revision: draft?.revision ?? loaded.revision!,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
