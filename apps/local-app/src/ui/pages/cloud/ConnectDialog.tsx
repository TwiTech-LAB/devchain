import { useState } from 'react';
import type { DockerSelection } from '@/modules/remotes/docker/docker-plan.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
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
import { cn } from '@/ui/lib/utils';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import {
  ConnectDockerSection,
  NO_DOCKER_STATE,
  type DockerSectionState,
} from './ConnectDockerSection';
import {
  ignoreChange,
  useProjectIgnores,
  useSaveProjectIgnores,
  type IgnoreDraft,
} from './connect-ignores';
import { IgnoreListEditor } from './IgnoreListEditor';
import { ProjectList, type ProjectListData } from './ProjectList';
import { connectBlockedReason, type VmStatus } from './remote-status';
import { StartError } from './StartError';

type Step = 'target' | 'files' | 'review';
const STEPS: Step[] = ['target', 'files', 'review'];
const STEP_LABELS: Record<Step, string> = {
  target: 'Project and VM',
  files: 'Files',
  review: 'Review',
};

/** Projects that can move to a VM: on this PC, or back after a cancelled Connect. */
const CONNECTABLE_PROJECT_STATES = new Set(['local', 'cleanup-failed']);

/**
 * The VM Connect opens on: the one it was opened from while it is ready, else
 * the only ready one. An explicit VM never falls back to another VM.
 */
function defaultRemoteId(initialRemoteId: string | undefined, readyIds: string[]): string | null {
  if (initialRemoteId) return readyIds.includes(initialRemoteId) ? initialRemoteId : null;
  return readyIds.length === 1 ? readyIds[0] : null;
}

export interface ConnectRequest {
  projectId: string;
  remoteId: string;
  docker: DockerSelection | undefined;
}

