import { z } from 'zod';

export const reviewCommentDeletedEvent = {
  name: 'review.comment.deleted',
  schema: z.object({
    commentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    projectId: z.string().uuid(),
    filePath: z.string().nullable(),
    parentId: z.string().uuid().nullable(),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    reviewTitle: z.string().min(1).optional(),
  }),
} as const;

export type ReviewCommentDeletedEventPayload = z.infer<typeof reviewCommentDeletedEvent.schema>;
