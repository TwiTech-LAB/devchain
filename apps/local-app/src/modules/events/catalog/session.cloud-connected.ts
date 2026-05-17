import { z } from 'zod';

export const sessionCloudConnectedEvent = {
  name: 'session.cloud_connected',
  schema: z.object({
    userId: z.string().min(1),
  }),
} as const;

export type SessionCloudConnectedEventPayload = z.infer<typeof sessionCloudConnectedEvent.schema>;
