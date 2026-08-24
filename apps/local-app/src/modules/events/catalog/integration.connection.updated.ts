import { z } from 'zod';

export const integrationConnectionUpdatedEvent = {
  name: 'integration.connection.updated',
  schema: z.object({
    connectionId: z.string().min(1),
    provider: z.enum(['clickup', 'jira']),
    previousGeneration: z.number().int().positive(),
    generation: z.number().int().positive(),
    previousSubtaskSyncEnabled: z.boolean(),
    subtaskSyncEnabled: z.boolean(),
    previousSyncSettingRevision: z.number().int().positive(),
    syncSettingRevision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
} as const;

export type IntegrationConnectionUpdatedEventPayload = z.infer<
  typeof integrationConnectionUpdatedEvent.schema
>;
