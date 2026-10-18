import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type {
  DockerCopyBackChoice,
  DockerSyncState,
} from '@/modules/remotes/docker/docker-copy-back.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { cn } from '@/ui/lib/utils';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { disconnectAllChecksQueryKey } from './lib/remote-vm-query-keys';
import type {
  DisconnectAllRequest,
  ProjectFileSyncFailures,
  ProjectFileSyncStatus,
  RemoteProjectLanes,
} from './lib/remote-vm-contracts';
import {
  changedOnVm,
  copyBackRequest,
  copyEligible,
  copySummary,
  dockerCopyUsable,
  DockerDataTable,
} from './DisconnectProjectDialog';
import { FileSyncLossItems } from './file-sync-display';
import { StartError } from './StartError';
import { StatusChip } from './StatusChip';

export interface DisconnectAllProject {
  id: string;
  name: string;
  hostCursor?: string | null;
  fileSyncWarning?: string | null;
  blockedReason?: string | null;
}

interface ProjectChecks {
  docker: DockerSyncState | null;
  failures: ProjectFileSyncFailures | null;
  lanes: RemoteProjectLanes | null;
  folders: ProjectFileSyncStatus['folders'];
}

interface DockerChoice {
  copy: boolean | null;
  choices: Record<string, DockerCopyBackChoice>;
}

function useWideLayout(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 640px)').matches
      : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 640px)');
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

