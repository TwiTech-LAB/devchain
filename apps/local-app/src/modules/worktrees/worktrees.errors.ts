import { AppError } from '../../common/errors/error-types';

export type WorktreeErrorCode =
  | 'LANES_FROZEN'
  | 'GIT_NOT_OWNED'
  | 'GIT_OWNERSHIP_UNKNOWN'
  | 'GIT_SYNC_IGNORES_PENDING'
  | 'FORBIDDEN_NOT_TEAM_LEAD'
  | 'WORKTREE_INVALID_NAME'
  | 'WORKTREE_INVALID_EPIC'
  | 'WORKTREE_NAME_EXISTS'
  | 'WORKTREE_PATH_EXISTS'
  | 'WORKTREE_LIMIT_REACHED'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_DIRTY'
  | 'WORKTREE_LOCAL_ENV'
  | 'WORKTREE_GIT_FAILED'
  | 'WORKTREE_SETUP_FAILED'
  | 'UNMERGED_PATHS'
  | 'CONFLICT_MARKERS'
  | 'NOTHING_TO_COMMIT'
  | 'COMMIT_FAILED'
  | 'MERGE_IN_PROGRESS'
  | 'HEAD_MISMATCH'
  | 'TARGET_NOT_CHECKED_OUT'
  | 'BEHIND'
  | 'ROOT_REFUSED'
  | 'BASE_REF_REQUIRED'
  | 'BASE_MUST_BE_BRANCH';

export class WorktreeError extends AppError {
  constructor(
    code: WorktreeErrorCode,
    message: string,
    statusCode = 409,
    details?: Record<string, unknown>,
  ) {
    super(message, code, statusCode, details);
  }
}
