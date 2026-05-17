import { z } from 'zod';

const actorSchema = z
  .object({
    type: z.enum(['agent', 'guest']),
    id: z.string().min(1),
  })
  .nullable()
  .optional();

export const epicDeletedEvent = {
  name: 'epic.deleted',
  schema: z.object({
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    parentId: z.string().min(1).nullable().optional(),
    actor: actorSchema,
  }),
} as const;

export type EpicDeletedEventPayload = z.infer<typeof epicDeletedEvent.schema>;
