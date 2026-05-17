import { z } from 'zod';

export const sessionProviderSessionIdDiscoveredEvent = {
  name: 'session.providerSessionId.discovered',
  schema: z.object({
    sessionId: z.string().min(1),
    providerSessionId: z.string().min(1),
    providerName: z.string().min(1),
  }),
} as const;

export type SessionProviderSessionIdDiscoveredEventPayload = z.infer<
  typeof sessionProviderSessionIdDiscoveredEvent.schema
>;
