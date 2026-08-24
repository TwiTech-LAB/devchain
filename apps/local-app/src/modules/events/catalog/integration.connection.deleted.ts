import { z } from 'zod';

export const integrationConnectionDeletedEvent = {
  name: 'integration.connection.deleted',
  schema: z.object({
    connectionId: z.string().min(1),
    provider: z.enum(['clickup', 'jira']),
    generation: z.number().int().positive(),
    subtaskSyncEnabled: z.boolean(),
    syncSettingRevision: z.number().int().positive(),
    deletedAt: z.string().datetime(),
  }),
} as const;

export type IntegrationConnectionDeletedEventPayload = z.infer<
  typeof integrationConnectionDeletedEvent.schema
>;
