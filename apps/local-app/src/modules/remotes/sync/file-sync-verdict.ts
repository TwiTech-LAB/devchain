import { failedCount, type FolderSyncStatus } from '../../file-sync/file-sync.dto';
import {
  FILE_SYNC_STATUS_UNREADABLE,
  type FileSyncVerdict,
  type PendingCount,
  type SyncDirection,
} from './file-sync-status.dto';
import type { FileSyncUpkeepState } from './remote-file-sync.dto';

/** A previous sample older than this cannot show progress. */
const SAMPLE_MAX_AGE_MS = 60_000;
/** A direction whose pending count went down this recently is `syncing`. */
const PROGRESS_WINDOW_MS = 15_000;
/** The home folder type that takes no part in a direction. */
const NO_PART: Record<SyncDirection, string> = { toVm: 'receiveonly', fromVm: 'sendonly' };

export interface VerdictFolder {
  /** Home's Syncthing folder type. */
  type: string;
  /** Paused in home's config, or Syncthing answered that the folder is paused. */
  paused: boolean;
  /** Home's status with the VM's completion in `peer`; null for a paused folder. */
  status: FolderSyncStatus | null;
}

export interface ScopeFacts {
  syncthing: { running: boolean; error: string | null };
  readFailed: boolean;
  codeConfigured: boolean;
  connected: boolean;
  forceSync: 'running' | 'failed' | null;
  /** Online, API key accepted and the same version: the conditions under which upkeep runs. */
  upkeepTrusted: boolean;
  /** Upkeep's state for this project and VM, or null when it has none. */
  upkeep: FileSyncUpkeepState | null;
  folders: VerdictFolder[];
}

export interface PendingSample extends PendingCount {
  at: number;
  progressAt?: number;
}

export interface ScopeMemory {
  toVm?: PendingSample;
  fromVm?: PendingSample;
}

export interface ScopeOutcome {
  verdict: FileSyncVerdict;
  reason: string | null;
  toVm: PendingCount | null;
  fromVm: PendingCount | null;
  failedHome: number | null;
  memory: ScopeMemory;
}

/**
 * The status of one project on a VM; pure, so that callers own all reads and the memory.
 * With `recompute`, `memory` already holds the counters of this observation, so the call adds
 * no sample.
 */
export function scopeStatus(
  facts: ScopeFacts,
  memory: ScopeMemory | undefined,
  now: number,
  recompute = false,
): ScopeOutcome {
  const noCounts = { toVm: null, fromVm: null, failedHome: null, memory: memory ?? {} };
  if (!facts.syncthing.running || facts.readFailed) {
    const reason =
      (!facts.syncthing.running && facts.syncthing.error) || FILE_SYNC_STATUS_UNREADABLE;
    return { verdict: 'unknown', reason, ...noCounts };
  }
  if (!facts.codeConfigured) {
    if (settingUp(facts))
      return { verdict: 'busy', reason: 'File sync is being set up.', ...noCounts };
    const reason = 'File sync is not set up for this project on this PC.';
    return { verdict: 'problem', reason, ...noCounts };
  }

  const active = facts.folders.filter((folder) => !folder.paused && folder.status);
  const toVm = pending(active, 'toVm');
  const fromVm = pending(active, 'fromVm');
  const failedHome = active.reduce((sum, folder) => sum + failedCount(folder.status!), 0);
  const next: ScopeMemory = recompute
    ? (memory ?? {})
    : {
        toVm: nextSample(memory?.toVm, toVm, now),
        fromVm: nextSample(memory?.fromVm, fromVm, now),
      };
  const result = (verdict: FileSyncVerdict, reason: string | null = null): ScopeOutcome => ({
    verdict,
    reason,
    toVm,
    fromVm,
    failedHome,
    memory: next,
  });

  if (!facts.connected) return result('disconnected', 'No file sync connection to the VM.');

  const upkeep = trustedUpkeep(facts);
  const remoteStates = active.map((folder) => folder.status!.peer?.remoteState ?? 'unknown');
  if (facts.forceSync === 'failed')
    return result('problem', 'Force sync stopped. Open Activity to continue.');
  if (upkeep?.problem && upkeep.problem !== 'connection')
    return result('problem', upkeep.warning ?? FILE_SYNC_STATUS_UNREADABLE);
  for (const { status } of active) {
    const error =
      status!.error?.trim() || (status!.state === 'error' ? 'folder is in an error state' : '');
    if (error) return result('problem', `File sync has an error: ${error.replace(/\.$/, '')}.`);
  }
  if (remoteStates.includes('notSharing'))
    return result('problem', 'The VM does not share this folder.');

  if (facts.forceSync === 'running') return result('busy', 'Force sync is running.');
  if (settingUp(facts)) return result('busy', 'File sync is being set up.');
  if (facts.folders.some((folder) => folder.paused))
    return result('busy', 'File sync is paused on this PC.');
  if (remoteStates.includes('paused')) return result('busy', 'File sync is paused on the VM.');
  if (remoteStates.some((state) => state !== 'valid'))
    return result('busy', 'The VM has not reported its folder state yet.');

  const pulling = active.some(
    (folder) =>
      takesPart(folder.type, 'fromVm') &&
      (folder.status!.state === 'syncing' || folder.status!.state === 'sync-preparing'),
  );
  const progressing = progressed(toVm, next.toVm, now) || progressed(fromVm, next.fromVm, now);
  if (pulling || progressing) return result('syncing');
  if (hasWork(toVm) || hasWork(fromVm)) return result('waiting');
  if (failedHome > 0)
    return result(
      'problem',
      failedHome === 1
        ? '1 file on this PC fails to sync.'
        : `${failedHome} files on this PC fail to sync.`,
    );
  return result('in-sync');
}

