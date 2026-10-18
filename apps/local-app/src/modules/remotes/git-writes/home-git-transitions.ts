import { AppError } from '../../../common/errors/error-types';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';

export interface HomeGitTransitionContext {
  projectId: string;
  remoteId: string;
  remoteName: string;
  /** The VM record the decision was made from. */
  record: GitCoordinatorRecord;
  /** The home write a handover is for; the VM registers it when it publishes the move. */
  writeId?: string;
  /** Fires when the supervisor that asked for the write goes away; a pre-flip handover aborts. */
  signal: AbortSignal;
  /** Runs as soon as a VM record lists `writeId`, so home saves the write before any later step. */
  published?: (record: GitCoordinatorRecord) => void;
}

/**
 * Moves Git ownership for a home write. `handover` brings Git from the VM to this PC;
 * `stepDown` gives up a home ownership the VM has reclaimed. Both leave `GitOwnerStore` with
 * the VM record this PC then follows.
 */
export abstract class HomeGitTransitions {
  abstract handover(context: HomeGitTransitionContext): Promise<void>;
  abstract stepDown(context: HomeGitTransitionContext): Promise<void>;
}

/** A VM reclaim is journaled: no home move starts until it ends. */
export function gitReclaimPending(): AppError {
  return new AppError(
    'Git is moving back to the VM; run Git again in a moment.',
    'GIT_RECLAIM_PENDING',
    409,
  );
}
