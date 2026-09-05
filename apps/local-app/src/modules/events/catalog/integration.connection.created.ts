import { z } from 'zod';

export const integrationConnectionCreatedEvent = {
  name: 'integration.connection.created',
  schema: z
    .object({
      connectionId: z.string().min(1),
      projectId: z.string().min(1),
      provider: z.enum(['clickup', 'jira']),
      generation: z.number().int().positive(),
      subtaskSyncEnabled: z.boolean(),
      syncSettingRevision: z.number().int().positive(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    })
    .strict(),
} as const;

export type IntegrationConnectionCreatedEventPayload = z.infer<
  typeof integrationConnectionCreatedEvent.schema
>;
