import { z } from 'zod';

export const sessionPresenceChangedEvent = {
  name: 'session.presence.changed',
  schema: z.object({
    agentId: z.string().min(1),
    online: z.boolean(),
    sessionId: z.string().min(1).nullable(),
  }),
} as const;

export type SessionPresenceChangedEventPayload = z.infer<typeof sessionPresenceChangedEvent.schema>;
