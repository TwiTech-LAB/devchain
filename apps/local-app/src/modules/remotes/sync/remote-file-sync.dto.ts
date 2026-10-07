import { z } from 'zod';
import { IGNORE_PATTERN_MAX_LENGTH } from '../../file-sync/file-sync.dto';
import type {
  ExclusionSuggestions,
  SyncPathFacts,
  SyncPathInspection,
  SyncPathOwner,
} from '../../file-sync/sync-path-inspection.dto';

export interface SaveProjectIgnoresResult {
  ignores: string[];
  revision: number;
  applied: boolean;
  message: string;
}

export interface FileSyncFailedCounts {
  home: number;
  vm: number;
}

export interface FailedSyncFile {
  path: string;
  error: string;
  owner: SyncPathOwner | null;
  git:
    | (Pick<
        SyncPathFacts,
        'ignored' | 'ignoreRule' | 'ignoredAncestor' | 'tracked' | 'trackedDescendants'
      > & {
        state: SyncPathInspection['gitState'];
      })
    | null;
}

export interface FailedSyncSide {
  entries: FailedSyncFile[];
  readError?: string;
}

export interface ProjectFileSyncFailures extends ExclusionSuggestions {
  vmUser?: SyncPathOwner | null;
  ownershipNotes?: string[];
  installedPrefix: string[];
  forceSync: ForceSyncOffer;
  ownerSide: 'vm';
  home: FailedSyncSide;
  vm: FailedSyncSide;
}

export type FileSyncProblem = 'connection' | 'failed-files' | 'error' | 'stalled' | 'setup';
const STUCK_FILE_SYNC_PROBLEMS: readonly string[] = [
  'error',
  'stalled',
  'setup',
] satisfies FileSyncProblem[];
/** A problem that Fix file sync can repair and that lets Force sync be offered. */
export const isStuckFileSyncProblem = (problem: string | null | undefined): boolean =>
  STUCK_FILE_SYNC_PROBLEMS.includes(problem ?? '');

export interface ForceSyncOffer {
  offered: boolean;
  reason: string | null;
  pending: { fromVm: number | null; fromHome: number | null };
}

export const PatternPreviewRequestSchema = z
  .object({ pattern: z.string().trim().min(1).max(IGNORE_PATTERN_MAX_LENGTH) })
  .strict();
export type PatternPreviewRequest = z.infer<typeof PatternPreviewRequestSchema>;

export interface PatternPreviewCounts {
  count: number;
  sample: string[];
}

export type PatternPreviewSide =
  | { state: 'checked'; tracked: PatternPreviewCounts; kept: PatternPreviewCounts }
  | { state: 'no-root' | 'no-repo' | 'error'; tracked: null; kept: null };

export interface ProjectPatternPreview {
  home: PatternPreviewSide;
  vm: PatternPreviewSide | { state: 'unavailable'; tracked: null; kept: null };
}
