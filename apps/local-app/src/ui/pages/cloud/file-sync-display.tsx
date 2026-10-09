import type { FolderNeed } from './lib/remote-vm-contracts';

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
