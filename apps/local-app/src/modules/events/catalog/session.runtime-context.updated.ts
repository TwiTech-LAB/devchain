import { z } from 'zod';

export const sessionRuntimeContextUpdatedEvent = {
  name: 'session.runtime-context.updated',
  schema: z
    .object({
      sessionId: z.string().min(1),
    })
    .strict(),
} as const;

export type SessionRuntimeContextUpdatedEventPayload = z.infer<
  typeof sessionRuntimeContextUpdatedEvent.schema
>;
