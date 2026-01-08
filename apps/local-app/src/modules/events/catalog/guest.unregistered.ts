import { z } from 'zod';

export const guestUnregisteredEvent = {
  name: 'guest.unregistered',
  schema: z.object({
    guestId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    tmuxSessionId: z.string().min(1),
    reason: z.enum(['tmux_session_died', 'manual']),
  }),
} as const;

export type GuestUnregisteredEventPayload = z.infer<typeof guestUnregisteredEvent.schema>;
