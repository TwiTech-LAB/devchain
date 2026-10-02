import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Loader2, Minus, X } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';
import {
  isHostInstallRetryFormCode,
  type RemoteOperationDto,
  type SshCredentials,
} from '@/ui/hooks/useRemoteOperations';
import type { ProviderAuthGenerationView } from '@/ui/hooks/useProviderAuth';
import type { DockerTransferDetails } from '@/modules/remotes/docker/docker-plan.dto';
import type { DockerCopyBackResult } from '@/modules/remotes/docker/docker-copy-back.dto';
import type { TranscriptTransferDetails } from '@/modules/remotes/transcripts/transcript-transfer.dto';
import {
  errorFirstLine,
  kindWords,
  projectRecovery,
  stepProgress,
  type RecoveryAction,
} from './remote-status';
import { type StatusTone } from '@/ui/lib/status-tone';
import { StatusChip } from './StatusChip';
import {
  FileSyncLossItems,
  folderLabel,
  formatBytes,
  formatDuration,
  readFolderProgress,
  type FolderNeed,
} from './file-sync-display';
import { HostInstallRetryForm } from './SshCredentialForms';
import { providerName } from './login-choices';

type Step = RemoteOperationDto['steps'][number];

/** Names for the VMs and projects an operation targets; ids show where a name is missing. */
export interface ActivityNames {
  remotes: ReadonlyMap<string, string>;
  projects: ReadonlyMap<string, string>;
}

/** What the page does for the buttons of an operation's detail. */
export interface ActivityActions {
  retry: (operation: RemoteOperationDto, ssh?: SshCredentials) => void;
  cancel: (operation: RemoteOperationDto) => void;
  reauth: (operation: RemoteOperationDto, providers: string[]) => void;
  openLogin: (generation: ProviderAuthGenerationView) => void;
  disconnectInstead: (operation: RemoteOperationDto) => void;
  forceDisconnect: (operation: RemoteOperationDto) => void;
  /** Absent while the page cannot open Chat. */
  openChat?: (projectId: string) => void;
  /** Absent until the page can preselect a VM in Connect. */
  connectProject?: (remoteId: string) => void;
}

/** Steps that wait for a sync and report per-folder progress while they run. */
const FILE_SYNC_WAIT_STEPS = new Set(['file_sync_initial', 'file_sync_final']);

/** Steps whose `details.docker` bytes advance: the transfer and the bind restores. */
const DOCKER_TRANSFER_STEPS = new Set(['docker_push', 'docker_create_host', 'docker_copy_home']);

/** "<Kind> · <target>", the target being the project or else the VM. */
export function operationTitle(operation: RemoteOperationDto, names: ActivityNames): string {
  const target = operation.projectId
    ? (names.projects.get(operation.projectId) ?? operation.projectId)
    : (names.remotes.get(operation.remoteId) ?? operation.remoteId);
  return `${kindWords(operation).title} · ${target}`;
}

const STATE_CHIPS: Record<RemoteOperationDto['state'], { label: string; tone: StatusTone }> = {
  running: { label: 'Running', tone: 'running' },
  failed: { label: 'Stopped', tone: 'error' },
  done: { label: 'Done', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function OperationStateChip({ state }: { state: RemoteOperationDto['state'] }) {
  const chip = STATE_CHIPS[state];
  return <StatusChip tone={chip.tone}>{chip.label}</StatusChip>;
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString();
}

/** A `reset_vm` step carries its project id in the label; show the name instead. */
function stepLabel(operation: RemoteOperationDto, step: Step, names: ActivityNames): string {
  if (operation.kind !== 'reset_vm') return step.label;
  const projectId = /^(?:attach|detach):([^:]+):/.exec(step.id)?.[1];
  const name = projectId ? names.projects.get(projectId) : undefined;
  return projectId && name ? step.label.replace(projectId, name) : step.label;
}

const STEP_ICONS: Record<Step['state'], typeof Check> = {
  done: Check,
  running: Loader2,
  failed: X,
  pending: Circle,
  skipped: Minus,
};

function StepRow({
  operation,
  step,
  names,
  children,
}: {
  operation: RemoteOperationDto;
  step: Step;
  names: ActivityNames;
  children?: React.ReactNode;
}) {
  const Icon = STEP_ICONS[step.state];
  return (
    <li data-state={step.state} className="space-y-1">
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            step.state === 'running' && 'animate-spin text-primary',
            step.state === 'done' && 'text-status-ok',
            step.state === 'failed' && 'text-destructive',
            (step.state === 'pending' || step.state === 'skipped') && 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'min-w-0 break-words',
            step.state === 'pending' && 'text-muted-foreground',
            step.state === 'skipped' && 'text-muted-foreground line-through',
          )}
        >
          {stepLabel(operation, step, names)}
          <span className="sr-only"> — {step.state}</span>
        </span>
      </div>
      {children}
    </li>
  );
}

