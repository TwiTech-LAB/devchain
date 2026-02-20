import { z } from 'zod';
import {
  isValidGitBranchName,
  isValidWorktreeName,
  MAX_WORKTREE_NAME_LENGTH,
} from '../worktree-validation';

export const WorktreeStatusSchema = z.enum([
  'creating',
  'running',
  'stopped',
  'completed',
  'merged',
  'error',
]);

export const WorktreeRuntimeTypeSchema = z.enum(['container', 'process']);

export const CreateWorktreeSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(MAX_WORKTREE_NAME_LENGTH)
    .refine((value) => isValidWorktreeName(value), {
      message:
        'Name must be 1-63 chars of lowercase letters, numbers, and hyphens; no leading/trailing hyphen',
    }),
  branchName: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => isValidGitBranchName(value), {
      message: 'Invalid branch name',
    }),
  baseBranch: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => isValidGitBranchName(value), {
      message: 'Invalid base branch name',
    })
    .default('main'),
  templateSlug: z.string().min(1).max(255),
  ownerProjectId: z.string().min(1),
  description: z.string().max(5000).optional(),
  repoPath: z.string().min(1).optional(),
  runtimeType: WorktreeRuntimeTypeSchema.optional(),
  presetName: z.string().min(1).optional(),
});

export const WorktreeListQuerySchema = z.object({
  ownerProjectId: z.string().min(1).optional(),
});

export const WorktreeLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(5000).default(200),
});

export const DeleteWorktreeQuerySchema = z.object({
  deleteBranch: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});

export type CreateWorktreeDto = z.infer<typeof CreateWorktreeSchema>;
export type WorktreeLogsQueryDto = z.infer<typeof WorktreeLogsQuerySchema>;
export type DeleteWorktreeQueryDto = z.infer<typeof DeleteWorktreeQuerySchema>;
export type WorktreeListQueryDto = z.infer<typeof WorktreeListQuerySchema>;

export interface WorktreeResponseDto {
  id: string;
  name: string;
  branchName: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  containerId: string | null;
  containerPort: number | null;
  templateSlug: string;
  ownerProjectId: string;
  status: z.infer<typeof WorktreeStatusSchema> | string;
  description: string | null;
  devchainProjectId: string | null;
  mergeCommit: string | null;
  mergeConflicts: string | null;
  errorMessage: string | null;
  commitsAhead: number | null;
  commitsBehind: number | null;
  runtimeType: z.infer<typeof WorktreeRuntimeTypeSchema> | string;
  processId: number | null;
  runtimeToken: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeOverviewDto {
  worktree: WorktreeResponseDto;
  epics: {
    total: number | null;
    done: number | null;
  };
  agents: {
    total: number | null;
  };
  fetchedAt: string;
}

export interface WorktreeMergeConflictDto {
  file: string;
  type: 'merge' | 'rebase' | 'uncommitted';
}

export interface WorktreeMergePreviewDto {
  canMerge: boolean;
  commitsAhead: number;
  commitsBehind: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  conflicts: WorktreeMergeConflictDto[];
}
