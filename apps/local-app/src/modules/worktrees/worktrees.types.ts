import type { Worktree } from '../storage/models/domain.models';

export interface CreateLaneOptions {
  name?: string;
  baseRef?: string;
  epicId?: string;
}

export type CreatedLane = Worktree & { projectRootPath: string };

export interface DirtyFile {
  path: string;
  status: string;
  originalPath?: string;
}

export type ConflictPreview =
  | { status: 'clean' | 'conflicts'; files: string[] }
  | { status: 'unavailable'; files: string[]; stderr: string };

export interface LaneState extends Worktree {
  status: 'present' | 'missing' | 'unavailable';
  headSha: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyFiles: DirtyFile[];
  epic: { id: string; title: string; agentName: string | null } | null;
  stateError?: string;
}

export interface LaneList {
  projectRootPath: string;
  lanes: LaneState[];
  rootDirtyFiles: DirtyFile[];
  preview?: ConflictPreview;
}

export interface RemovedLane {
  status: 'removed' | 'pruned';
  path: string;
  branch: string;
  deletedIgnoredPaths: string[];
  deletedIgnoredPathCount: number;
  ignoredPathsTruncated: boolean;
}

export interface CommittedLane {
  sha: string;
  files: string[];
}

export interface MergedLane {
  baseBranch: string;
  oldSha: string;
  newSha: string;
}
