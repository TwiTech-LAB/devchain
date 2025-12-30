import { z } from 'zod';

export const sessionCrashedEvent = {
  name: 'session.crashed',
  schema: z.object({
    sessionId: z.string().min(1),
    sessionName: z.string().min(1),
  }),
} as const;

export type SessionCrashedEventPayload = z.infer<typeof sessionCrashedEvent.schema>;
