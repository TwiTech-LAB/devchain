import { z } from 'zod';

export const guestRegisteredEvent = {
  name: 'guest.registered',
  schema: z.object({
    guestId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    tmuxSessionId: z.string().min(1),
    isSandbox: z.boolean(),
  }),
} as const;

export type GuestRegisteredEventPayload = z.infer<typeof guestRegisteredEvent.schema>;