function VmChoices({
  remotes,
  statuses,
  selected,
  disabled,
  onSelect,
  onUpdateVm,
}: {
  remotes: readonly RemoteListItemDto[];
  statuses: ReadonlyMap<string, VmStatus>;
  selected: string | null;
  disabled: boolean;
  onSelect: (remoteId: string) => void;
  onUpdateVm: (remoteId: string) => void;
}) {
  const choices = remotes.flatMap((remote) => {
    const status = statuses.get(remote.id);
    return status && status.state !== 'removed' ? [{ remote, status }] : [];
  });
  if (choices.length === 0) {
    return <p className="text-sm text-muted-foreground">Add a VM first.</p>;
  }
  return (
    <div role="group" aria-label="VM" className="space-y-1.5">
      {choices.map(({ remote, status }) => {
        const reason = connectBlockedReason(status);
        const chosen = selected === remote.id;
        return (
          <div key={remote.id} className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={chosen}
              disabled={disabled || reason !== null}
              onClick={() => onSelect(remote.id)}
              className={cn(
                'flex min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                chosen ? 'border-primary bg-primary/10' : 'hover:bg-muted/50',
              )}
            >
              <span className="break-all font-medium">{remote.name}</span>
              {reason && <span className="text-muted-foreground">· {reason}</span>}
            </button>
            {status.state === 'update-needed' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onUpdateVm(remote.id)}
              >
                Update {remote.name}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Moves a project to a VM in three steps: the project and the VM, the files
 * that sync (saved only when Connect is pressed) with the Docker choices,
 * and a review.
 */
export function ConnectDialog({
  initialProjectId,
  initialRemoteId,
  remotes,
  statuses,
  projects,
  pending,
  error,
  onClose,
  onUpdateVm,
  onConnect,
}: {
  /** Fixed when the flow starts from a project. */
  initialProjectId?: string;
  /** Preselected when the flow starts from a VM; while it is not ready, no VM is selected. */
  initialRemoteId?: string;
  remotes: readonly RemoteListItemDto[];
  statuses: ReadonlyMap<string, VmStatus>;
  projects: ProjectListData;
  pending: boolean;
  /** The refusal of the last start request, shown on Review. */
  error: string | null;
  onClose: () => void;
  onUpdateVm: (remoteId: string) => void;
  onConnect: (request: ConnectRequest) => void;
}) {
  const [step, setStep] = useState<Step>('target');
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const readyIds = remotes
    .filter((remote) => statuses.get(remote.id)?.state === 'ready')
    .map((remote) => remote.id);
  const [chosenRemote, setChosenRemote] = useState<string | null>(null);
  const remoteId = chosenRemote ?? defaultRemoteId(initialRemoteId, readyIds);
  const remoteReady = remoteId !== null && readyIds.includes(remoteId);
  const [draft, setDraft] = useState<IgnoreDraft | null>(null);
  const [docker, setDocker] = useState<DockerSectionState>(NO_DOCKER_STATE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filesVisited, setFilesVisited] = useState(false);

  const ignores = useProjectIgnores(projectId);
  const saveIgnores = useSaveProjectIgnores();
  const loaded = ignores.data ?? [];
  const change = ignores.data ? ignoreChange(loaded, draft) : ({ kind: 'none' } as const);
  const busy = pending || saving;

  const projectName =
    projects.rows.find((row) => row.project.id === projectId)?.project.name ?? null;
  const remoteName = remotes.find((remote) => remote.id === remoteId)?.name ?? null;
  const pickable = projects.rows.filter((row) => CONNECTABLE_PROJECT_STATES.has(row.status.state));
  const targetStatus = remoteId === null ? undefined : statuses.get(remoteId);
  const blocked = targetStatus ? connectBlockedReason(targetStatus) : null;
  const targetGone = `${remoteName ?? 'The VM'} can no longer take the project${
    blocked ? ` (${blocked})` : ''
  }. Go back and choose a VM.`;

  // A refusal gates Connect only when items are selected: a plan that could not
  // be read, or an empty selection, keeps the plain Connect. Next and Connect
  // wait for any in-flight read the user opted into, so they never send a
  // selection the server has not answered for.
  const dockerRefused = docker.items.length > 0 && (!docker.ready || !docker.canConnect);
  const dockerBlocks = dockerRefused || docker.pending;

  const chooseProject = (id: string) => {
    if (id === projectId) return;
    setProjectId(id);
    setDraft(null);
    setDocker(NO_DOCKER_STATE);
    setFilesVisited(false);
  };
  const chooseRemote = (id: string) => {
    if (id === remoteId) return;
    setChosenRemote(id);
    setDocker(NO_DOCKER_STATE);
  };
  const goTo = (next: Step) => {
    if (next === 'files') setFilesVisited(true);
    setSaveError(null);
    setStep(next);
  };

  const connect = async () => {
    if (!projectId || !remoteId || !remoteReady || busy || dockerBlocks) return;
    setSaveError(null);
    if (change.kind !== 'none') {
      setSaving(true);
      try {
        await saveIgnores(projectId, change.kind === 'restore' ? null : change.list);
      } catch (cause) {
        setSaveError(getErrorMessage(cause, 'Could not save the file list.'));
        return;
      } finally {
        setSaving(false);
      }
    }
    onConnect({
      projectId,
      remoteId,
      docker: docker.items.length > 0 ? { items: docker.items } : undefined,
    });
  };

  const stepIndex = STEPS.indexOf(step);
  const title = initialProjectId
    ? `Connect ${projectName ?? 'the project'}`
    : `Connect a project to ${remoteName ?? 'a VM'}`;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 'target' && (
          <div className="space-y-4">
            {initialProjectId ? (
              <p className="text-sm">
                Project: <span className="font-medium">{projectName ?? initialProjectId}</span>
              </p>
            ) : (
              <ProjectList
                {...projects}
                rows={pickable}
                title="Project"
                description="Projects on this PC, from every workspace."
                autoFocusSearch
                renderAction={(row) => {
                  const chosen = row.project.id === projectId;
                  return (
                    <Button
                      type="button"
                      size="sm"
                      variant={chosen ? 'default' : 'outline'}
                      aria-pressed={chosen}
                      aria-label={`Choose ${row.project.name}`}
                      disabled={busy}
                      onClick={() => chooseProject(row.project.id)}
                    >
                      {chosen ? 'Chosen' : 'Choose'}
                    </Button>
                  );
                }}
              />
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">VM</p>
              <VmChoices
                remotes={remotes}
                statuses={statuses}
                selected={remoteId}
                disabled={busy}
                onSelect={chooseRemote}
                onUpdateVm={onUpdateVm}
              />
            </div>
          </div>
        )}

        {filesVisited && projectId && remoteId && (
          <div hidden={step !== 'files'} className="space-y-4">
            {ignores.isPending && (
              <BusyStatus className="text-sm text-muted-foreground">
                Reading the file list…
              </BusyStatus>
            )}
            {ignores.error && (
              <p role="alert" className="text-sm text-destructive">
                {ignores.error.message} Connect keeps the project&apos;s current list.
              </p>
            )}
            {ignores.data && (
              <IgnoreListEditor list={draft?.list ?? loaded} disabled={busy} onChange={setDraft} />
            )}
            <ConnectDockerSection
              key={`${projectId}:${remoteId}`}
              projectId={projectId}
              remoteId={remoteId}
              disabled={busy}
              onStateChange={setDocker}
            />
            {dockerRefused && (
              <p role="alert" className="text-sm text-destructive">
                Resolve the Docker space or blockers above, or clear the Docker selections to
                connect without containers.
              </p>
            )}
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4 text-sm">
            <section aria-label="File list changes" className="space-y-1">
              <h3 className="font-medium">File list</h3>
              {change.kind === 'none' && <p className="text-muted-foreground">No changes.</p>}
              {change.kind === 'restore' && <p>Connect restores the default list.</p>}
              {change.kind === 'list' && (
                <ul className="space-y-0.5 font-mono">
                  {change.added.map((pattern) => (
                    <li key={`+${pattern}`}>+ {pattern}</li>
                  ))}
                  {change.removed.map((pattern) => (
                    <li key={`-${pattern}`}>− {pattern}</li>
                  ))}
                </ul>
              )}
              {change.kind === 'list' && change.reordered && (
                <p>
                  The order of the patterns changes. Syncthing applies the first one that matches.
                </p>
              )}
            </section>
            <section aria-label="What happens" className="space-y-1">
              <h3 className="font-medium">What happens</h3>
              <ol className="list-decimal space-y-1 pl-5">
                <li>Agent sessions of {projectName ?? 'the project'} stop on this PC.</li>
                <li>
                  DevChain copies the project, its transcripts
                  {docker.items.length > 0 ? ' and the selected containers' : ''} to{' '}
                  {remoteName ?? 'the VM'}.
                </li>
                <li>
                  The files sync, then the VM owns the project. Board and Chat keep working here.
                </li>
              </ol>
            </section>
            {!remoteReady && (
              <p role="alert" className="text-destructive">
                {targetGone}
              </p>
            )}
            {saveError && (
              <p role="alert" className="text-destructive">
                {saveError}
              </p>
            )}
          </div>
        )}

        <StartError error={step === 'review' ? error : null} />
        <DialogFooter>
          {step === 'target' ? (
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(STEPS[stepIndex - 1])}
              disabled={busy}
            >
              Back
            </Button>
          )}
          {step === 'target' && (
            <Button
              type="button"
              onClick={() => {
                // The accepted VM stays the target; a later health change never swaps it.
                setChosenRemote(remoteId);
                goTo('files');
              }}
              disabled={busy || !projectId || !remoteReady}
            >
              Next
            </Button>
          )}
          {step === 'files' && (
            <Button
              type="button"
              onClick={() => goTo('review')}
              pending={docker.pending || ignores.isPending}
              disabled={busy || dockerBlocks}
            >
              Next
            </Button>
          )}
          {step === 'review' && (
            <Button
              type="button"
              onClick={() => void connect()}
              pending={busy}
              disabled={dockerBlocks || !remoteReady}
            >
              {saving ? 'Saving…' : pending ? 'Starting…' : 'Connect'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
