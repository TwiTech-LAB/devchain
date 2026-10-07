import { useState } from 'react';
import { dockerCopyBackMismatchMessage } from '@/modules/remotes/vm-user-identity';
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
import { cn } from '@/ui/lib/utils';
import { useProjectFileSyncFailures } from './file-sync-failures';
import { StartError } from './StartError';
import { FileSyncLossItems, type FolderNeed } from './file-sync-display';

/** The Connect dialog's names for the same states. */
const STATE_LABELS: Record<DockerDataState, string> = {
  'vm-newer': 'VM data changed',
  'in-sync': 'In sync',
  'home-newer': 'Home data changed',
  'both-changed': 'Both sides changed',
  unknown: 'Changes unknown',
  'no-record': 'No VM data',
};
/** What the copy does with a group that needs no choice. */
const COPY_LABELS: Record<DockerDataState, string> = {
  'vm-newer': 'Copied home',
  'in-sync': 'Nothing to copy',
  'home-newer': "This PC's data is kept",
  'both-changed': '',
  unknown: '',
  'no-record': "This PC's data is kept",
};
/** States in which the VM holds Docker data that this PC does not have. */
const VM_CHANGED_STATES = new Set<DockerDataState>(['vm-newer', 'both-changed']);

function groupNames(group: DockerSyncGroup): string[] {
  return group.itemNames.length ? group.itemNames : [...group.volumes, ...group.bindPaths];
}

/** Changed on the VM, or the user must choose: shown in yellow, and first. */
function marked(group: DockerSyncGroup): boolean {
  return group.needsChoice || VM_CHANGED_STATES.has(group.state);
}

/** "4 of 5 data groups copy home; 1 needs your choice". */
function copySummary(
  groups: DockerSyncGroup[],
  choices: Record<string, DockerCopyBackChoice>,
): string {
  const copied = groups.filter(
    (group) =>
      group.state === 'vm-newer' || (group.needsChoice && choices[group.key] === 'copy-home'),
  ).length;
  const open = groups.filter((group) => group.needsChoice && !choices[group.key]).length;
  const summary = `${copied} of ${groups.length} data ${groups.length === 1 ? 'group' : 'groups'} ${copied === 1 ? 'copies' : 'copy'} home`;
  return open ? `${summary}; ${open} ${open === 1 ? 'needs' : 'need'} your choice` : summary;
}

/**
 * One row per data group: its containers, each on its own line, and what Disconnect does with
 * its data. Without `onChoose`, the data stays on the VM and no choice is asked.
 */
