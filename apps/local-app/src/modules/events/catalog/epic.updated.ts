import { z } from 'zod';

// Change tracking schemas for individual fields
const titleChangeSchema = z.object({
  previous: z.string(),
  current: z.string(),
});

const statusIdChangeSchema = z.object({
  previous: z.string().nullable(),
  current: z.string().nullable(),
  previousName: z.string().optional(),
  currentName: z.string().optional(),
});

const agentIdChangeSchema = z.object({
  previous: z.string().nullable(),
  current: z.string().nullable(),
  previousName: z.string().optional(),
  currentName: z.string().optional(),
});

const parentIdChangeSchema = z.object({
  previous: z.string().nullable(),
  current: z.string().nullable(),
  previousTitle: z.string().optional(),
  currentTitle: z.string().optional(),
});

export const epicUpdatedEvent = {
  name: 'epic.updated',
  schema: z.object({
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    version: z.number().int().positive(),
    epicTitle: z.string().min(1),
    projectName: z.string().min(1).optional(),
    changes: z.object({
      title: titleChangeSchema.optional(),
      statusId: statusIdChangeSchema.optional(),
      agentId: agentIdChangeSchema.optional(),
      parentId: parentIdChangeSchema.optional(),
    }),
  }),
} as const;

export type EpicUpdatedEventPayload = z.infer<typeof epicUpdatedEvent.schema>;
