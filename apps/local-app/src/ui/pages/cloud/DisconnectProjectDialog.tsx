import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DockerCopyBackChoice,
  DockerCopyBackRequest,
  DockerSyncGroup,
  DockerSyncState,
} from '@/modules/remotes/docker/docker-copy-back.dto';
import type { DockerDataState } from '@/modules/remotes/docker/docker-plan.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { StartError } from './StartError';
import { FileSyncLossItems, type FolderNeed } from './file-sync-display';

const STATE_LABELS: Record<DockerDataState, string> = {
  'vm-newer': 'changed on the VM; copied home',
  'in-sync': 'in sync; nothing to copy',
  'home-newer': 'changed on this PC; kept',
  'both-changed': 'changed on both sides; choose',
  unknown: 'unknown; choose',
  'no-record': 'not on the VM; kept',
};

function groupLabel(group: DockerSyncGroup): string {
  return group.itemNames.length
    ? group.itemNames.join(', ')
    : [...group.volumes, ...group.bindPaths].join(', ');
}

/** Null when the check cannot be read: the option is then not offered. */
async function fetchSyncState(
  projectId: string,
  remoteId: string,
  signal: AbortSignal,
): Promise<DockerSyncState | null> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/docker/sync-state`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteId }),
      signal,
    },
    { backend: HOME_BACKEND },
  );
  if (!response.ok) return null;
  return (await response.json()) as DockerSyncState;
}

function description(remoteName: string, offline: boolean, force: boolean): string {
  if (offline) {
    return `${remoteName} cannot be reached. Force disconnect keeps the last home mirror without contacting the VM.`;
  }
  if (force) {
    return `Force disconnect keeps the last home mirror without asking ${remoteName}, and takes over the stopped disconnect.`;
  }
  return `Stop VM sessions, copy the latest project data home, and remove the project copy from ${remoteName}.`;
}

export function DisconnectProjectDialog({
  projectId,
  projectName,
  remoteId,
  remoteName,
  offline,
  force = false,
  hostCursor,
  pending,
  error,
  onClose,
  onDisconnect,
}: {
  projectId: string;
  projectName: string;
  remoteId: string;
  remoteName: string;
  offline: boolean;
  /** Opens as a forced disconnect even while the VM answers, e.g. to take over a failed one. */
  force?: boolean;
  hostCursor?: string | null;
  pending: boolean;
  /** The refusal of the last start request, shown above the buttons. */
  error?: string | null;
  onClose: () => void;
  onDisconnect: (force: boolean, dockerCopyBack?: DockerCopyBackRequest) => void;
}) {
  const client = useHomeQueryClient();
  const [copyDocker, setCopyDocker] = useState(false);
  const [choices, setChoices] = useState<Record<string, DockerCopyBackChoice>>({});
  const forced = offline || force;
  // A forced disconnect never reaches the VM, so it has no Docker copy.
  const sync = useQuery(
    {
      queryKey: [HOME_BACKEND, 'docker-sync-state', projectId, remoteId],
      enabled: !forced,
      retry: false,
      queryFn: ({ signal }) => fetchSyncState(projectId, remoteId, signal),
    },
    client,
  );
  const state = sync.data;
  const homeDockerUsable =
    !forced &&
    state?.imported === true &&
    (state.availability.available || state.availability.side === 'remote');
  const copying = homeDockerUsable && copyDocker;
  const choiceGroups = state?.groups.filter((group) => group.needsChoice) ?? [];
  const missingChoice = copying && choiceGroups.some((group) => !choices[group.key]);
  // What home's Syncthing last knew it still needed; the remote cannot be asked.
  const need = useQuery(
    {
      queryKey: [HOME_BACKEND, 'file-sync', projectId, 'status'],
      enabled: forced,
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `/api/file-sync/projects/${encodeURIComponent(projectId)}/status`,
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok) return { folders: null };
        return (await response.json()) as { folders: FolderNeed[] | null };
      },
    },
    client,
  );
  const age = hostCursor ? Math.max(0, Date.now() - Date.parse(hostCursor)) : null;
  const handleDisconnect = () =>
    onDisconnect(
      forced,
      copying
        ? {
            choices: Object.fromEntries(
              choiceGroups
                .filter((group) => choices[group.key])
                .map((group) => [group.key, choices[group.key]]),
            ),
          }
        : undefined,
    );
  const handleOpenChange = (open: boolean) => {
    if (!open && !pending) onClose();
  };
  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {projectName}?</DialogTitle>
          <DialogDescription>{description(remoteName, offline, force)}</DialogDescription>
        </DialogHeader>
        {forced && (
          <div className="text-sm">
            <p className="font-medium">What may be lost</p>
            <ul className="list-disc pl-5">
              {age !== null && Number.isFinite(age) && (
                <li>Changes since the last mirror ({Math.ceil(age / 60_000)} minutes ago).</li>
              )}
              <FileSyncLossItems
                folders={need.data?.folders ?? null}
                generic="VM file changes are not synced back."
              />
              <li>Agent time may include unfinalized work.</li>
            </ul>
          </div>
        )}
        {homeDockerUsable && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Checkbox
                id="disconnect-copy-docker"
                checked={copyDocker}
                disabled={pending}
                onCheckedChange={(checked) => setCopyDocker(checked === true)}
              />
              <Label htmlFor="disconnect-copy-docker" className="font-normal">
                Copy Docker data back to this PC
              </Label>
            </div>
            {copying && (
              <>
                <p className="text-muted-foreground">
                  Containers that use the copied data stop on both sides first. The containers on
                  this PC stay stopped afterwards.
                </p>
                {!state.availability.available && (
                  <p className="text-muted-foreground">
                    {state.availability.reason?.message ?? 'The VM Docker cannot be checked.'} The
                    Disconnect stops at the copy until it can.
                  </p>
                )}
                <ul aria-label="Docker data" className="space-y-1">
                  {state.groups.map((group) => (
                    <li key={group.key}>
                      <span>
                        {groupLabel(group)}: {STATE_LABELS[group.state]}.
                      </span>
                      {group.needsChoice && (
                        <Select
                          value={choices[group.key]}
                          disabled={pending}
                          onValueChange={(value) =>
                            setChoices((current) => ({
                              ...current,
                              [group.key]: value as DockerCopyBackChoice,
                            }))
                          }
                        >
                          <SelectTrigger
                            aria-label={`Choice for ${groupLabel(group)}`}
                            className="ml-2 inline-flex h-8 w-auto min-w-[12rem]"
                          >
                            <SelectValue placeholder="Choose" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="copy-home">
                              Copy the VM&apos;s data to this PC
                            </SelectItem>
                            <SelectItem value="keep-home">Keep this PC&apos;s data</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <StartError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={forced ? 'destructive' : 'default'}
            onClick={handleDisconnect}
            disabled={missingChoice}
            pending={pending}
          >
            {forced ? 'Force disconnect' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
