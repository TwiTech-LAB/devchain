import { z } from 'zod';

export const reviewCreatedEvent = {
  name: 'review.created',
  schema: z.discriminatedUnion('mode', [
    z.object({
      reviewId: z.string().uuid(),
      projectId: z.string().uuid(),
      epicId: z.string().uuid().nullable(),
      title: z.string().min(1),
      status: z.enum(['draft', 'pending', 'changes_requested', 'approved', 'closed']),
      mode: z.literal('commit'),
      baseRef: z.string().min(1),
      headRef: z.string().min(1),
      baseSha: z.string().min(1),
      headSha: z.string().min(1),
      createdBy: z.enum(['user', 'agent']),
      createdByAgentId: z.string().uuid().nullable(),
      // Resolved names for readability
      projectName: z.string().min(1).optional(),
    }),
    z.object({
      reviewId: z.string().uuid(),
      projectId: z.string().uuid(),
      epicId: z.string().uuid().nullable(),
      title: z.string().min(1),
      status: z.enum(['draft', 'pending', 'changes_requested', 'approved', 'closed']),
      mode: z.literal('working_tree'),
      baseRef: z.string().min(1),
      headRef: z.string().min(1),
      baseSha: z.null(),
      headSha: z.null(),
      createdBy: z.enum(['user', 'agent']),
      createdByAgentId: z.string().uuid().nullable(),
      // Resolved names for readability
      projectName: z.string().min(1).optional(),
    }),
  ]),
} as const;

export type ReviewCreatedEventPayload = z.infer<typeof reviewCreatedEvent.schema>;
