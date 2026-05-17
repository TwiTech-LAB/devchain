import { z } from 'zod';

export const sessionActivityChangedEvent = {
  name: 'session.activity.changed',
  schema: z.object({
    sessionId: z.string().min(1),
    state: z.enum(['busy', 'idle']),
    lastActivityAt: z.string().nullable(),
    busySince: z.string().nullable(),
  }),
} as const;

export type SessionActivityChangedEventPayload = z.infer<typeof sessionActivityChangedEvent.schema>;