/** Live numbers of the running step: file-sync folders and Docker bytes. */
function LiveStepDetails({ operation, step }: { operation: RemoteOperationDto; step: Step }) {
  if (step.state !== 'running') return null;
  const progress = readFolderProgress(operation.details);
  const docker = operation.details.docker as Partial<DockerTransferDetails> | undefined;
  const bytesDone = typeof docker?.bytesDone === 'number' ? docker.bytesDone : null;
  const bytesTotal = typeof docker?.bytesTotal === 'number' ? docker.bytesTotal : null;
  return (
    <>
      {FILE_SYNC_WAIT_STEPS.has(step.id) && progress.length > 0 && (
        <ul aria-label={`${step.label} progress`} className="pl-6 text-muted-foreground">
          {progress.map(([id, folder]) => (
            <li key={id}>
              {folderLabel(id)}: {Math.floor(folder.completion)}% ({folder.needItems} items,{' '}
              {formatBytes(folder.needBytes)} left)
            </li>
          ))}
        </ul>
      )}
      {DOCKER_TRANSFER_STEPS.has(step.id) && bytesDone !== null && bytesTotal !== null && (
        <p className="pl-6 text-muted-foreground">
          Docker: {formatBytes(bytesDone)} of {formatBytes(bytesTotal)}
          {docker?.item && ` (${docker.item.name}, ${docker.item.phase})`}
          {typeof docker?.rateBytesPerSecond === 'number' &&
            docker.rateBytesPerSecond > 0 &&
            ` — ${formatBytes(docker.rateBytesPerSecond)}/s`}
          {typeof docker?.etaSeconds === 'number' &&
            ` — about ${formatDuration(Math.max(1, docker.etaSeconds))} left`}
        </p>
      )}
    </>
  );
}

