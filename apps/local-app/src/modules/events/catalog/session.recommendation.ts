import { z } from 'zod';

export const sessionRecommendationEvent = {
  name: 'session.recommendation',
  schema: z.object({
    reason: z.string().min(1),
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    providerId: z.string().min(1),
    providerName: z.string().min(1),
    silent: z.boolean(),
    bootId: z.string().min(1),
  }),
} as const;

export type SessionRecommendationEventPayload = z.infer<typeof sessionRecommendationEvent.schema>;
