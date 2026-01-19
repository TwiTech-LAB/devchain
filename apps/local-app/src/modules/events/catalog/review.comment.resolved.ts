import { z } from 'zod';

export const reviewCommentResolvedEvent = {
  name: 'review.comment.resolved',
  schema: z.object({
    commentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    projectId: z.string().uuid(),
    status: z.enum(['resolved', 'wont_fix']),
    version: z.number().int().positive(),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    reviewTitle: z.string().min(1).optional(),
  }),
} as const;

export type ReviewCommentResolvedEventPayload = z.infer<typeof reviewCommentResolvedEvent.schema>;