function DockerDataTable({
  label,
  groups,
  choices,
  pending,
  onChoose,
}: {
  label: string;
  groups: DockerSyncGroup[];
  choices: Record<string, DockerCopyBackChoice>;
  pending: boolean;
  onChoose?: (key: string, choice: DockerCopyBackChoice) => void;
}) {
  const rows = [...groups].sort(
    (a, b) =>
      Number(!a.needsChoice) - Number(!b.needsChoice) || Number(!marked(a)) - Number(!marked(b)),
  );
  return (
    <table aria-label={label} className="w-full table-fixed text-left">
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="w-1/2 pb-1 pl-3 pr-3 font-normal">
            Containers
          </th>
          <th scope="col" className="pb-1 font-normal">
            Data
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((group) => {
          const yellow = marked(group);
          const name = groupNames(group).join(', ');
          return (
            <tr
              key={group.key}
              data-marked={yellow || undefined}
              className={cn('border-t align-top', !yellow && 'text-muted-foreground')}
            >
              <th
                scope="row"
                className={cn(
                  'border-l-2 py-1.5 pl-3 pr-3 font-normal',
                  yellow ? 'border-l-status-warn' : 'border-l-transparent',
                )}
              >
                {groupNames(group).map((item) => (
                  <span key={item} className="block break-all">
                    {item}
                  </span>
                ))}
              </th>
              <td className="space-y-1 py-1.5">
                <span
                  className={cn(
                    'block',
                    yellow &&
                      'w-fit rounded-full bg-status-warn/10 px-2 py-0.5 text-xs font-medium text-status-warn',
                  )}
                >
                  {STATE_LABELS[group.state]}
                </span>
                {!onChoose ? (
                  <span className="block">Stays on the VM</span>
                ) : group.needsChoice ? (
                  <Select
                    value={choices[group.key] ?? ''}
                    disabled={pending}
                    onValueChange={(value) => onChoose(group.key, value as DockerCopyBackChoice)}
                  >
                    <SelectTrigger
                      aria-label={`Choice for ${name}`}
                      className={cn('h-8 w-full', !choices[group.key] && 'border-status-warn')}
                    >
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="copy-home">Copy the VM&apos;s data to this PC</SelectItem>
                      <SelectItem value="keep-home">Keep this PC&apos;s data</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="block">{COPY_LABELS[group.state]}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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
    return `Force disconnect keeps the last home mirror without asking ${remoteName}, and takes over the stopped operation.`;
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
  onFixFileSync,
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
  onFixFileSync: () => void;
  onDisconnect: (force: boolean, dockerCopyBack?: DockerCopyBackRequest) => void;
}) {
  const client = useHomeQueryClient();
  // Null until the user decides; the default then follows whether the VM changed data.
  const [copyChoice, setCopyChoice] = useState<boolean | null>(null);
  const [choices, setChoices] = useState<Record<string, DockerCopyBackChoice>>({});
  const forced = offline || force;
  const failed = useProjectFileSyncFailures(projectId, !forced);
  const failedCount =
    (failed.data?.home.entries.length ?? 0) + (failed.data?.vm.entries.length ?? 0);
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
  // Disconnect waits for the check, so a quick click cannot skip the copy offer.
  const checking = !forced && sync.isPending;
  const checkFailed = !forced && (sync.isError || state === null);
  const homeDockerUsable =
    !forced &&
    state?.imported === true &&
    (state.availability.available ||
      (state.availability.side === 'remote' &&
        state.availability.reason?.code !== 'vm-user-mismatch'));
  const vmChanged = state?.groups.filter((group) => VM_CHANGED_STATES.has(group.state)) ?? [];
  const copyDocker = copyChoice ?? vmChanged.length > 0;
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
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-xl">
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
        {checking && <p className="text-sm text-muted-foreground">Checking Docker data…</p>}
        {checkFailed && (
          <p className="text-sm text-muted-foreground">
            The Docker data check failed. This Disconnect does not copy Docker data to this PC.
          </p>
        )}
        {!forced && state?.availability.reason?.code === 'vm-user-mismatch' && (
          <p role="note" aria-label="Docker copy-back unavailable" className="text-sm">
            {state.availability.userMismatch
              ? dockerCopyBackMismatchMessage(state.availability.userMismatch)
              : state.availability.reason.message}
          </p>
        )}
        {homeDockerUsable && (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="disconnect-copy-docker"
                  checked={copyDocker}
                  disabled={pending}
                  onCheckedChange={(checked) => setCopyChoice(checked === true)}
                />
                <Label htmlFor="disconnect-copy-docker" className="font-normal">
                  Copy Docker data back to this PC
                </Label>
              </div>
              {copying && (
                <p className="pl-6 text-muted-foreground">
                  Containers that use the copied data stop on both sides first. The containers on
                  this PC stay stopped afterwards.
                </p>
              )}
            </div>
            {!copying && vmChanged.length > 0 && (
              <div className="space-y-2">
                <p>Without the copy, these changes stay on the VM:</p>
                <DockerDataTable
                  label="Docker data that stays on the VM"
                  groups={vmChanged}
                  choices={choices}
                  pending={pending}
                />
              </div>
            )}
            {copying && (
              <div className="space-y-2">
                {!state.availability.available && (
                  <p className="text-muted-foreground">
                    {state.availability.reason?.message ?? 'The VM Docker cannot be checked.'} The
                    Disconnect stops at the copy until it can.
                  </p>
                )}
                <p className="font-medium">{copySummary(state.groups, choices)}</p>
                <DockerDataTable
                  label="Docker data"
                  groups={state.groups}
                  choices={choices}
                  pending={pending}
                  onChoose={(key, choice) =>
                    setChoices((current) => ({ ...current, [key]: choice }))
                  }
                />
              </div>
            )}
          </div>
        )}
        {!forced && failedCount > 0 && (
          <div className="space-y-2 text-sm">
            <p>
              {failedCount} files can&apos;t sync. Disconnect waits for them and stops after 30
              minutes.
            </p>
            <Button variant="outline" disabled={pending} onClick={onFixFileSync}>
              Fix file sync
            </Button>
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
            disabled={missingChoice || checking}
            pending={pending}
          >
            {forced ? 'Force disconnect' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
