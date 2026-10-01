import { z } from 'zod';

/** A home binding row was created, changed state or cursor, or was deleted (`state: 'deleted'`). */
export const remoteBindingChangedEvent = {
  name: 'remote.binding.changed',
  schema: z
    .object({
      projectId: z.string().min(1),
      remoteId: z.string().min(1),
      state: z.enum(['attaching', 'remote', 'detaching', 'failed', 'deleted']),
      hostCursor: z.string().min(1).nullable(),
      /** Last live-sync apply error; null while the mirror is healthy. */
      syncError: z.string().nullable(),
    })
    .strict(),
} as const;

export type RemoteBindingChangedEventPayload = z.infer<typeof remoteBindingChangedEvent.schema>;
