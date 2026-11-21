import { useId, useState } from 'react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
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
import { BusyStatus } from '@/ui/components/ui/spinner';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import type { StatusTone } from '@/ui/lib/status-tone';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { FolderBrowserDialog } from './FolderBrowserDialog';
import { IgnoreListEditor } from './IgnoreListEditor';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import type {
  RemoteOperationDto,
  SharedFolderDto,
  SharedFolderState,
} from './lib/remote-vm-contracts';
import { remoteOperationsKeys, sharedFoldersQueryKey } from './lib/remote-vm-query-keys';
import { expandHome, homeRelativePath } from './remote-status';
import { StatusChip } from './StatusChip';

const SHARE_INTRO = 'Every file in the folder syncs unless you add a rule.';

function files(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** A share's state as chip words and tone; failed opens its operation. */
export function sharedFolderStateChip(state: SharedFolderState): {
  label: string;
  tone: StatusTone;
} {
  switch (state.kind) {
    case 'sharing':
      return { label: 'Sharing…', tone: 'running' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'in-sync':
      return { label: 'In sync', tone: 'ok' };
    case 'syncing':
      return { label: `Syncing ${files(state.needItems)}`, tone: 'running' };
    case 'failing':
      return { label: `${files(state.failedFiles)} fail`, tone: 'error' };
    case 'error':
      return { label: `Error: ${state.message}`, tone: 'error' };
    case 'vm-offline':
      return { label: 'VM offline', tone: 'neutral' };
    case 'not-on-vm':
      return { label: 'Not on the VM', tone: 'warn' };
  }
}

function operationOpen(state: SharedFolderState): boolean {
  return state.kind === 'sharing' || state.kind === 'failed';
}

function useRefreshShares(remoteId: string) {
  const queryClient = useHomeQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: sharedFoldersQueryKey(remoteId) });
    void queryClient.invalidateQueries({ queryKey: remoteOperationsKeys.all });
  };
}

