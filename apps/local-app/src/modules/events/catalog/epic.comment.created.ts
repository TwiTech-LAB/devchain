import { z } from 'zod';

// Actor schema: who triggered this event (null if unknown/system)
const actorSchema = z
  .object({
    type: z.enum(['agent', 'guest']),
    id: z.string().min(1),
  })
  .nullable()
  .optional();

export const epicCommentCreatedEvent = {
  name: 'epic.comment.created',
  schema: z.object({
    commentId: z.string().min(1),
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    authorName: z.string().min(1),
    content: z.string().min(1),
    actor: actorSchema,
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    epicTitle: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    recipientIds: z.array(z.string().min(1)).optional(),
  }),
} as const;

export type EpicCommentCreatedEventPayload = z.infer<typeof epicCommentCreatedEvent.schema>;
