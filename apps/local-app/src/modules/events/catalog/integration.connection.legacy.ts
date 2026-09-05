import { z } from 'zod';

const providerSchema = z.enum(['clickup', 'jira']);

export const legacyIntegrationConnectionCreatedEventSchema = z
  .object({
    connectionId: z.string().min(1),
    provider: providerSchema,
    generation: z.number().int().positive(),
    subtaskSyncEnabled: z.boolean(),
    syncSettingRevision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const legacyIntegrationConnectionUpdatedEventSchema = z
  .object({
    connectionId: z.string().min(1),
    provider: providerSchema,
    previousGeneration: z.number().int().positive(),
    generation: z.number().int().positive(),
    previousSubtaskSyncEnabled: z.boolean(),
    subtaskSyncEnabled: z.boolean(),
    previousSyncSettingRevision: z.number().int().positive(),
    syncSettingRevision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const legacyIntegrationConnectionDeletedEventSchema = z
  .object({
    connectionId: z.string().min(1),
    provider: providerSchema,
    generation: z.number().int().positive(),
    subtaskSyncEnabled: z.boolean(),
    syncSettingRevision: z.number().int().positive(),
    deletedAt: z.string().datetime(),
  })
  .strict();

export type LegacyIntegrationConnectionCreatedEventPayload = z.infer<
  typeof legacyIntegrationConnectionCreatedEventSchema
>;
export type LegacyIntegrationConnectionUpdatedEventPayload = z.infer<
  typeof legacyIntegrationConnectionUpdatedEventSchema
>;
export type LegacyIntegrationConnectionDeletedEventPayload = z.infer<
  typeof legacyIntegrationConnectionDeletedEventSchema
>;
