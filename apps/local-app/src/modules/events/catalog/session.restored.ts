import { z } from 'zod';

export const sessionRestoredEvent = {
  name: 'session.restored',
  schema: z.object({
    sessionId: z.string().min(1),
    epicId: z.string().min(1).nullable(),
    agentId: z.string().min(1),
    tmuxSessionName: z.string().min(1),
  }),
} as const;

export type SessionRestoredEventPayload = z.infer<typeof sessionRestoredEvent.schema>;
