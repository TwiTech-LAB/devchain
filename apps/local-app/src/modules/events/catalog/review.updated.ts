import { z } from 'zod';

export const reviewUpdatedEvent = {
  name: 'review.updated',
  schema: z.object({
    reviewId: z.string().uuid(),
    projectId: z.string().uuid(),
    version: z.number().int().positive(),
    title: z.string().min(1),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    changes: z.object({
      title: z
        .object({
          previous: z.string(),
          current: z.string(),
        })
        .optional(),
      status: z
        .object({
          previous: z.enum(['draft', 'pending', 'changes_requested', 'approved', 'closed']),
          current: z.enum(['draft', 'pending', 'changes_requested', 'approved', 'closed']),
        })
        .optional(),
      headSha: z
        .object({
          previous: z.string().nullable(),
          current: z.string().nullable(),
        })
        .optional(),
    }),
  }),
} as const;

export type ReviewUpdatedEventPayload = z.infer<typeof reviewUpdatedEvent.schema>;
