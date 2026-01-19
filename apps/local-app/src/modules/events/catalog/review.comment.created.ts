import { z } from 'zod';

export const reviewCommentCreatedEvent = {
  name: 'review.comment.created',
  schema: z.object({
    commentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    projectId: z.string().uuid(),
    content: z.string().min(1),
    commentType: z.enum(['comment', 'suggestion', 'issue', 'approval']),
    status: z.enum(['open', 'resolved', 'wont_fix']),
    authorType: z.enum(['user', 'agent']),
    authorAgentId: z.string().uuid().nullable(),
    filePath: z.string().nullable(),
    lineStart: z.number().int().positive().nullable(),
    lineEnd: z.number().int().positive().nullable(),
    parentId: z.string().uuid().nullable(),
    targetAgentIds: z.array(z.string().uuid()).optional(),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    reviewTitle: z.string().min(1).optional(),
    // Review context for agents to locate the code
    reviewMode: z.enum(['working_tree', 'commit']).optional(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    baseSha: z.string().nullable().optional(),
    headSha: z.string().nullable().optional(),
  }),
} as const;

export type ReviewCommentCreatedEventPayload = z.infer<typeof reviewCommentCreatedEvent.schema>;
