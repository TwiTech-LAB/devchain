import { z } from 'zod';

export const epicTimeScopeInvalidatedEvent = {
  name: 'epic.time.scope.invalidated',
  schema: z
    .object({
      workspaceId: z.string().uuid(),
    })
    .strict(),
} as const;

export type EpicTimeScopeInvalidatedEventPayload = z.infer<
  typeof epicTimeScopeInvalidatedEvent.schema
>;
