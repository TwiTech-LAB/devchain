// Review Status enum
export type ReviewStatus = 'draft' | 'pending' | 'changes_requested' | 'approved' | 'closed';

// Review Mode enum
export type ReviewMode = 'working_tree' | 'commit';

// Review Comment Status enum
export type CommentStatus = 'open' | 'resolved' | 'wont_fix';

// Review Comment Type enum
export type CommentType = 'comment' | 'suggestion' | 'issue' | 'approval';

// Author Type enum
export type AuthorType = 'user' | 'agent';

export interface Review {
  id: string;
  projectId: string;
  epicId: string | null;
  title: string;
  description: string | null;
  status: ReviewStatus;
  mode: ReviewMode;
  baseRef: string;
  headRef: string;
  baseSha: string | null;
  headSha: string | null;
  createdBy: AuthorType;
  createdByAgentId: string | null;
  version: number;
  commentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewsListResponse {
  items: Review[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Create Review Request
 *
 * For working_tree mode, baseSha/headSha are not used (changes are uncommitted).
 * For commit mode, baseSha/headSha are resolved from refs if not provided.
 */
export interface CreateReviewRequest {
  projectId: string;
  epicId?: string | null;
  title: string;
  description?: string | null;
  status?: ReviewStatus;
  /** Review mode - 'working_tree' for uncommitted changes, 'commit' for specific commits */
  mode?: ReviewMode;
  /** Base ref - branch name, tag, or commit SHA */
  baseRef: string;
  /** Head ref - branch name, tag, or commit SHA */
  headRef: string;
  /** Pre-resolved base SHA. Only used for commit mode. */
  baseSha?: string | null;
  /** Pre-resolved head SHA. Only used for commit mode. */
  headSha?: string | null;
  createdBy?: AuthorType;
  createdByAgentId?: string | null;
}

export interface UpdateReviewRequest {
  title?: string;
  description?: string | null;
  status?: ReviewStatus;
  headSha?: string;
  version: number;
}

/** Target agent with resolved name */
export interface ReviewCommentTargetAgent {
  agentId: string;
  name: string;
}

export interface ReviewComment {
  id: string;
  reviewId: string;
  filePath: string | null;
  parentId: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** Side of diff: 'old' = base/left, 'new' = head/right (matches git convention) */
  side: 'old' | 'new' | null;
  content: string;
  commentType: CommentType;
  status: CommentStatus;
  authorType: AuthorType;
  authorAgentId: string | null;
  /** Agent name for agent-authored comments (null if user-authored or agent deleted) */
  authorAgentName: string | null;
  /** Target agents with resolved names */
  targetAgents: ReviewCommentTargetAgent[];
  version: number;
  /** Timestamp of last edit, null if never edited */
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentsListResponse {
  items: ReviewComment[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Fetch reviews for a project
 */
export async function fetchReviews(
  projectId: string,
  options?: {
    status?: ReviewStatus;
    epicId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<ReviewsListResponse> {
  const params = new URLSearchParams({ projectId });

  if (options?.status) {
    params.append('status', options.status);
  }
  if (options?.epicId) {
    params.append('epicId', options.epicId);
  }
  if (options?.limit !== undefined) {
    params.append('limit', String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.append('offset', String(options.offset));
  }

  const response = await fetch(`/api/reviews?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch reviews');
  }
  return response.json();
}

/**
 * Fetch a single review by ID
 */
export async function fetchReview(reviewId: string): Promise<Review> {
  const response = await fetch(`/api/reviews/${reviewId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch review');
  }
  return response.json();
}

/**
 * Create a new review
 */
export async function createReview(request: CreateReviewRequest): Promise<Review> {
  const response = await fetch('/api/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to create review');
  }
  return response.json();
}

/**
 * Update an existing review
 */
export async function updateReview(
  reviewId: string,
  request: UpdateReviewRequest,
): Promise<Review> {
  const response = await fetch(`/api/reviews/${reviewId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to update review');
  }
  return response.json();
}

/**
 * Delete a review
 */
export async function deleteReview(reviewId: string): Promise<void> {
  const response = await fetch(`/api/reviews/${reviewId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Failed to delete review');
  }
}

/**
 * Fetch comments for a review
 */
export async function fetchReviewComments(
  reviewId: string,
  options?: {
    status?: CommentStatus;
    filePath?: string;
    limit?: number;
    offset?: number;
  },
): Promise<CommentsListResponse> {
  const params = new URLSearchParams();

  if (options?.status) {
    params.append('status', options.status);
  }
  if (options?.filePath) {
    params.append('filePath', options.filePath);
  }
  if (options?.limit !== undefined) {
    params.append('limit', String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.append('offset', String(options.offset));
  }

  const queryString = params.toString();
  const url = queryString
    ? `/api/reviews/${reviewId}/comments?${queryString}`
    : `/api/reviews/${reviewId}/comments`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch review comments');
  }
  return response.json();
}

// Status badge color mapping
export const STATUS_COLORS: Record<ReviewStatus, { bg: string; text: string }> = {
  draft: { bg: 'bg-gray-100', text: 'text-gray-700' },
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  changes_requested: { bg: 'bg-orange-100', text: 'text-orange-800' },
  approved: { bg: 'bg-green-100', text: 'text-green-800' },
  closed: { bg: 'bg-slate-100', text: 'text-slate-600' },
};

// Status display names
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: 'Draft',
  pending: 'Pending',
  changes_requested: 'Changes Requested',
  approved: 'Approved',
  closed: 'Closed',
};

// ============================================
// Git API Types and Functions
// ============================================

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
}

export interface GitBranch {
  name: string;
  sha: string;
  isCurrent: boolean;
}

export interface GitTag {
  name: string;
  sha: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  oldPath?: string;
}

/**
 * Fetch commits for a project
 */
export async function fetchCommits(
  projectId: string,
  options?: { ref?: string; limit?: number },
): Promise<GitCommit[]> {
  const params = new URLSearchParams({ projectId });
  if (options?.ref) {
    params.append('ref', options.ref);
  }
  if (options?.limit !== undefined) {
    params.append('limit', String(options.limit));
  }

  const response = await fetch(`/api/git/commits?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch commits');
  }
  return response.json();
}

/**
 * Fetch branches for a project
 */
export async function fetchBranches(projectId: string): Promise<GitBranch[]> {
  const response = await fetch(`/api/git/branches?projectId=${projectId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch branches');
  }
  return response.json();
}

/**
 * Fetch tags for a project
 */
export async function fetchTags(projectId: string): Promise<GitTag[]> {
  const response = await fetch(`/api/git/tags?projectId=${projectId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch tags');
  }
  return response.json();
}

/**
 * Fetch changed files between two refs
 */
export async function fetchChangedFiles(
  projectId: string,
  base: string,
  head: string,
): Promise<ChangedFile[]> {
  const params = new URLSearchParams({ projectId, base, head });
  const response = await fetch(`/api/git/changed-files?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch changed files');
  }
  return response.json();
}

/**
 * Fetch unified diff between two refs
 */
export async function fetchDiff(projectId: string, base: string, head: string): Promise<string> {
  const params = new URLSearchParams({ projectId, base, head });
  const response = await fetch(`/api/git/diff?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch diff');
  }
  const data = await response.json();
  return data.diff;
}

// ============================================
// Working Tree API Types and Functions
// ============================================

export type WorkingTreeFilter = 'all' | 'staged' | 'unstaged';

export interface WorkingTreeChanges {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: string[];
}

export interface WorkingTreeResponse {
  changes: WorkingTreeChanges;
  diff: string;
  /** True if untracked file diffs were capped for performance */
  untrackedDiffsCapped?: boolean;
  /** Total number of untracked files */
  untrackedTotal?: number;
  /** Number of untracked files with diffs included */
  untrackedProcessed?: number;
}

/**
 * Fetch working tree changes and diff
 */
export async function fetchWorkingTree(
  projectId: string,
  filter: WorkingTreeFilter = 'all',
): Promise<WorkingTreeResponse> {
  const params = new URLSearchParams({ projectId, filter });
  const response = await fetch(`/api/git/working-tree?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch working tree');
  }
  return response.json();
}

/**
 * Fetch diff and changed files for a specific commit
 */
export async function fetchCommitDiff(
  projectId: string,
  sha: string,
): Promise<{ sha: string; diff: string; changedFiles: ChangedFile[] }> {
  const params = new URLSearchParams({ projectId });
  const response = await fetch(`/api/git/commit/${sha}?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch commit diff');
  }
  return response.json();
}

/**
 * Fetch active review for a project (or null if none)
 */
export async function fetchActiveReview(projectId: string): Promise<Review | null> {
  const params = new URLSearchParams({ projectId });
  const response = await fetch(`/api/reviews/active?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch active review');
  }
  const data = await response.json();
  return data.review;
}

/**
 * Close a review
 */
export async function closeReview(reviewId: string, version: number): Promise<Review> {
  const response = await fetch(`/api/reviews/${reviewId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) {
    throw new Error('Failed to close review');
  }
  return response.json();
}

// ============================================
// Comment Thread Grouping Functions
// ============================================

/**
 * A comment thread consisting of a root comment and its replies.
 */
export interface CommentThread {
  comment: ReviewComment;
  replies: ReviewComment[];
}

/**
 * A comment thread data structure for line-based grouping (DiffViewer).
 */
export interface CommentThreadData {
  root: ReviewComment;
  replies: ReviewComment[];
}

/**
 * Build a map of parentId → direct replies for efficient reply collection.
 * @param comments - Array of all comments
 * @returns Map where key is parentId and value is array of direct replies
 */
export function buildRepliesMap(comments: ReviewComment[]): Map<string, ReviewComment[]> {
  const repliesMap = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.parentId !== null) {
      const existing = repliesMap.get(comment.parentId);
      if (existing) {
        existing.push(comment);
      } else {
        repliesMap.set(comment.parentId, [comment]);
      }
    }
  }
  return repliesMap;
}

/**
 * Recursively collect all descendants of a comment (flattened, sorted by createdAt).
 * @param commentId - The comment ID to collect replies for
 * @param repliesMap - Pre-built map of parentId → direct replies
 * @returns Array of all descendant comments sorted by creation time
 */
export function collectReplies(
  commentId: string,
  repliesMap: Map<string, ReviewComment[]>,
): ReviewComment[] {
  const directReplies = repliesMap.get(commentId) || [];
  const allReplies: ReviewComment[] = [];
  for (const reply of directReplies) {
    allReplies.push(reply);
    allReplies.push(...collectReplies(reply.id, repliesMap));
  }
  // Sort by creation time to maintain chronological order
  return allReplies.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Group comments into threads by root comment ID.
 * Each thread contains a root comment (parentId === null) and all its nested replies.
 * @param comments - Array of all comments
 * @returns Map where key is root comment ID and value is array of replies (sorted by createdAt)
 */
export function groupCommentsIntoThreads(comments: ReviewComment[]): Map<string, ReviewComment[]> {
  const threads = new Map<string, ReviewComment[]>();
  const repliesMap = buildRepliesMap(comments);

  // Collect all root comments and their nested replies
  const rootComments = comments.filter((c) => c.parentId === null);
  rootComments.forEach((comment) => {
    const allReplies = collectReplies(comment.id, repliesMap);
    threads.set(comment.id, allReplies);
  });

  return threads;
}

/**
 * Group comments by line for inline display in diff viewer.
 * Only includes comments with lineStart !== null and parentId === null (root comments).
 * @param comments - Array of all comments
 * @returns Map where key is "${side}-${lineStart}" and value is array of CommentThreadData
 */
export function groupCommentsByLine(comments: ReviewComment[]): Map<string, CommentThreadData[]> {
  const repliesMap = buildRepliesMap(comments);

  // Group root comments by line, keeping each thread separate
  const grouped = new Map<string, CommentThreadData[]>();
  for (const comment of comments) {
    if (comment.lineStart !== null && comment.parentId === null) {
      // Use 'old'/'new' convention, default to 'new' if null
      const key = `${comment.side || 'new'}-${comment.lineStart}`;
      const thread: CommentThreadData = {
        root: comment,
        replies: collectReplies(comment.id, repliesMap),
      };
      const existing = grouped.get(key) || [];
      grouped.set(key, [...existing, thread]);
    }
  }

  // Sort threads within each line by root createdAt (oldest first)
  for (const [key, threads] of grouped) {
    threads.sort(
      (a, b) => new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime(),
    );
    grouped.set(key, threads);
  }

  return grouped;
}

// ============================================
// Comment Pending State Detection
// ============================================

/**
 * Determines if a root comment thread is "pending" (waiting for agent response).
 *
 * A root comment is pending if ALL of:
 * 1. It is a root comment (parentId === null)
 * 2. Status is 'open'
 * 3. Has targetAgents with at least one agent
 * 4. The latest user message is newer than the latest reply from any target agent
 *    (or no target agent has replied yet)
 *
 * This time/order-aware logic ensures pending state restores after user follow-ups.
 *
 * @param thread - The comment thread to check
 * @returns true if the comment is pending, false otherwise
 */
export function isPendingComment(thread: CommentThread): boolean {
  const { comment, replies } = thread;

  // Only root comments can be pending
  if (comment.parentId !== null) return false;

  // Must be open
  if (comment.status !== 'open') return false;

  // Must have targets
  const targetAgentIds = new Set(comment.targetAgents.map((t) => t.agentId));
  if (targetAgentIds.size === 0) return false;

  // Find the latest user message timestamp (root comment or any user reply)
  let latestUserMessageTime = comment.authorType === 'user' ? new Date(comment.createdAt) : null;
  for (const reply of replies) {
    if (reply.authorType === 'user') {
      const replyTime = new Date(reply.createdAt);
      if (!latestUserMessageTime || replyTime > latestUserMessageTime) {
        latestUserMessageTime = replyTime;
      }
    }
  }

  // If no user message in thread, not pending (edge case: agent-initiated thread)
  if (!latestUserMessageTime) return false;

  // Find the latest reply timestamp from any target agent
  let latestTargetAgentReplyTime: Date | null = null;
  for (const reply of replies) {
    if (
      reply.authorType === 'agent' &&
      reply.authorAgentId &&
      targetAgentIds.has(reply.authorAgentId)
    ) {
      const replyTime = new Date(reply.createdAt);
      if (!latestTargetAgentReplyTime || replyTime > latestTargetAgentReplyTime) {
        latestTargetAgentReplyTime = replyTime;
      }
    }
  }

  // Pending if no target agent has replied, or user's latest message is after their reply
  return !latestTargetAgentReplyTime || latestUserMessageTime > latestTargetAgentReplyTime;
}