function StepList({ operation, names }: { operation: RemoteOperationDto; names: ActivityNames }) {
  const [showFinished, setShowFinished] = useState(false);
  const finished = operation.steps.filter(
    (step) => step.state === 'done' || step.state === 'skipped',
  );
  const current = operation.steps.filter(
    (step) => step.state === 'running' || step.state === 'failed',
  );
  const pending = operation.steps.filter((step) => step.state === 'pending');
  const doneCount = finished.filter((step) => step.state === 'done').length;
  return (
    <div aria-live="polite" className="space-y-2 text-sm">
      {finished.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1 py-0.5 text-muted-foreground"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((open) => !open)}
          >
            {showFinished ? (
              <ChevronDown aria-hidden="true" className="mr-1 h-4 w-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="mr-1 h-4 w-4" />
            )}
            {doneCount} {doneCount === 1 ? 'step' : 'steps'} done
          </Button>
          {showFinished && (
            <ol aria-label="Finished steps" className="mt-1 space-y-1">
              {finished.map((step) => (
                <StepRow key={step.id} operation={operation} step={step} names={names} />
              ))}
            </ol>
          )}
        </div>
      )}
      {current.length > 0 && (
        <ol aria-label="Current step" className="space-y-1 font-medium">
          {current.map((step) => (
            <StepRow key={step.id} operation={operation} step={step} names={names}>
              <LiveStepDetails operation={operation} step={step} />
            </StepRow>
          ))}
        </ol>
      )}
      {pending.length > 0 && (
        <ol aria-label="Pending steps" className="space-y-1">
          {pending.map((step) => (
            <StepRow key={step.id} operation={operation} step={step} names={names} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Note({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div role="note" aria-label={label} className="space-y-1 text-sm">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

function FamilyPullLines({
  operation,
  subject,
}: {
  operation: RemoteOperationDto;
  subject: string;
}) {
  const familyPull = operation.details.familyPull as
    | { pulled?: boolean; families?: Array<{ provider: string; lastWritebackAt: string | null }> }
    | undefined;
  return (
    <>
      {familyPull?.pulled === false ? (
        <p>The VM could not return its logins; {subject} used the last saved copies.</p>
      ) : (
        <p>The logins were saved from the VM first.</p>
      )}
      {familyPull?.families?.map((family) => (
        <p key={`${family.provider}:${family.lastWritebackAt ?? 'never'}`}>
          {providerName(family.provider)} login last saved{' '}
          {family.lastWritebackAt ?? 'at an unknown time'}.
        </p>
      ))}
    </>
  );
}

/** Everything an operation's details report beyond its steps. */
function OperationNotes({
  operation,
  names,
}: {
  operation: RemoteOperationDto;
  names: ActivityNames;
}) {
  const { details, state, kind } = operation;
  const loss = !Array.isArray(details.forcedLoss)
    ? (details.forcedLoss as
        | {
            mirrorAgeMs?: number | null;
            fileSync?: { folders: FolderNeed[] } | string;
            teamLanes?: string;
            transcripts?: string;
          }
        | undefined)
    : undefined;
  const lossFolders =
    loss?.fileSync && typeof loss.fileSync === 'object' ? loss.fileSync.folders : null;
  const resetLosses = Array.isArray(details.forcedLoss)
    ? (details.forcedLoss as Array<{
        projectId?: string;
        detach?: { transcripts?: string } | null;
      }>)
    : [];
  const checkWarnings = Array.isArray(details.checkWarnings)
    ? details.checkWarnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const transcripts = details.transcripts as TranscriptTransferDetails | undefined;
  const transcriptStep = operation.steps.find(
    (step) => step.id === 'transcripts_push' || step.id === 'transcripts_pull',
  );
  const docker = details.docker as Partial<DockerTransferDetails> | undefined;
  // A container copied with its data needs no line, so a complete copy shows no note.
  const dockerResult =
    docker?.result && docker.result.withoutData.length + docker.result.dataOnly.length > 0
      ? docker.result
      : null;
  const dockerStopSkipped =
    state === 'done' && typeof details.dockerStopSkipped === 'string'
      ? details.dockerStopSkipped
      : null;
  const copyBack =
    state === 'done'
      ? (details.dockerCopyBackResult as Partial<DockerCopyBackResult> | undefined)
      : undefined;
  const copyBackPartial =
    state === 'cancelled' && Array.isArray(details.dockerCopyBackPartial)
      ? details.dockerCopyBackPartial.filter((label): label is string => typeof label === 'string')
      : [];
  const verified = Object.entries(
    (details.verified ?? {}) as Record<string, { ok: boolean; hint: string | null }>,
  );
  const gitConfigOutcome =
    kind === 'attach' && (details.gitConfig === 'not_set_on_pc' || details.gitConfig === 'failed')
      ? details.gitConfig
      : null;
  const gitConfigError = typeof details.gitConfigError === 'string' ? details.gitConfigError : null;

  return (
    <div className="space-y-3">
      {transcripts && transcriptStep && (
        <Note label="Transcript copy" title="Transcripts">
          <p className="text-muted-foreground">
            {transcripts.filesDone}/{transcripts.filesTotal} files,{' '}
            {formatBytes(transcripts.bytesDone)}/{formatBytes(transcripts.bytesTotal)};{' '}
            {transcripts.missing} recorded files missing{' '}
            {transcriptStep.id === 'transcripts_push' ? 'on this PC' : 'on the VM'}
            {transcripts.skipped > 0 &&
              `; ${transcripts.skipped} sessions have a transcript path that cannot be copied`}
            .
          </p>
        </Note>
      )}
      {kind === 'install_host' && checkWarnings.length > 0 && (
        <Note label="VM check warnings" title="The VM check passed with warnings">
          <ul className="list-disc pl-5 text-muted-foreground">
            {checkWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Note>
      )}
      {gitConfigOutcome && (
        <Note label="Git settings" title="This PC's git settings were not copied">
          {gitConfigOutcome === 'not_set_on_pc' ? (
            <p className="text-muted-foreground">
              This PC has no readable global git config; the VM keeps its own git settings.
            </p>
          ) : (
            // The host's message keeps its own punctuation, so it gets a line
            // of its own instead of splicing into the next sentence.
            <>
              <p className="text-muted-foreground">
                The copy failed{gitConfigError ? `: ${gitConfigError}` : '.'}
              </p>
              <p className="text-muted-foreground">The VM keeps its own git settings.</p>
            </>
          )}
        </Note>
      )}
      {verified.length > 0 && (
        <Note label="Login test results" title="Login tests">
          <ul className="space-y-1">
            {verified.map(([provider, result]) => (
              <li key={provider} data-testid={`verify-${provider}`}>
                <span className="font-medium">{providerName(provider)}</span> —{' '}
                {result.ok ? 'verified' : 'failed'}
                {!result.ok && result.hint ? `: ${result.hint}` : ''}
              </li>
            ))}
          </ul>
        </Note>
      )}
      {loss && (
        <Note label="Forced disconnect losses" title="Possible losses from the forced disconnect">
          <ul className="list-disc pl-5">
            {typeof loss.mirrorAgeMs === 'number' && (
              <li>Mirror was {Math.ceil(loss.mirrorAgeMs / 60_000)} minutes old.</li>
            )}
            {loss.fileSync !== undefined && (
              <FileSyncLossItems
                folders={lossFolders}
                generic="VM file changes were not synced back."
              />
            )}
            {loss.transcripts === 'remote-changes' && (
              <li>Claude and Codex transcripts changed on the VM.</li>
            )}
            {loss.teamLanes === 'unfinalized' && <li>Agent time may include unfinalized work.</li>}
          </ul>
        </Note>
      )}
      {docker?.replaced && docker.replaced.length > 0 && state === 'running' && (
        <Note label="Docker replacement loss note" title="Docker replacement notice">
          <p>
            The VM copies being replaced ({docker.replaced.join(', ')}) are deleted first; Cancel
            will not bring them back.
          </p>
        </Note>
      )}
      {state === 'done' && dockerResult && (
        <Note label="Docker copy result" title="Docker copy result">
          <ul className="list-disc pl-5">
            {dockerResult.withoutData.map((name) => (
              <li key={name}>{name} was copied without its data.</li>
            ))}
            {dockerResult.dataOnly.map((name) => (
              <li key={name}>{name}: data only, no container was created.</li>
            ))}
          </ul>
        </Note>
      )}
      {copyBack && (
        <Note label="Docker copy home result" title="Docker data on this PC">
          <ul className="list-disc pl-5">
            {copyBack.copied?.map((label) => (
              <li key={`copied:${label}`}>{label}: VM data copied home.</li>
            ))}
            {copyBack.kept?.map((label) => (
              <li key={`kept:${label}`}>{label}: home data kept.</li>
            ))}
            {copyBack.skipped?.map((label) => (
              <li key={`skipped:${label}`}>{label}: not copied.</li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            The containers on this PC stay stopped; start them when you need them.
          </p>
        </Note>
      )}
      {copyBackPartial.length > 0 && (
        <Note label="Docker copy home incomplete" title="Docker data on this PC is incomplete">
          <p>
            The copy home of {copyBackPartial.join(', ')} did not finish. The VM still has the data:
            Disconnect again with Copy Docker data back to this PC.
          </p>
        </Note>
      )}
      {dockerStopSkipped && (
        <Note label="Docker stop skipped" title="Docker stop skipped">
          <p className="text-muted-foreground">{dockerStopSkipped}</p>
        </Note>
      )}
      {kind === 'reset_vm' && details.force === true && (
        <Note label="Forced reset loss note" title="Forced reset">
          <FamilyPullLines operation={operation} subject="the reset" />
          {resetLosses.length > 0 && (
            <ul className="list-disc pl-5">
              {resetLosses.map((item, index) => (
                <li key={`${item.projectId ?? 'project'}:${index}`}>
                  {item.projectId
                    ? `${names.projects.get(item.projectId) ?? item.projectId}: `
                    : ''}
                  Unsynced project changes or unfinalized agent time may have been lost.
                  {item.detach?.transcripts === 'remote-changes' &&
                    ' Claude and Codex transcripts changed on the VM may have been lost.'}
                </li>
              ))}
            </ul>
          )}
        </Note>
      )}
      {kind === 'destroy_vm' && details.force === true && (
        <Note label="Forced destruction loss note" title="Forced destruction">
          <FamilyPullLines operation={operation} subject="the destruction" />
        </Note>
      )}
    </div>
  );
}

/** Kinds a running operation may still be cancelled in. */
function runningCancelAllowed(operation: RemoteOperationDto): boolean {
  if (['install_host', 'create_vm', 'update_logins'].includes(operation.kind)) return true;
  // Mirrors the server rule in AttachOperation.assertCancellable: once the VM
  // owns the project, the project must be disconnected, not cancelled.
  if (operation.kind === 'attach')
    return !operation.steps.some((step) => step.id === 'bind_remote' && step.state !== 'pending');
  return (
    operation.kind === 'destroy_vm' &&
    !operation.steps.some(
      (step) => step.id === 'destroy' && (step.state === 'running' || step.state === 'done'),
    )
  );
}

/** A failed operation offers Cancel unless its recovery leaves Cancel out. */
function cancelAllowed(operation: RemoteOperationDto, recovery: RecoveryAction[] | null): boolean {
  if (operation.state === 'failed') return recovery ? recovery.includes('cancel') : true;
  if (operation.state === 'running') return runningCancelAllowed(operation);
  return false;
}

const PROGRESS_FILL: Partial<Record<RemoteOperationDto['state'], string>> = {
  failed: 'bg-destructive',
  done: 'bg-status-ok',
};

interface ClaimProviderStateDto {
  generationId?: string;
  sessionId?: string;
}

export function OperationDetail({
  operation,
  names,
  pending,
  error,
  actions,
}: {
  operation: RemoteOperationDto;
  names: ActivityNames;
  pending: boolean;
  /** The last Retry or Cancel refusal, shown as the server sent it. */
  error: string | null;
  actions: ActivityActions;
}) {
  const { state, details } = operation;
  const { current, total } = stepProgress(operation);
  const doneSteps = operation.steps.filter((step) => step.state === 'done').length;
  const failedStep = operation.steps.find((step) => step.state === 'failed');
  const sshRetry =
    operation.kind === 'install_host' &&
    state === 'failed' &&
    operation.steps.some((step) => isHostInstallRetryFormCode(step.error?.code));
  const recovery = projectRecovery(operation);
  const canRetry = state === 'failed' && !sshRetry;
  const canCancel = cancelAllowed(operation, recovery);
  const reauth =
    state === 'failed' && Array.isArray(details.reauth) ? (details.reauth as string[]) : [];
  const generations =
    state === 'running'
      ? Object.entries(
          (details.providerAuth ?? {}) as Record<string, ClaimProviderStateDto>,
        ).filter(([, provider]) => provider.generationId && provider.sessionId)
      : [];
  const vmName = names.remotes.get(operation.remoteId) ?? operation.remoteId;
  // The row shares one pending flag; only the pressed action spins. The disconnect
  // actions close Activity before anything runs, so they never spin here.
  const [pressed, setPressed] = useState<keyof ActivityActions | null>(null);
  const press = (key: keyof ActivityActions, run: () => void) => ({
    onClick: () => {
      setPressed(key);
      run();
    },
    disabled: pending,
    pending: pending && pressed === key,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <OperationStateChip state={state} />
        <span>Started {formatTime(operation.createdAt)}</span>
        {state !== 'running' && <span>Ended {formatTime(operation.updatedAt)}</span>}
      </div>

      {total > 0 && (
        <div className="space-y-1">
          <div
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={doneSteps}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn('h-full rounded-full', PROGRESS_FILL[state] ?? 'bg-primary')}
              style={{ width: `${(doneSteps / total) * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Step {current} of {total}
          </p>
        </div>
      )}

      {failedStep && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <p className="font-medium">Stopped at “{stepLabel(operation, failedStep, names)}”</p>
          {failedStep.error && <p className="break-words">{failedStep.error.message}</p>}
        </div>
      )}

      <StepList operation={operation} names={names} />
      <OperationNotes operation={operation} names={names} />

      {generations.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {generations.map(([provider, login]) => (
            <Button
              key={provider}
              size="sm"
              variant="outline"
              onClick={() =>
                actions.openLogin({
                  id: login.generationId!,
                  provider,
                  sessionId: login.sessionId!,
                  state: 'waiting',
                  startedAt: operation.createdAt,
                  finishedAt: null,
                  entries: [],
                  error: null,
                })
              }
            >
              Open {providerName(provider)} sign-in
            </Button>
          ))}
        </div>
      )}

      {sshRetry && (
        <HostInstallRetryForm
          pending={pending}
          onRetry={(ssh) => actions.retry(operation, ssh)}
          initialKeyName={typeof details.sshKeyName === 'string' ? details.sshKeyName : undefined}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {state === 'running' && (
        <p className="text-sm text-muted-foreground">
          You can close this. The work goes on, and the row shows its progress.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canRetry && (
          <Button size="sm" {...press('retry', () => actions.retry(operation))}>
            Retry
          </Button>
        )}
        {reauth.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            {...press('reauth', () => actions.reauth(operation, reauth))}
            data-testid="reauth-button"
          >
            Re-authenticate {reauth.join(', ')}
          </Button>
        )}
        {recovery?.includes('disconnect-instead') && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.disconnectInstead(operation)}
            disabled={pending}
          >
            Disconnect instead
          </Button>
        )}
        {recovery?.includes('force-disconnect') && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.forceDisconnect(operation)}
            disabled={pending}
          >
            Force disconnect
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="outline" {...press('cancel', () => actions.cancel(operation))}>
            Cancel
          </Button>
        )}
        {state === 'done' &&
          operation.kind === 'attach' &&
          operation.projectId &&
          actions.openChat && (
            <Button size="sm" onClick={() => actions.openChat!(operation.projectId!)}>
              Open Chat
            </Button>
          )}
        {state === 'done' &&
          ['create_vm', 'claim', 'install_host'].includes(operation.kind) &&
          actions.connectProject && (
            <Button size="sm" onClick={() => actions.connectProject!(operation.remoteId)}>
              Connect a project to {vmName}
            </Button>
          )}
      </div>
    </div>
  );
}

/** One line under an operation in the Activity list. */
export function operationSummary(operation: RemoteOperationDto): string {
  if (operation.state === 'failed') {
    const error = errorFirstLine(operation);
    return error ?? 'Stopped';
  }
  if (operation.state === 'running') {
    const { current, total } = stepProgress(operation);
    const step = operation.steps.find((candidate) => candidate.state === 'running');
    return total > 0 ? `Step ${current} of ${total}${step ? `: ${step.label}` : ''}` : 'Running';
  }
  return `${STATE_CHIPS[operation.state].label} ${formatTime(operation.updatedAt)}`;
}
