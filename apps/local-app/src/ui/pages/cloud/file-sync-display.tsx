import type { StatusTone } from '@/ui/lib/status-tone';
import type {
  FileSyncStatusScope,
  FileSyncVerdict,
  FolderNeed,
  LastReceivedFile,
  PendingCount,
} from './lib/remote-vm-contracts';
import type { ProjectListRow } from './ProjectList';

/** The short name of each measured file sync status. */
export const SYNC_VERDICT_LABELS: Record<FileSyncVerdict, string> = {
  'in-sync': 'In sync',
  syncing: 'Syncing',
  waiting: 'Waiting',
  disconnected: 'Disconnected',
  problem: 'Problem',
  busy: 'Busy',
  unknown: 'Unknown',
};

/** Only an active transfer uses `running`: StatusChip shows a spinner for it. */
export const SYNC_VERDICT_TONES: Record<FileSyncVerdict, StatusTone> = {
  'in-sync': 'ok',
  syncing: 'running',
  waiting: 'info',
  busy: 'info',
  disconnected: 'warn',
  problem: 'warn',
  unknown: 'warn',
};

/** The filter group of each measured status in the File sync tab. */
export type FileSyncGroup = 'attention' | 'pending' | 'in-sync';

export const SYNC_VERDICT_GROUPS: Record<FileSyncVerdict, FileSyncGroup> = {
  problem: 'attention',
  disconnected: 'attention',
  unknown: 'attention',
  syncing: 'pending',
  waiting: 'pending',
  busy: 'pending',
  'in-sync': 'in-sync',
};

export const SYNC_GROUP_LABELS: Record<FileSyncGroup, string> = {
  attention: 'Needs attention',
  pending: 'Syncing or paused',
  'in-sync': 'In sync',
};

/** A filter of the File sync tab: every project, or one group. */
export type FileSyncFilter = 'all' | FileSyncGroup;

/** The actions the File sync tab offers for a project. */
export interface FileSyncTabActions {
  readonly openSettings: (row: ProjectListRow) => void;
  readonly fixFileSync: (row: ProjectListRow) => void;
  readonly canFixFileSync: (row: ProjectListRow) => boolean;
}

/** One project of the File sync table: its name, VM, measured status and the row whose actions it offers. */
export interface FileSyncProjectItem {
  readonly scope: FileSyncStatusScope;
  readonly project: string;
  readonly vm: string;
  /** Present only while the project is still on the VM of the scope. */
  readonly row: ProjectListRow | undefined;
}

export function groupOf(item: FileSyncProjectItem): FileSyncGroup {
  return SYNC_VERDICT_GROUPS[item.scope.verdict];
}

/**
 * The order of the File sync table: "Needs attention" first, then by project name; the
 * project id keeps equal names stable.
 */
export function compareTableOrder(a: FileSyncProjectItem, b: FileSyncProjectItem): number {
  const attention = (item: FileSyncProjectItem) => (groupOf(item) === 'attention' ? 0 : 1);
  return (
    attention(a) - attention(b) ||
    a.project.localeCompare(b.project) ||
    a.scope.projectId.localeCompare(b.scope.projectId)
  );
}

/** Unlike `break-words`, this also lowers the min-content width, so an unbroken name cannot widen its box. */
export const WRAP = '[overflow-wrap:anywhere]';

/** The full local date and time, or "unknown" for a value that is not a time. */
export function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 'unknown' : new Date(parsed).toLocaleString();
}

/** Per-folder progress the file-sync steps keep in `details.fileSync.folders`. */
export interface FolderProgress {
  completion: number;
  needItems: number;
  needBytes: number;
}

export function folderLabel(folderId: string): string {
  if (folderId.startsWith('code:')) return 'Project files';
  if (folderId.startsWith('git:')) return 'Git history';
  const provider = /^tx:([^:]+):/.exec(folderId)?.[1];
  if (provider === 'claude') return 'Claude transcripts';
  return provider ? `${provider} transcripts` : folderId;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "N items, size" of a pending direction; "unknown" when home could not read it. */
export function pendingText(pending: PendingCount | null): string {
  if (!pending) return 'unknown';
  return `${pending.items} ${pending.items === 1 ? 'item' : 'items'}, ${formatBytes(pending.bytes)}`;
}

/** A count, or "unknown" when home could not read it. */
export function countText(count: number | null): string {
  return count === null ? 'unknown' : String(count);
}

/** A size, or "unknown" when home could not read it. */
export function bytesText(bytes: number | null): string {
  return bytes === null ? 'unknown' : formatBytes(bytes);
}

/** The last received file and its time; each view gives its own time format. */
export function lastReceivedText(
  file: LastReceivedFile | null,
  formatTime: (iso: string) => string,
): string {
  if (!file) return 'unknown';
  return `${file.path}${file.deleted ? ' (deleted)' : ''} at ${formatTime(file.at)}`;
}

/** Seconds below 90 s, whole minutes above. */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

export function readFolderProgress(details: Record<string, unknown>): [string, FolderProgress][] {
  const folders = (details.fileSync as { folders?: Record<string, FolderProgress> } | undefined)
    ?.folders;
  return folders && typeof folders === 'object' ? Object.entries(folders) : [];
}

/**
 * Loss-list lines for files home had not received. `folders` null means the
 * numbers are unknown and the generic line stands in for them.
 */
export function FileSyncLossItems({
  folders,
  generic,
}: {
  folders: FolderNeed[] | null;
  generic: string;
}) {
  if (!folders) return <li>{generic}</li>;
  const missing = folders.filter((folder) => folder.needItems > 0 || folder.needBytes > 0);
  if (missing.length === 0) return <li>All synced files had been received.</li>;
  return (
    <>
      {missing.map((folder) => (
        <li key={folder.id}>
          {folderLabel(folder.id)}: files not yet received: {folder.needItems} items,{' '}
          {formatBytes(folder.needBytes)}
        </li>
      ))}
    </>
  );
}
