import { z } from 'zod';

/** A usage snapshot of this machine changed. The client refetches the usage of its project. */
export const providerUsageUpdatedEvent = {
  name: 'provider-usage.updated',
  schema: z
    .object({
      accountKey: z.string().min(1),
    })
    .strict(),
} as const;

export type ProviderUsageUpdatedEventPayload = z.infer<typeof providerUsageUpdatedEvent.schema>;