/** Upkeep's state under the conditions in which upkeep runs; without them the state is old. */
export function trustedUpkeep({
  upkeepTrusted,
  upkeep,
}: Pick<ScopeFacts, 'upkeepTrusted' | 'upkeep'>): FileSyncUpkeepState | null {
  return upkeepTrusted ? upkeep : null;
}

function settingUp(facts: ScopeFacts): boolean {
  const upkeep = trustedUpkeep(facts);
  return upkeep !== null && !upkeep.done;
}

/** A send-only folder takes nothing from the VM; a receive-only folder sends nothing to it. */
export function takesPart(type: string, direction: SyncDirection): boolean {
  return type !== NO_PART[direction];
}

/**
 * Pending work of one folder in each direction. Null for a direction that its home type takes
 * no part in, and for a count that was not read.
 */
export function folderCounts({
  type,
  status,
}: Pick<VerdictFolder, 'type' | 'status'>): Record<SyncDirection, PendingCount | null> {
  const peer = status?.peer;
  return {
    toVm:
      takesPart(type, 'toVm') && peer
        ? { items: peer.needItems + (peer.needDeletes ?? 0), bytes: peer.needBytes }
        : null,
    fromVm:
      takesPart(type, 'fromVm') && status
        ? { items: status.needTotalItems, bytes: status.needBytes }
        : null,
  };
}

/** The sum over the folders of one direction; null when no folder of it was read. */
function pending(folders: VerdictFolder[], direction: SyncDirection): PendingCount | null {
  const inDirection = folders.filter((folder) => takesPart(folder.type, direction));
  if (inDirection.length === 0) return null;
  const total = { items: 0, bytes: 0 };
  for (const folder of inDirection) {
    const count = folderCounts(folder)[direction];
    if (!count) return null;
    total.items += count.items;
    total.bytes += count.bytes;
  }
  return total;
}

function hasWork(count: PendingCount | null): boolean {
  return count !== null && (count.items > 0 || count.bytes > 0);
}

function progressed(
  count: PendingCount | null,
  sample: PendingSample | undefined,
  now: number,
): boolean {
  return (
    hasWork(count) &&
    sample?.progressAt !== undefined &&
    now - sample.progressAt <= PROGRESS_WINDOW_MS
  );
}

/** `previous` must be an older observation of the same project and VM than `current`. */
function nextSample(
  previous: PendingSample | undefined,
  current: PendingCount | null,
  now: number,
): PendingSample | undefined {
  if (!current)
    return previous && { items: previous.items, bytes: previous.bytes, at: previous.at };
  const sample = { ...current, at: now };
  if (!hasWork(current) || !previous || now - previous.at > SAMPLE_MAX_AGE_MS) return sample;
  if (current.items < previous.items || current.bytes < previous.bytes)
    return { ...sample, progressAt: now };
  if (current.items > previous.items || current.bytes > previous.bytes) return sample;
  return previous.progressAt === undefined
    ? sample
    : { ...sample, progressAt: previous.progressAt };
}
