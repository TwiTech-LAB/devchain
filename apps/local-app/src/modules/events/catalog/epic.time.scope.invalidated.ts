import { z } from 'zod';

export const epicTimeScopeInvalidatedEvent = {
  name: 'epic.time.scope.invalidated',
  schema: z
    .object({
      workspaceId: z.string().uuid(),
      /** Set when an external link row changed: clients then also refresh link views. */
      externalLinks: z.literal(true).optional(),
    })
    .strict(),
} as const;

export type EpicTimeScopeInvalidatedEventPayload = z.infer<
  typeof epicTimeScopeInvalidatedEvent.schema
>;
