import { PROVIDER_CLI_NAMES } from '@devchain/shared';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { HOST_LIFECYCLE_KINDS } from '@/modules/remotes/operations/remote-operation.types';
import { isStuckFileSyncProblem } from '@/modules/remotes/sync/remote-file-sync.dto';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import type { RemoteProjectBindingRow } from '@/ui/lib/backend-provider';
import type { StatusTone } from '@/ui/lib/status-tone';
import { providerName } from './login-choices';

/**
 * The state of every VM and project on the Remote VMs page. Pure: the page
 * renders only this output, so it never offers a step the server refuses.
 * Open work comes only from running and failed operations; `lastOperation`
 * of a VM is read only as the terminal marker of the removed and not-set-up
 * rows, because a newer project operation can hide an older failed host one.
 */

export type { StatusTone };

/** How long a VM powered on from this page reads "Starting" before "Not answering". */
export const POWER_ON_GRACE_MS = 3 * 60_000;

export interface StatusInput {
  remotes: readonly RemoteListItemDto[];
  bindings: readonly RemoteProjectBindingRow[];
  /** Operations in any state; only running and failed ones count. */
  operations: readonly RemoteOperationDto[];
  /** Project names by id; ids show where a name is missing. */
  projectNames?: ReadonlyMap<string, string>;
  /** The newest operation of a project in any state, for its cleanup error. */
  newestProjectOperations?: ReadonlyMap<string, RemoteOperationDto>;
  /** When this page last sent Power on, per VM, in epoch ms. */
  poweredOnAt?: ReadonlyMap<string, number>;
  now?: number;
  formatTime?: (iso: string) => string;
}

