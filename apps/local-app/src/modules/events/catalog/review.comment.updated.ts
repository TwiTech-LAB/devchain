import { z } from 'zod';

export const reviewCommentUpdatedEvent = {
  name: 'review.comment.updated',
  schema: z.object({
    commentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    projectId: z.string().uuid(),
    content: z.string().min(1),
    previousContent: z.string().min(1),
    version: z.number().int().positive(),
    editedAt: z.string().datetime().nullable(),
    filePath: z.string().nullable(),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    reviewTitle: z.string().min(1).optional(),
  }),
} as const;

export type ReviewCommentUpdatedEventPayload = z.infer<typeof reviewCommentUpdatedEvent.schema>;
