import { z } from 'zod';

export const sessionStartedEvent = {
  name: 'session.started',
  schema: z.object({
    sessionId: z.string().min(1),
    epicId: z.string().min(1).nullable(),
    agentId: z.string().min(1),
    tmuxSessionName: z.string().min(1),
  }),
} as const;

export type SessionStartedEventPayload = z.infer<typeof sessionStartedEvent.schema>;
