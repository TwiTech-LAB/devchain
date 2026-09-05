import { z } from 'zod';

export const epicRelationsInvalidatedEvent = {
  name: 'epic.relations.invalidated',
  schema: z
    .object({
      workspaceId: z.string().uuid(),
    })
    .strict(),
} as const;

export type EpicRelationsInvalidatedEventPayload = z.infer<
  typeof epicRelationsInvalidatedEvent.schema
>;
