import { z } from 'zod';

export const FileSyncStatusQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    details: z.enum(['true', 'false']).optional(),
  })
  .strict();

/** The options of a status read. */
export interface FileSyncStatusOptions {
  /** Limits the answer to one project. */
  projectId?: string;
  /** Adds the folder details of each project. */
  details?: boolean;
}

export type FileSyncVerdict =
  | 'unknown'
  | 'disconnected'
  | 'problem'
  | 'busy'
  | 'syncing'
  | 'waiting'
  | 'in-sync';

/** What the user reads when the status could not be read, on the server or by the page. */
export const FILE_SYNC_STATUS_UNREADABLE = 'DevChain could not read the file sync status.';

export type SyncDirection = 'toVm' | 'fromVm';

export interface PendingCount {
  items: number;
  bytes: number;
}

export interface LastReceivedFile {
  path: string;
  at: string;
  deleted: boolean;
}

export interface FileSyncStatusLink {
  remoteId: string;
  connected: boolean | null;
  since: string | null;
  address: string | null;
  sentBytes: number | null;
  receivedBytes: number | null;
}

export interface FileSyncStatusFolder {
  id: string;
  kind: 'code' | 'git';
  type: string;
  paused: boolean;
  state: string | null;
  remoteState: string | null;
  files: number | null;
  bytes: number | null;
  toVm: PendingCount | null;
  fromVm: PendingCount | null;
  errors: number | null;
  error: string | null;
  watchError: string | null;
  lastReceived: LastReceivedFile | null;
  /** At most 10 paths per direction, read only for a direction with pending work. */
  pending: { direction: SyncDirection; path: string }[];
}

export interface FileSyncStatusScope {
  projectId: string;
  remoteId: string;
  verdict: FileSyncVerdict;
  /** One sentence for unknown, disconnected, problem and busy; null otherwise. */
  reason: string | null;
  toVm: PendingCount | null;
  fromVm: PendingCount | null;
  failed: { home: number | null; vm: number | null };
  files: number | null;
  bytes: number | null;
  lastReceived: LastReceivedFile | null;
  /** Only with `details=true`. */
  folders?: FileSyncStatusFolder[];
}

/** Values home cannot read are null, never 0. */
export interface FileSyncStatusResponse {
  checkedAt: string;
  syncthing: { running: boolean; version: string | null; error: string | null };
  links: FileSyncStatusLink[];
  scopes: FileSyncStatusScope[];
}