export interface StatusContext {
  readonly remotes: readonly RemoteListItemDto[];
  readonly remotesById: ReadonlyMap<string, RemoteListItemDto>;
  readonly bindingByProject: ReadonlyMap<string, RemoteProjectBindingRow>;
  readonly bindingsByRemote: ReadonlyMap<string, readonly RemoteProjectBindingRow[]>;
  /** Running and failed operations, newest first. */
  readonly open: readonly RemoteOperationDto[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly newestProjectOperations: ReadonlyMap<string, RemoteOperationDto>;
  readonly poweredOnAt: ReadonlyMap<string, number>;
  readonly now: number;
  readonly formatTime: (iso: string) => string;
}

export function createStatusContext(input: StatusInput): StatusContext {
  const bindingsByRemote = new Map<string, RemoteProjectBindingRow[]>();
  for (const binding of input.bindings) {
    const list = bindingsByRemote.get(binding.remoteId) ?? [];
    list.push(binding);
    bindingsByRemote.set(binding.remoteId, list);
  }
  return {
    remotes: input.remotes,
    remotesById: new Map(input.remotes.map((remote) => [remote.id, remote])),
    bindingByProject: new Map(input.bindings.map((binding) => [binding.projectId, binding])),
    bindingsByRemote,
    open: input.operations
      .filter((operation) => operation.state === 'running' || operation.state === 'failed')
      .sort(newestFirst),
    projectNames: input.projectNames ?? new Map(),
    newestProjectOperations: input.newestProjectOperations ?? new Map(),
    poweredOnAt: input.poweredOnAt ?? new Map(),
    now: input.now ?? Date.now(),
    formatTime: input.formatTime ?? ((iso) => new Date(iso).toLocaleString()),
  };
}

export function newestFirst(a: RemoteOperationDto, b: RemoteOperationDto): number {
  return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

// ── Operation words ─────────────────────────────────────────────────────────

type HostKind = (typeof HOST_LIFECYCLE_KINDS)[number];

function isHostKind(kind: string): kind is HostKind {
  return (HOST_LIFECYCLE_KINDS as readonly string[]).includes(kind);
}

/** The VM's newest running or failed host operation; while it is open, no new setup starts. */
export function openHostOperation(
  operations: readonly RemoteOperationDto[],
  remoteId: string,
): RemoteOperationDto | undefined {
  return operations
    .filter(
      (operation) =>
        operation.remoteId === remoteId &&
        isHostKind(operation.kind) &&
        (operation.state === 'running' || operation.state === 'failed'),
    )
    .sort(newestFirst)[0];
}

/** An operation kind's words: in progress, as a noun, and as a detail title. */
interface KindWords {
  busy: string;
  noun: string;
  title: string;
}

/** Operations that move a project between this PC and a VM, or repair its file sync. */
const PROJECT_OPERATION_KINDS = ['attach', 'detach', 'force_sync', 'git_owner'];

const KIND_WORDS: Record<string, KindWords> = {
  claim: { busy: 'Setting up', noun: 'Setup', title: 'Set up' },
  install_host: { busy: 'Installing', noun: 'Install', title: 'Install' },
  update_host: { busy: 'Updating', noun: 'Update', title: 'Update' },
  update_logins: { busy: 'Changing logins', noun: 'Login change', title: 'Change logins' },
  create_vm: { busy: 'Creating', noun: 'Create', title: 'Create VM' },
  reset_vm: { busy: 'Resetting', noun: 'Reset', title: 'Reset' },
  destroy_vm: { busy: 'Destroying', noun: 'Destroy', title: 'Destroy' },
  attach: { busy: 'Connecting', noun: 'Connect', title: 'Connect' },
  force_sync: { busy: 'Force syncing', noun: 'Force sync', title: 'Force sync' },
  git_owner: { busy: 'Moving Git', noun: 'Git switch', title: 'Git switch' },
  detach: { busy: 'Disconnecting', noun: 'Disconnect', title: 'Disconnect' },
};

const DOCKER_INSTALL_WORDS: KindWords = {
  busy: 'Installing Docker',
  noun: 'Docker install',
  title: 'Install Docker',
};

export function kindWords(operation: RemoteOperationDto): KindWords {
  if (operation.kind === 'git_owner')
    return {
      ...KIND_WORDS.git_owner,
      busy: operation.details.owner === 'home' ? 'Moving Git to this PC' : 'Moving Git to the VM',
    };
  if (
    operation.kind === 'update_host' &&
    operation.details.dockerChange === true &&
    operation.details.versionChange === false
  ) {
    return DOCKER_INSTALL_WORDS;
  }
  return (
    KIND_WORDS[operation.kind] ?? { busy: 'Working', noun: 'Operation', title: operation.kind }
  );
}

/** The 1-based current step and the step count, skipped steps left out. */
export function stepProgress(operation: RemoteOperationDto): { current: number; total: number } {
  const steps = operation.steps.filter((step) => step.state !== 'skipped');
  const active = steps.findIndex((step) => step.state === 'running' || step.state === 'failed');
  const done = steps.filter((step) => step.state === 'done').length;
  return {
    current: active >= 0 ? active + 1 : Math.min(done + 1, steps.length),
    total: steps.length,
  };
}

function stepNote(operation: RemoteOperationDto): string | null {
  const { current, total } = stepProgress(operation);
  return total > 0 ? `step ${current} of ${total}` : null;
}

function failedStep(operation: RemoteOperationDto) {
  return operation.steps.find((step) => step.state === 'failed') ?? null;
}

/** The first line of the failed step's error, or null when it has none. */
export function errorFirstLine(operation: RemoteOperationDto): string | null {
  const message = failedStep(operation)?.error?.message?.split('\n')[0]?.trim();
  return message ? message : null;
}

function projectBusyLabel(operation: RemoteOperationDto, vm: string): string {
  const { kind } = operation;
  if (kind === 'git_owner') return kindWords(operation).busy;
  if (kind === 'attach') return `Connecting to ${vm}`;
  if (kind === 'force_sync') return KIND_WORDS.force_sync.busy;
  return `Disconnecting from ${vm}`;
}

export function canFixFileSync(binding: RemoteProjectBindingRow | undefined): boolean {
  return fileSyncFailedTotal(binding) > 0 || isStuckFileSyncProblem(binding?.fileSyncProblem);
}

/** Files that fail to sync on both sides of a binding; 0 when none were reported. */
export function fileSyncFailedTotal(binding: RemoteProjectBindingRow | undefined): number {
  return (binding?.fileSyncFailed?.home ?? 0) + (binding?.fileSyncFailed?.vm ?? 0);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function projectName(ctx: StatusContext, projectId: string): string {
  return ctx.projectNames.get(projectId) ?? projectId;
}

function remoteName(ctx: StatusContext, remoteId: string): string {
  return ctx.remotesById.get(remoteId)?.name ?? remoteId;
}

// ── VM state ────────────────────────────────────────────────────────────────

export type VmState =
  | 'removed'
  | 'busy'
  | 'stopped'
  | 'not-set-up'
  | 'provisioning'
  | 'powered-off'
  | 'starting'
  | 'api-key-rejected'
  | 'offline'
  | 'update-needed'
  | 'home-mismatch'
  | 'ready';

export type VmAction =
  | { kind: 'remove'; label: 'Remove from list' }
  | { kind: 'open-activity'; label: 'View'; operationId: string }
  | { kind: 'resolve'; label: 'Resolve'; operationId: string }
  | { kind: 'set-up'; label: 'Set up' }
  | { kind: 'power-on'; label: 'Power on' }
  | { kind: 'update'; label: 'Update' }
  | { kind: 'enter-api-key'; label: 'Enter API key' };

export interface VmChip {
  key: string;
  label: string;
  tone: StatusTone;
  /** Opens Activity on this operation. */
  operationId?: string;
}

export interface VmStatus {
  state: VmState;
  label: string;
  /** Secondary text after the label, such as "step 2 of 7". */
  note: string | null;
  tone: StatusTone;
  action: VmAction | null;
  /** The operation that makes the VM busy or stopped. */
  operation: RemoteOperationDto | null;
  chips: VmChip[];
}

function vmChips(remote: RemoteListItemDto, ctx: StatusContext): VmChip[] {
  const chips: VmChip[] = [];
  if (remote.docker?.installed) {
    chips.push(
      remote.docker.userInGroup
        ? { key: 'docker', label: 'Docker', tone: 'neutral' }
        : { key: 'docker', label: 'Docker · restart needed', tone: 'warn' },
    );
  }
  for (const operation of ctx.open) {
    if (operation.remoteId !== remote.id || operation.state !== 'running') continue;
    if (!PROJECT_OPERATION_KINDS.includes(operation.kind) || !operation.projectId) {
      continue;
    }
    const { current, total } = stepProgress(operation);
    chips.push({
      key: operation.id,
      label: `${kindWords(operation).busy} ${projectName(ctx, operation.projectId)}, ${current}/${total}`,
      tone: 'running',
      operationId: operation.id,
    });
  }
  return chips;
}

function offlineLabel(remote: RemoteListItemDto, ctx: StatusContext): string {
  if (remote.kind === 'proxmox') return 'Unreachable';
  if (remote.lastSeenAt === null) return 'Never reached';
  return `Offline since ${ctx.formatTime(remote.lastSeenAt)}`;
}

export function vmStatus(remote: RemoteListItemDto, ctx: StatusContext): VmStatus {
  const status = (
    state: VmState,
    label: string,
    tone: StatusTone,
    action: VmAction | null = null,
    extra: { note?: string | null; operation?: RemoteOperationDto | null } = {},
  ): VmStatus => ({
    state,
    label,
    note: extra.note ?? null,
    tone,
    action,
    operation: extra.operation ?? null,
    chips: vmChips(remote, ctx),
  });
  const last = remote.lastOperation;

  if (
    !remote.baseUrl &&
    last &&
    ((last.kind === 'create_vm' && last.state === 'cancelled') ||
      (last.kind === 'destroy_vm' && last.state === 'done'))
  ) {
    return status(
      'removed',
      last.kind === 'create_vm' ? 'Setup cancelled' : 'VM destroyed',
      'neutral',
      { kind: 'remove', label: 'Remove from list' },
    );
  }

  if (remote.apiKeyRejected) {
    return status('api-key-rejected', 'API key rejected', 'error', {
      kind: 'enter-api-key',
      label: 'Enter API key',
    });
  }

  const hostOperations = ctx.open.filter(
    (operation) => operation.remoteId === remote.id && isHostKind(operation.kind),
  );
  const running = hostOperations.find((operation) => operation.state === 'running');
  if (running) {
    return status(
      'busy',
      kindWords(running).busy,
      'running',
      { kind: 'open-activity', label: 'View', operationId: running.id },
      { note: stepNote(running), operation: running },
    );
  }
  const failed = hostOperations.find((operation) => operation.state === 'failed');
  if (failed) {
    // A failed operation reserves the VM: the server refuses a new setup, install
    // or update while it is open, so the only step is to resolve it.
    return status(
      'stopped',
      `${kindWords(failed).noun} stopped`,
      'error',
      { kind: 'resolve', label: 'Resolve', operationId: failed.id },
      { operation: failed },
    );
  }

  if (remote.kind === 'address' && remote.logins == null && !remote.online) {
    const cancelledSetup =
      last?.state === 'cancelled' && (last.kind === 'claim' || last.kind === 'install_host');
    return status('not-set-up', cancelledSetup ? 'Setup cancelled' : 'Not set up', 'neutral', {
      kind: 'set-up',
      label: 'Set up',
    });
  }

  if (!remote.baseUrl) return status('provisioning', 'Provisioning', 'running');

  if (remote.kind === 'proxmox' && remote.powerState === 'stopped') {
    return status('powered-off', 'Powered off', 'warn', { kind: 'power-on', label: 'Power on' });
  }

  if (remote.kind === 'proxmox' && !remote.online && remote.powerState === 'running') {
    const poweredOnAt = ctx.poweredOnAt.get(remote.id);
    return poweredOnAt !== undefined && ctx.now - poweredOnAt < POWER_ON_GRACE_MS
      ? status('starting', 'Starting', 'running')
      : status('starting', 'Not answering', 'warn');
  }

  if (!remote.online) {
    const holdsProjects = (ctx.bindingsByRemote.get(remote.id)?.length ?? 0) > 0;
    return status('offline', offlineLabel(remote, ctx), holdsProjects ? 'warn' : 'neutral');
  }

  if (!remote.versionMatches) {
    return status('update-needed', 'Update needed', 'warn', { kind: 'update', label: 'Update' });
  }
  if (remote.homePathMatches === false) {
    return status('home-mismatch', 'Home folder differs', 'warn');
  }
  return status('ready', 'Ready', 'ok');
}

const OFFLINE_STATES: ReadonlySet<VmState> = new Set(['offline', 'powered-off', 'starting']);

/** Why a VM cannot take a project now; null when it can. */
export function connectBlockedReason(status: VmStatus): string | null {
  if (status.state === 'ready') return null;
  if (OFFLINE_STATES.has(status.state)) return 'Offline';
  return status.label;
}

// ── Project state ───────────────────────────────────────────────────────────

export type ProjectState = 'busy' | 'stopped' | 'cleanup-failed' | 'leftover' | 'remote' | 'local';

export type ProjectAction =
  | { kind: 'view'; label: 'View'; operationId: string | null }
  | { kind: 'resolve'; label: 'Resolve'; operationId: string }
  | { kind: 'connect'; label: 'Connect'; disabledReason: string | null }
  | { kind: 'disconnect'; label: 'Disconnect' };

export interface ProjectStatus {
  state: ProjectState;
  label: string;
  note: string | null;
  tone: StatusTone;
  action: ProjectAction | null;
  /** The operation that makes the project busy or stopped. */
  operation: RemoteOperationDto | null;
  /** The VM the project is bound to or moving to, when there is one. */
  remoteId: string | null;
}

/** Per context, because every project on this PC asks for the same reason. */
const connectReasons = new WeakMap<StatusContext, string | null>();

/** Why Connect cannot start now, or null when a VM is ready. */
function connectDisabledReason(ctx: StatusContext): string | null {
  if (!connectReasons.has(ctx)) connectReasons.set(ctx, findConnectDisabledReason(ctx));
  return connectReasons.get(ctx) ?? null;
}

function findConnectDisabledReason(ctx: StatusContext): string | null {
  if (ctx.remotes.length === 0) return 'Add a VM first';
  return ctx.remotes.some((remote) => vmStatus(remote, ctx).state === 'ready')
    ? null
    : 'No VM is ready';
}

/** The VM answers and accepts this PC's API key, so host actions can reach it. */
export function vmReachable(remote: Pick<RemoteListItemDto, 'online' | 'apiKeyRejected'>): boolean {
  return remote.online && !remote.apiKeyRejected;
}

export type VmConnectionSecurity = 'pinned' | 'pinned-offline' | 'no-certificate';

export const VM_CONNECTION_LABELS: Record<VmConnectionSecurity, string> = {
  pinned: 'Encrypted (TLS) · certificate pinned',
  'pinned-offline': 'Certificate pinned · not connected now',
  'no-certificate': 'No certificate · add the VM again or reset it',
};

/** States where a VM may lack its certificate for now: setup saves it during its run. */
const CERTIFICATE_PENDING_STATES: ReadonlySet<VmState> = new Set([
  'busy',
  'stopped',
  'not-set-up',
  'provisioning',
]);

/**
 * How this PC's connection to the VM is secured, or null when there is nothing
 * to show. Every connection is TLS pinned to the VM's own certificate, and the
 * health poll uses it, so "online" means the VM's last answer passed the pin.
 */
export function vmConnectionSecurity(
  remote: Pick<RemoteListItemDto, 'online' | 'tlsFingerprint'>,
  state: VmState,
): VmConnectionSecurity | null {
  if (state === 'removed') return null;
  if (remote.tlsFingerprint) return remote.online ? 'pinned' : 'pinned-offline';
  return CERTIFICATE_PENDING_STATES.has(state) ? null : 'no-certificate';
}

/** A SHA-256 fingerprint in the colon form that `openssl x509 -fingerprint -sha256` prints. */
export function colonFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{2}/g)?.join(':') ?? fingerprint;
}

/** The note and tone of a project on a VM: the first problem, else "Files in sync". */
function remoteProjectNote(
  binding: RemoteProjectBindingRow,
  remote: RemoteListItemDto | undefined,
  vm: string,
): [string, StatusTone] {
  if (binding.syncError) return [`Sync failed: ${binding.syncError}`, 'error'];
  if (binding.fileSyncWarning) return [binding.fileSyncWarning, 'warn'];
  if (remote?.apiKeyRejected) return ['API key rejected', 'error'];
  if (!remote?.online) return ['VM offline', 'warn'];
  if (!remote.versionMatches) return [`Blocked until ${vm} is updated`, 'warn'];
  return ['Files in sync', 'ok'];
}

/** The cleanup error a cancelled Connect recorded, when it recorded one. */
function cleanupError(ctx: StatusContext, projectId: string): string | null {
  const details = ctx.newestProjectOperations.get(projectId)?.details;
  const error = details?.hostReleaseError ?? details?.dockerCleanupError;
  return typeof error === 'string' && error ? error : null;
}

export function projectStatus(projectId: string, ctx: StatusContext): ProjectStatus {
  const binding = ctx.bindingByProject.get(projectId);
  const projectOperations = ctx.open.filter((operation) => operation.projectId === projectId);

  const running = projectOperations.find(
    (operation) =>
      operation.state === 'running' && PROJECT_OPERATION_KINDS.includes(operation.kind),
  );
  if (running) {
    const vm = remoteName(ctx, running.remoteId);
    return {
      state: 'busy',
      label: projectBusyLabel(running, vm),
      note: stepNote(running),
      tone: 'running',
      action: { kind: 'view', label: 'View', operationId: running.id },
      operation: running,
      remoteId: running.remoteId,
    };
  }

  const failed = projectOperations.find((operation) => operation.state === 'failed');
  if (failed) {
    return {
      state: 'stopped',
      label: `${kindWords(failed).noun} stopped`,
      note: errorFirstLine(failed),
      tone: 'error',
      action: { kind: 'resolve', label: 'Resolve', operationId: failed.id },
      operation: failed,
      remoteId: failed.remoteId,
    };
  }

  if (binding?.state === 'failed') {
    return {
      state: 'cleanup-failed',
      label: `Connect cancelled. The copy on ${remoteName(ctx, binding.remoteId)} was not removed.`,
      note: cleanupError(ctx, projectId),
      tone: 'warn',
      action: { kind: 'connect', label: 'Connect', disabledReason: connectDisabledReason(ctx) },
      operation: null,
      remoteId: binding.remoteId,
    };
  }

  if (binding?.state === 'attaching' || binding?.state === 'detaching') {
    const detaching = binding.state === 'detaching';
    return {
      state: 'leftover',
      label: detaching ? 'Stuck while disconnecting' : 'Stuck while connecting',
      note: null,
      tone: 'error',
      action: detaching
        ? { kind: 'disconnect', label: 'Disconnect' }
        : {
            kind: 'view',
            label: 'View',
            operationId: ctx.newestProjectOperations.get(projectId)?.id ?? null,
          },
      operation: null,
      remoteId: binding.remoteId,
    };
  }

  if (binding?.state === 'remote') {
    const vm = remoteName(ctx, binding.remoteId);
    const [note, tone] = remoteProjectNote(binding, ctx.remotesById.get(binding.remoteId), vm);
    return {
      state: 'remote',
      label: `On ${vm}`,
      note,
      tone,
      action: { kind: 'disconnect', label: 'Disconnect' },
      operation: null,
      remoteId: binding.remoteId,
    };
  }

  return {
    state: 'local',
    label: 'This PC',
    note: null,
    tone: 'neutral',
    action: { kind: 'connect', label: 'Connect', disabledReason: connectDisabledReason(ctx) },
    operation: null,
    remoteId: null,
  };
}

// ── Recovery of a stopped project ───────────────────────────────────────────

export type RecoveryAction = 'retry' | 'cancel' | 'disconnect-instead' | 'force-disconnect';

/** Null leaves the operation's own recovery policy in charge. */
export function projectRecovery(operation: RemoteOperationDto): RecoveryAction[] | null {
  if (operation.state !== 'failed') return null;
  if (operation.kind === 'detach') return ['retry', 'cancel', 'force-disconnect'];
  if (operation.kind === 'git_owner') {
    const flipped = operation.steps.some(
      (step) =>
        step.id === 'git_flip' &&
        (step.startedAt != null || (step.state !== 'pending' && step.state !== 'skipped')),
    );
    return flipped ? ['retry', 'force-disconnect'] : ['retry', 'cancel', 'force-disconnect'];
  }
  if (operation.kind !== 'attach') return null;
  const bindState = operation.steps.find((step) => step.id === 'bind_remote')?.state;
  if (bindState === 'done') return ['retry', 'disconnect-instead'];
  if (bindState === 'running' || bindState === 'failed') return ['retry'];
  return ['retry', 'cancel'];
}

// ── Needs attention ─────────────────────────────────────────────────────────

export type AttentionAction =
  | { kind: 'fix-file-sync'; label: 'Fix'; projectId: string }
  | { kind: 'open-activity'; label: 'Open'; operationId: string }
  | { kind: 'view-vm'; label: 'View'; remoteId: string }
  | { kind: 'enter-api-key'; label: 'Enter API key'; remoteId: string };

/**
 * Opens the VM's drawer on the VMs tab. Overview stays read-only: the drawer
 * holds the VM's actions, for example Power on and Update.
 */
function viewVmAction(remoteId: string): AttentionAction {
  return { kind: 'view-vm', label: 'View', remoteId };
}

export interface AttentionItem {
  key: string;
  tone: 'error' | 'warn';
  text: string;
  action: AttentionAction | null;
}

/** Facts about this PC that the attention list reports. */
export interface PcFacts {
  /** From the PC check; omitted while unknown. */
  syncthing?: { ok: boolean; message: string | null } | null;
  /** This PC's DevChain version. */
  version?: string | null;
  /** This PC's home folder. */
  homePath?: string | null;
}

function operationTarget(ctx: StatusContext, operation: RemoteOperationDto): string {
  return operation.projectId
    ? projectName(ctx, operation.projectId)
    : remoteName(ctx, operation.remoteId);
}

function boundProjectNames(ctx: StatusContext, remoteId: string): string[] {
  return (ctx.bindingsByRemote.get(remoteId) ?? []).map((binding) =>
    projectName(ctx, binding.projectId),
  );
}

/** Errors first, then warnings; each with one sentence and at most one button. */
export function attentionItems(ctx: StatusContext, pc: PcFacts = {}): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const remote of ctx.remotes) {
    if (!remote.apiKeyRejected) continue;
    items.push({
      key: `api-key:${remote.id}`,
      tone: 'error',
      text: `${remote.name}: API key rejected. Enter a key from the VM to restore access.`,
      action: { kind: 'enter-api-key', label: 'Enter API key', remoteId: remote.id },
    });
  }

  for (const operation of ctx.open) {
    if (operation.state !== 'failed') continue;
    const step = failedStep(operation);
    const error = errorFirstLine(operation);
    const where = step ? ` at “${step.label}”` : '';
    items.push({
      key: `operation:${operation.id}`,
      tone: 'error',
      text: sentence(
        `${kindWords(operation).noun} of ${operationTarget(ctx, operation)} stopped${where}${
          error ? `: ${error}` : ''
        }`,
      ),
      action: { kind: 'open-activity', label: 'Open', operationId: operation.id },
    });
  }

  for (const binding of ctx.bindingByProject.values()) {
    if (!binding.syncError) continue;
    items.push({
      key: `sync:${binding.projectId}`,
      tone: 'error',
      text: sentence(`${projectName(ctx, binding.projectId)}: sync failed: ${binding.syncError}`),
      action: viewVmAction(binding.remoteId),
    });
  }

  for (const remote of ctx.remotes) {
    for (const provider of PROVIDER_CLI_NAMES) {
      const install = remote.providerClis?.[provider];
      if (install?.state !== 'failed') continue;
      items.push({
        key: `cli:${remote.id}:${provider}`,
        tone: 'error',
        text: sentence(
          `${providerName(provider)} CLI on ${remote.name} failed${
            install.error ? `: ${install.error}` : ''
          }`,
        ),
        action: viewVmAction(remote.id),
      });
    }
  }

  if (pc.syncthing && !pc.syncthing.ok && ctx.remotes.length > 0) {
    items.push({
      key: 'syncthing',
      tone: 'error',
      text: sentence(
        pc.syncthing.message
          ? `Syncthing is not usable on this PC: ${pc.syncthing.message}`
          : 'Syncthing is not usable on this PC',
      ),
      action: null,
    });
  }

  const statuses = ctx.remotes.map((remote) => ({ remote, status: vmStatus(remote, ctx) }));

  for (const { remote, status } of statuses) {
    if (status.state !== 'powered-off' && status.state !== 'offline') continue;
    const waiting = ctx.bindingsByRemote.get(remote.id)?.length ?? 0;
    if (waiting === 0) continue;
    const poweredOff = status.state === 'powered-off';
    items.push({
      key: `offline:${remote.id}`,
      tone: 'warn',
      text: `${remote.name} is ${poweredOff ? 'powered off' : 'offline'}. ${
        waiting === 1 ? '1 project waits' : `${waiting} projects wait`
      } for it.`,
      action: viewVmAction(remote.id),
    });
  }

  for (const { remote, status } of statuses) {
    if (status.state !== 'update-needed') continue;
    const projects = boundProjectNames(ctx, remote.id);
    const parts = [`${remote.name} runs DevChain ${remote.version ?? 'an unknown version'}.`];
    if (pc.version) parts.push(`This PC runs ${pc.version}.`);
    if (projects.length > 0) {
      parts.push(`Requests to ${projects.join(', ')} are blocked until you update.`);
    }
    items.push({
      key: `update:${remote.id}`,
      tone: 'warn',
      text: parts.join(' '),
      action: viewVmAction(remote.id),
    });
  }

  for (const { remote, status } of statuses) {
    if (status.state !== 'home-mismatch' && status.state !== 'update-needed') continue;
    if (remote.homePathMatches !== false) continue;
    const parts = [`${remote.name} uses the home folder ${remote.homePath}.`];
    if (pc.homePath) parts.push(`This PC uses ${pc.homePath}.`);
    parts.push('Projects cannot connect to it.');
    items.push({
      key: `home:${remote.id}`,
      tone: 'warn',
      text: parts.join(' '),
      action: viewVmAction(remote.id),
    });
  }

  for (const binding of ctx.bindingByProject.values()) {
    if (binding.state !== 'failed') continue;
    if (projectStatus(binding.projectId, ctx).state !== 'cleanup-failed') continue;
    const error = cleanupError(ctx, binding.projectId);
    items.push({
      key: `cleanup:${binding.projectId}`,
      tone: 'warn',
      text: `${projectName(ctx, binding.projectId)}: the copy on ${remoteName(
        ctx,
        binding.remoteId,
      )} was not removed.${error ? ` ${error}` : ''}`,
      action: null,
    });
  }

  for (const binding of ctx.bindingByProject.values()) {
    // The server sends failed counts only together with a warning.
    if (!binding.fileSyncWarning) continue;
    items.push({
      key: `file-sync:${binding.projectId}`,
      tone: 'warn',
      text: sentence(`${projectName(ctx, binding.projectId)}: ${binding.fileSyncWarning}`),
      action: canFixFileSync(binding)
        ? { kind: 'fix-file-sync', label: 'Fix', projectId: binding.projectId }
        : null,
    });
  }

  // Stable: each tone keeps the rule order above.
  return [
    ...items.filter((item) => item.tone === 'error'),
    ...items.filter((item) => item.tone === 'warn'),
  ];
}
