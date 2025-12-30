import { z } from 'zod';

export const sessionStoppedEvent = {
  name: 'session.stopped',
  schema: z.object({
    sessionId: z.string().min(1),
  }),
} as const;

export type SessionStoppedEventPayload = z.infer<typeof sessionStoppedEvent.schema>;