/** Shares a folder of this PC with the VM; the started operation opens in Activity. */
export function ShareFolderDialog({
  remoteId,
  vmName,
  homePath,
  blockedReason,
  onClose,
  onStarted,
}: {
  remoteId: string;
  vmName: string;
  homePath: string | null;
  /** Why Share cannot start now; null when it can. */
  blockedReason: string | null;
  onClose: () => void;
  onStarted: (operation: RemoteOperationDto) => void;
}) {
  const api = useRemoteVmApi();
  const pathId = useId();
  const errorId = useId();
  const [path, setPath] = useState('');
  const [ignores, setIgnores] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = expandHome(path.trim(), homePath);

  const share = async () => {
    setPending(true);
    setError(null);
    try {
      onStarted(await api.shareFolder(remoteId, { path: target, ignores }));
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not share the folder.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share a folder with {vmName}</DialogTitle>
          <DialogDescription>
            The folder gets the same path on the VM, and both sides keep it in sync.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={pathId}>Folder on this PC</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={pathId}
              value={path}
              placeholder="~/data"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setPath(event.target.value);
                setError(null);
              }}
              className="min-w-[12rem] flex-1 font-mono"
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setBrowsing(true)}
            >
              Browse…
            </Button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <IgnoreListEditor
          intro={SHARE_INTRO}
          restoreDefaults={false}
          list={ignores}
          disabled={pending}
          onChange={(draft) => setIgnores(draft.list)}
        />
        <div className="space-y-3 text-sm">
          <p className="text-status-warn">
            Files in this folder are stored on the VM. On a shared VM, users with sudo can read
            them. If the folder holds a Git repository, do not use Git on this PC and on the VM at
            the same time.
          </p>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
              disabled={pending}
              className="mt-0.5"
            />
            Replace and delete files in this folder on {vmName}. DevChain keeps a backup on the VM.
          </label>
        </div>
        {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!consent || !target || blockedReason !== null}
            pending={pending}
            onClick={() => void share()}
          >
            {pending ? 'Sharing…' : 'Share'}
          </Button>
        </DialogFooter>
        {browsing && (
          <FolderBrowserDialog
            startPath={target.startsWith('/') ? target : null}
            homePath={homePath}
            onClose={() => setBrowsing(false)}
            onSelect={(selected) => {
              setPath(selected);
              setError(null);
              setBrowsing(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Saves a share's ignore patterns; a refused save keeps the dialog and the edits. */
function EditPatternsDialog({
  remoteId,
  folder,
  displayPath,
  onClose,
}: {
  remoteId: string;
  folder: SharedFolderDto;
  displayPath: string;
  onClose: () => void;
}) {
  const api = useRemoteVmApi();
  const refresh = useRefreshShares(remoteId);
  const { showSuccess } = useToastHelpers();
  const [list, setList] = useState<string[]>(folder.ignores);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await api.saveSharedFolderIgnores(remoteId, folder.id, list);
      refresh();
      showSuccess({ title: 'Patterns saved', description: displayPath });
      onClose();
    } catch (cause) {
      refresh();
      setError(getErrorMessage(cause, 'Could not save the patterns.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit patterns · {displayPath}</DialogTitle>
          <DialogDescription>Save applies the patterns to the VM and this PC.</DialogDescription>
        </DialogHeader>
        <IgnoreListEditor
          intro={SHARE_INTRO}
          restoreDefaults={false}
          list={list}
          disabled={pending}
          onChange={(draft) => {
            setError(null);
            setList(draft.list);
          }}
        />
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error} Save again to retry.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button type="button" pending={pending} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The folders of this PC shared with the VM, and the actions on them. */
export function SharedFoldersTab({
  remoteId,
  vmName,
  homePath,
  folders,
  loading,
  error,
  blockedReason,
  onOpenActivity,
}: {
  remoteId: string;
  vmName: string;
  homePath: string | null;
  folders: readonly SharedFolderDto[];
  loading: boolean;
  error: Error | null;
  /** Why Share a folder cannot start now; null when it can. */
  blockedReason: string | null;
  onOpenActivity: (operationId: string) => void;
}) {
  const api = useRemoteVmApi();
  const refresh = useRefreshShares(remoteId);
  const { showSuccess, showError } = useToastHelpers();
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState<SharedFolderDto | null>(null);
  const stopping = useConfirmDialog<SharedFolderDto>();
  const display = (path: string) => homeRelativePath(path, homePath);

  // The confirm dialog closes at once; the result shows as a toast.
  const stop = async (folder: SharedFolderDto) => {
    try {
      const result = await api.stopSharingFolder(remoteId, folder.id);
      showSuccess({
        title: `Stopped sharing ${display(folder.path)}`,
        description: result.message,
      });
    } catch (cause) {
      showError({
        title: `Could not stop sharing ${display(folder.path)}`,
        description: getErrorMessage(cause, 'Try again.'),
      });
    } finally {
      refresh();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={blockedReason !== null}
          onClick={() => setSharing(true)}
        >
          Share a folder
        </Button>
        {blockedReason && <span className="text-xs text-muted-foreground">{blockedReason}</span>}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : loading ? (
        <BusyStatus className="text-sm">Loading shared folders…</BusyStatus>
      ) : folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders of this PC are shared with this VM.
        </p>
      ) : (
        <ul aria-label="Shared folders" className="divide-y rounded-md border">
          {folders.map((folder) => {
            const chip = sharedFolderStateChip(folder.state);
            const busy = operationOpen(folder.state);
            const failedOperation =
              folder.state.kind === 'failed' ? folder.state.operationId : null;
            const path = display(folder.path);
            return (
              <li
                key={folder.id}
                aria-label={path}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block break-all font-mono">{path}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    {failedOperation ? (
                      <button
                        type="button"
                        aria-label={`${chip.label}: open in Activity`}
                        onClick={() => onOpenActivity(failedOperation)}
                        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                      </button>
                    ) : (
                      <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {folder.ignores.length === 1
                        ? '1 ignore pattern'
                        : `${folder.ignores.length} ignore patterns`}
                    </span>
                    {!folder.patternsApplied && (
                      <span className="text-xs text-status-warn">Patterns not applied</span>
                    )}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(folder)}
                  >
                    Edit patterns
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => stopping.open(folder)}
                  >
                    Stop sharing
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {sharing && (
        <ShareFolderDialog
          remoteId={remoteId}
          vmName={vmName}
          homePath={homePath}
          blockedReason={blockedReason}
          onClose={() => setSharing(false)}
          onStarted={(operation) => {
            setSharing(false);
            refresh();
            onOpenActivity(operation.id);
          }}
        />
      )}
      {editing && (
        <EditPatternsDialog
          remoteId={remoteId}
          folder={editing}
          displayPath={display(editing.path)}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={stopping.isOpen}
        onOpenChange={stopping.onOpenChange}
        onConfirm={() => stopping.target && void stop(stopping.target)}
        title="Stop sharing"
        description={
          stopping.target
            ? `Stop sharing ${display(stopping.target.path)}? The files stay on this PC and on the VM.`
            : ''
        }
        confirmText="Stop sharing"
        variant="destructive"
      />
    </div>
  );
}
