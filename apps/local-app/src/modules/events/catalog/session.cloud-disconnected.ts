import { z } from 'zod';

export const sessionCloudDisconnectedEvent = {
  name: 'session.cloud_disconnected',
  schema: z.object({
    userId: z.string().nullable(),
  }),
} as const;

export type SessionCloudDisconnectedEventPayload = z.infer<
  typeof sessionCloudDisconnectedEvent.schema
>;
