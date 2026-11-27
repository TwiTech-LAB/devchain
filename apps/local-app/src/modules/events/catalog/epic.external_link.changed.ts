import { z } from 'zod';

/**
 * An ordinary external task link was set on or cleared from an epic. A
 * durable wake-up: managed subtask sync reconciles the epic's direct children
 * from the current stored links, never from this payload.
 */
export const epicExternalLinkChangedEvent = {
  name: 'epic.external_link.changed',
  schema: z
    .object({
      epicId: z.string().min(1),
      projectId: z.string().min(1),
      linkId: z.string().min(1),
      change: z.enum(['set', 'clear']),
    })
    .strict(),
} as const;

export type EpicExternalLinkChangedEventPayload = z.infer<
  typeof epicExternalLinkChangedEvent.schema
>;
