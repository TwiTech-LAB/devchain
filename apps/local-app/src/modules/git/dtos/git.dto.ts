import { z } from 'zod';

// ============================================
// Git Query DTOs
// ============================================

export const ListCommitsQuerySchema = z.object({
  projectId: z.string().uuid(),
  ref: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional().default(50),
});
export type ListCommitsQueryDto = z.infer<typeof ListCommitsQuerySchema>;

export const ListBranchesQuerySchema = z.object({
  projectId: z.string().uuid(),
});
export type ListBranchesQueryDto = z.infer<typeof ListBranchesQuerySchema>;

export const ListTagsQuerySchema = z.object({
  projectId: z.string().uuid(),
});
export type ListTagsQueryDto = z.infer<typeof ListTagsQuerySchema>;

export const GetDiffQuerySchema = z.object({
  projectId: z.string().uuid(),
  base: z.string().min(1, 'Base ref is required'),
  head: z.string().min(1, 'Head ref is required'),
});
export type GetDiffQueryDto = z.infer<typeof GetDiffQuerySchema>;

export const GetChangedFilesQuerySchema = z.object({
  projectId: z.string().uuid(),
  base: z.string().min(1, 'Base ref is required'),
  head: z.string().min(1, 'Head ref is required'),
});
export type GetChangedFilesQueryDto = z.infer<typeof GetChangedFilesQuerySchema>;

export const WorkingTreeQuerySchema = z.object({
  projectId: z.string().uuid(),
  filter: z.enum(['all', 'staged', 'unstaged']).optional().default('all'),
});
export type WorkingTreeQueryDto = z.infer<typeof WorkingTreeQuerySchema>;

export const GetCommitQuerySchema = z.object({
  projectId: z.string().uuid(),
});
export type GetCommitQueryDto = z.infer<typeof GetCommitQuerySchema>;

export const CommitShaParamSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{4,40}$/i, 'Invalid commit SHA format'),
});
export type CommitShaParamDto = z.infer<typeof CommitShaParamSchema>;