export function DisconnectAllDialog({
  remoteId,
  remoteName,
  projects,
  offline,
  loading,
  blockedReason,
  pending,
  error,
  onClose,
  onDisconnect,
  onFixFileSync,
}: {
  remoteId: string;
  remoteName: string;
  projects: DisconnectAllProject[];
  offline: boolean;
  loading: boolean;
  blockedReason?: string | null;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onDisconnect: (input: DisconnectAllRequest) => void;
  onFixFileSync: (projectId: string) => void;
}): JSX.Element {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const wide = useWideLayout();
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, DockerChoice>>({});
  const checks = useQueries(
    {
      queries: projects.map((project) => ({
        queryKey: disconnectAllChecksQueryKey(remoteId, project.id, offline),
        enabled: !loading,
        retry: false,
        staleTime: 0,
        refetchOnMount: 'always' as const,
        refetchInterval: review ? (false as const) : 10_000,
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ProjectChecks> => {
          if (offline) {
            const need = await api.readFileSyncStatus(project.id, signal).catch(() => null);
            return { docker: null, failures: null, lanes: null, folders: need?.folders ?? null };
          }
          const [docker, failures, lanes] = await Promise.all([
            api.readDockerSyncState(project.id, remoteId, signal).catch(() => null),
            api.readProjectFileSyncFailures(project.id, signal).catch(() => null),
            api.readRemoteProjectLanes(remoteId, project.id, signal),
          ]);
          return { docker, failures, lanes, folders: null };
        },
      })),
    },
    client,
  );
  const rows = projects.map((project, index) => {
    const check = checks[index];
    const data = check.data;
    const docker = data?.docker;
    const decision = decisions[project.id] ?? { copy: null, choices: {} };
    const eligible = docker?.groups.filter(copyEligible) ?? [];
    const usable = !offline && docker != null && dockerCopyUsable(docker);
    const changed = eligible.some(changedOnVm);
    const copying = usable && eligible.length > 0 && (decision.copy ?? changed);
    const missing =
      copying && eligible.some((group) => group.needsChoice && !decision.choices[group.key]);
    const failedCount =
      (data?.failures?.home.entries.length ?? 0) + (data?.failures?.vm.entries.length ?? 0);
    const problem =
      blockedReason ??
      project.blockedReason ??
      (!offline
        ? project.fileSyncWarning ||
          (failedCount > 0
            ? `${failedCount} files can't sync. Fix file sync before disconnecting.`
            : null) ||
          (data?.lanes?.lanes.length
            ? `Remove lanes on the VM first: ${data.lanes.lanes.map(({ name }) => name).join(', ')}.`
            : null) ||
          (check.isError ? getErrorMessage(check.error, 'Could not check lanes on the VM.') : null)
        : null);
    const checking = !offline && (check.isPending || check.isFetching);
    const label = problem
      ? 'Blocked'
      : checking
        ? 'Checking…'
        : missing
          ? 'Choices needed'
          : 'Ready';
    const request = copying ? copyBackRequest(eligible, decision.choices) : undefined;
    return {
      project,
      check,
      data,
      docker,
      decision,
      eligible,
      usable,
      copying,
      problem,
      checking,
      label,
      request,
      failedCount,
    };
  });
  const selectedId = selected === null && wide ? projects[0]?.id : selected;
  const selectedRow = rows.find(({ project }) => project.id === selectedId);
  const canStart =
    !loading && !blockedReason && rows.length > 0 && rows.every(({ label }) => label === 'Ready');
  const choose = (projectId: string, update: Partial<DockerChoice>) => {
    setDecisions((current) => ({
      ...current,
      [projectId]: { ...(current[projectId] ?? { copy: null, choices: {} }), ...update },
    }));
  };
  const details = (row: (typeof rows)[number]) => (
    <section
      aria-label={`Disconnect choices for ${row.project.name}`}
      className="min-w-0 space-y-3 text-sm"
    >
      <h3 className="font-medium">{row.project.name}</h3>
      {row.problem && <p role="alert">{row.problem}</p>}
      {!offline && (row.project.fileSyncWarning || row.failedCount > 0) && (
        <Button variant="outline" disabled={pending} onClick={() => onFixFileSync(row.project.id)}>
          Fix file sync
        </Button>
      )}
      {row.checking && <p>Checking Docker data, file sync and lanes…</p>}
      {offline && (
        <div>
          <p className="font-medium">What may be lost</p>
          <ul className="list-disc pl-5">
            {row.project.hostCursor && Number.isFinite(Date.parse(row.project.hostCursor)) && (
              <li>
                Changes since the last mirror (
                {Math.max(0, Math.ceil((Date.now() - Date.parse(row.project.hostCursor)) / 60_000))}{' '}
                minutes ago).
              </li>
            )}
            <FileSyncLossItems
              folders={row.data?.folders ?? null}
              generic="VM file changes are not synced back."
            />
            <li>Agent time may include unfinalized work.</li>
            <li>Lanes on the VM are unknown and may be lost.</li>
          </ul>
        </div>
      )}
      {!offline && !row.checking && !row.check.isError && row.docker === null && (
        <p>The Docker data check failed. This Disconnect does not copy Docker data to this PC.</p>
      )}
      {!offline && row.docker?.availability.reason?.code === 'vm-user-mismatch' && (
        <p>
          Docker cannot determine the user ids on this PC and the VM. Refresh the VM information
          before copying Docker data back.
        </p>
      )}
      {row.usable && row.eligible.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`batch-copy-${row.project.id}`}
              checked={row.copying}
              disabled={pending}
              onCheckedChange={(checked) => choose(row.project.id, { copy: checked === true })}
            />
            <Label htmlFor={`batch-copy-${row.project.id}`} className="font-normal">
              Copy Docker data back to this PC
            </Label>
          </div>
          {row.copying && (
            <p>
              Containers that use the copied data stop on both sides first. The containers on this
              PC stay stopped afterwards.
            </p>
          )}
          {row.copying && row.docker && (
            <p>{copySummary(row.docker.groups, row.decision.choices)}</p>
          )}
          {row.copying && row.docker && !row.docker.availability.available && (
            <p>
              {row.docker.availability.reason?.message ?? 'The VM Docker cannot be checked.'} The
              Disconnect stops at the copy until it can.
            </p>
          )}
          <DockerDataTable
            label={`Docker data for ${row.project.name}`}
            groups={row.docker?.groups ?? []}
            choices={row.decision.choices}
            pending={pending}
            onChoose={
              row.copying
                ? (key, choice) =>
                    choose(row.project.id, { choices: { ...row.decision.choices, [key]: choice } })
                : undefined
            }
          />
        </div>
      )}
      {!offline && row.docker && row.eligible.length === 0 && !row.checking && (
        <p>No Docker data can be copied back for this project.</p>
      )}
      <Button
        variant="ghost"
        disabled={pending || row.check.isFetching}
        onClick={() => void row.check.refetch()}
      >
        Recheck project
      </Button>
    </section>
  );
  const submit = () => {
    if (!canStart || pending) return;
    onDisconnect({
      force: offline,
      projects: rows.map(({ project, request }) => ({
        projectId: project.id,
        ...(request ? { dockerCopyBack: request } : {}),
      })),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Disconnect all from {remoteName}</DialogTitle>
          <DialogDescription>
            {offline
              ? `${remoteName} cannot be reached. Force disconnect keeps the last home mirror without contacting the VM.`
              : 'Disconnect all of this PC’s projects from this VM, one at a time. Check each project before reviewing.'}
          </DialogDescription>
        </DialogHeader>
        {loading && <p role="status">Loading connected projects…</p>}
        {!loading && rows.length === 0 && <p>No projects from this PC are connected to this VM.</p>}
        {blockedReason && <p role="alert">{blockedReason}</p>}
        {review ? (
          <section aria-label="Review Disconnect all" className="space-y-3">
            <h3 className="font-medium">Review all projects</h3>
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={row.project.id} className="space-y-1 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {row.project.name}{' '}
                    <StatusChip tone={row.label === 'Ready' ? 'ok' : 'warn'}>
                      {row.label}
                    </StatusChip>
                  </div>
                  {row.problem && <p>{row.problem}</p>}
                  <p>
                    {offline
                      ? 'Force disconnect; no Docker copy-back.'
                      : row.copying
                        ? copySummary(row.eligible, row.decision.choices)
                        : 'No Docker copy-back; Docker data stays on the VM.'}
                  </p>
                  {row.copying && (
                    <ul className="list-disc pl-5">
                      {row.eligible.map((group) => (
                        <li key={group.key}>
                          {(group.itemNames.length
                            ? group.itemNames
                            : [...group.volumes, ...group.bindPaths]
                          ).join(', ')}
                          :{' '}
                          {group.needsChoice
                            ? row.decision.choices[group.key] === 'copy-home'
                              ? 'Copy the VM’s data to this PC'
                              : 'Keep this PC’s data'
                            : group.state === 'vm-newer'
                              ? 'Copy the VM’s data to this PC'
                              : 'Keep this PC’s data'}
                        </li>
                      ))}
                    </ul>
                  )}
                  {offline && details(row)}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <ul aria-label="Projects to disconnect" className="space-y-2">
              {rows.map((row) => (
                <li key={row.project.id} className="min-w-0 rounded-md border">
                  <button
                    type="button"
                    className={cn(
                      'flex w-full flex-col items-start gap-1 rounded-md p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                      selectedId === row.project.id && 'bg-selected hover:bg-selected',
                    )}
                    aria-pressed={wide ? selectedId === row.project.id : undefined}
                    aria-expanded={!wide ? selectedId === row.project.id : undefined}
                    aria-controls={!wide ? `batch-details-${row.project.id}` : undefined}
                    onClick={() =>
                      setSelected(!wide && selectedId === row.project.id ? null : row.project.id)
                    }
                  >
                    <span className="break-all font-medium">{row.project.name}</span>
                    <StatusChip
                      tone={
                        row.label === 'Ready' ? 'ok' : row.label === 'Blocked' ? 'error' : 'warn'
                      }
                    >
                      {row.label}
                    </StatusChip>
                  </button>
                  {!wide && selectedId === row.project.id && (
                    <div id={`batch-details-${row.project.id}`} className="border-t p-3">
                      {details(row)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {wide && selectedRow && (
              <div className="min-w-0 rounded-md border p-3">{details(selectedRow)}</div>
            )}
          </div>
        )}
        <StartError error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {review && (
            <Button variant="outline" disabled={pending} onClick={() => setReview(false)}>
              Back
            </Button>
          )}
          <Button
            variant={offline ? 'destructive' : 'default'}
            disabled={!canStart}
            pending={pending}
            onClick={review ? submit : () => setReview(true)}
          >
            {review
              ? offline
                ? 'Force disconnect all'
                : 'Disconnect all'
              : 'Review Disconnect all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
