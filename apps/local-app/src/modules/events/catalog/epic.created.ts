import { z } from 'zod';

export const epicCreatedEvent = {
  name: 'epic.created',
  schema: z.object({
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    statusId: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable().optional(),
    parentId: z.string().min(1).nullable().optional(),
    // Resolved names for readability
    projectName: z.string().min(1).optional(),
    statusName: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    parentTitle: z.string().min(1).optional(),
  }),
} as const;

export type EpicCreatedEventPayload = z.infer<typeof epicCreatedEvent.schema>;
