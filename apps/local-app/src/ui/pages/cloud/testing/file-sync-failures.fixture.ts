import type { ExclusionSuggestion } from '@/modules/file-sync/sync-path-inspection.dto';
import type {
  FailedSyncFile,
  ProjectFileSyncFailures,
} from '@/modules/remotes/sync/remote-file-sync.dto';

export function failedFile(overrides: Partial<FailedSyncFile> = {}): FailedSyncFile {
  return {
    path: 'logs/error.txt',
    error: 'syncing: chmod: operation not permitted',
    owner: { uid: 0, name: 'root' },
    git: {
      state: 'repo',
      ignored: true,
      ignoreRule: null,
      ignoredAncestor: 'logs',
      tracked: false,
      trackedDescendants: [],
    },
    ...overrides,
  };
}
export function exclusion(overrides: Partial<ExclusionSuggestion> = {}): ExclusionSuggestion {
  return {
    path: 'logs',
    side: 'vm',
    owner: { uid: 0, name: 'root' },
    home: null,
    vm: {
      path: 'logs',
      kind: 'folder',
      owner: { uid: 0, name: 'root' },
      foreignOwner: true,
      foreignOwners: [],
      fileCount: 3,
      ignored: true,
      ignoreRule: null,
      ignoreRules: [],
      ignoredAncestor: null,
      tracked: false,
      trackedDescendants: ['logs/keep.txt'],
    },
    fileCount: 3,
    reason: 'Written by another user (root)',
    reasonKind: 'foreignOwner',
    selected: true,
    pattern: '(?d)/logs',
    patterns: ['!/logs/keep.txt', '(?d)/logs'],
    ...overrides,
  };
}
export function fileSyncFailures(
  overrides: Partial<ProjectFileSyncFailures> = {},
): ProjectFileSyncFailures {
  return {
    forceSync: {
      offered: false,
      reason: 'Repair file permissions before using Force sync.',
      pending: { fromVm: null, fromHome: null },
    },
    installedPrefix: ['/.git'],
    ownerSide: 'vm',
    home: {
      entries: [
        failedFile({
          path: 'cache/temp',
          owner: { uid: 48, name: 'uid 48' },
          error: 'hashing: permission denied',
          git: { ...failedFile().git!, state: 'no-repo' },
        }),
      ],
    },
    vm: { entries: [failedFile()] },
    groups: [exclusion()],
    overLimit: false,
    ...overrides,
  };
}
