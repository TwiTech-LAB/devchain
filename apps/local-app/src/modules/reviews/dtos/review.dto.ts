import { z } from 'zod';

// Review Status Enum
export const ReviewStatusSchema = z.enum([
  'draft',
  'pending',
  'changes_requested',
  'approved',
  'closed',
]);
export type ReviewStatusDto = z.infer<typeof ReviewStatusSchema>;

// Review Mode Enum
export const ReviewModeSchema = z.enum(['working_tree', 'commit']);
export type ReviewModeDto = z.infer<typeof ReviewModeSchema>;

// Comment Status Enum
export const CommentStatusSchema = z.enum(['open', 'resolved', 'wont_fix']);
export type CommentStatusDto = z.infer<typeof CommentStatusSchema>;

// Comment Type Enum
export const CommentTypeSchema = z.enum(['comment', 'suggestion', 'issue', 'approval']);
export type CommentTypeDto = z.infer<typeof CommentTypeSchema>;

// Author Type Enum
export const AuthorTypeSchema = z.enum(['user', 'agent']);
export type AuthorTypeDto = z.infer<typeof AuthorTypeSchema>;

// Diff Side Enum (API uses 'old'/'new' to match git convention, storage uses 'left'/'right')
export const DiffSideSchema = z.enum(['old', 'new']);
export type DiffSideDto = z.infer<typeof DiffSideSchema>;

/**
 * Map API side convention ('old'/'new') to storage convention ('left'/'right').
 * 'old' = base/left side, 'new' = head/right side in git diff terminology.
 */
export function mapSideToStorage(side: DiffSideDto | null): 'left' | 'right' | null {
  if (side === null) return null;
  return side === 'old' ? 'left' : 'right';
}

/**
 * Map storage side convention ('left'/'right') to API convention ('old'/'new').
 */
export function mapSideFromStorage(side: 'left' | 'right' | null): DiffSideDto | null {
  if (side === null) return null;
  return side === 'left' ? 'old' : 'new';
}

// ============================================
// Review DTOs
// ============================================

/**
 * Create Review DTO
 *
 * The API accepts refs (branch names, tags, or commit SHAs) and optionally pre-resolved SHAs.
 * For working_tree mode, baseSha/headSha are not used (changes are uncommitted).
 * For commit mode, baseSha/headSha are resolved from refs if not provided.
 *
 * @example
 * // Working tree mode (no SHAs needed)
 * { projectId: "...", title: "Pre-commit review", mode: "working_tree", baseRef: "HEAD", headRef: "HEAD" }
 *
 * @example
 * // Commit mode with refs only (service resolves to SHAs)
 * { projectId: "...", title: "My Review", mode: "commit", baseRef: "main", headRef: "feature/new-stuff" }
 *
 * @example
 * // Commit mode with pre-resolved SHAs (skips resolution)
 * { projectId: "...", title: "My Review", mode: "commit", baseRef: "main", headRef: "feature/new-stuff",
 *   baseSha: "abc123...", headSha: "def456..." }
 */
export const CreateReviewSchema = z.object({
  projectId: z.string().uuid(),
  epicId: z.string().uuid().nullable().optional(),
  title: z.string().min(1, 'Title is required'),
  description: z.string().nullable().optional(),
  status: ReviewStatusSchema.optional().default('draft'),
  /** Review mode - 'working_tree' for uncommitted changes, 'commit' for specific commits */
  mode: ReviewModeSchema.optional().default('working_tree'),
  /** Base ref - branch name, tag, or commit SHA */
  baseRef: z.string().min(1, 'Base ref is required'),
  /** Head ref - branch name, tag, or commit SHA */
  headRef: z.string().min(1, 'Head ref is required'),
  /** Pre-resolved base SHA. Only used for commit mode. */
  baseSha: z.string().min(1).nullable().optional(),
  /** Pre-resolved head SHA. Only used for commit mode. */
  headSha: z.string().min(1).nullable().optional(),
  createdBy: AuthorTypeSchema.optional().default('user'),
  createdByAgentId: z.string().uuid().nullable().optional(),
});
export type CreateReviewDto = z.infer<typeof CreateReviewSchema>;

export const UpdateReviewSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: ReviewStatusSchema.optional(),
  headSha: z.string().min(1).optional(),
  version: z.number().int().positive('Version must be a positive integer'),
});
export type UpdateReviewDto = z.infer<typeof UpdateReviewSchema>;

export const ListReviewsQuerySchema = z.object({
  projectId: z.string().uuid(),
  status: ReviewStatusSchema.optional(),
  epicId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().optional().default(100),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});
export type ListReviewsQueryDto = z.infer<typeof ListReviewsQuerySchema>;

// ============================================
// Comment DTOs
// ============================================

export const CreateCommentSchema = z.object({
  filePath: z.string().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  lineStart: z.number().int().positive().nullable().optional(),
  lineEnd: z.number().int().positive().nullable().optional(),
  side: DiffSideSchema.nullable().optional(),
  content: z.string().min(1, 'Content is required'),
  commentType: CommentTypeSchema.optional().default('comment'),
  status: CommentStatusSchema.optional().default('open'),
  authorType: AuthorTypeSchema.optional().default('user'),
  authorAgentId: z.string().uuid().nullable().optional(),
  targetAgentIds: z.array(z.string().uuid()).optional(),
});
export type CreateCommentDto = z.infer<typeof CreateCommentSchema>;

export const UpdateCommentSchema = z.object({
  content: z.string().min(1).optional(),
  status: CommentStatusSchema.optional(),
  version: z.number().int().positive('Version must be a positive integer'),
});
export type UpdateCommentDto = z.infer<typeof UpdateCommentSchema>;

export const ResolveCommentSchema = z.object({
  status: z.enum(['resolved', 'wont_fix']),
  version: z.number().int().positive('Version must be a positive integer'),
});
export type ResolveCommentDto = z.infer<typeof ResolveCommentSchema>;

export const ListCommentsQuerySchema = z.object({
  status: CommentStatusSchema.optional(),
  filePath: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  limit: z.coerce.number().int().positive().optional().default(100),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});
export type ListCommentsQueryDto = z.infer<typeof ListCommentsQuerySchema>;

// ============================================
// Active Review & Close DTOs
// ============================================

export const ActiveReviewQuerySchema = z.object({
  projectId: z.string().uuid(),
});
export type ActiveReviewQueryDto = z.infer<typeof ActiveReviewQuerySchema>;

export const CloseReviewSchema = z.object({
  version: z.number().int().positive('Version must be a positive integer'),
});
export type CloseReviewDto = z.infer<typeof CloseReviewSchema>;
