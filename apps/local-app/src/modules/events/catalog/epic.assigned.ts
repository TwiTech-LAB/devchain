import { z } from 'zod';

/**
 * @deprecated Use `epic.updated` with `changes.agentId` instead.
 * This event is emitted for backward compatibility only and will be removed in a future release.
 * Migration: Subscribe to `epic.updated` and filter on `changes.agentId.current != null`.
 */
export const epicAssignedEvent = {
  name: 'epic.assigned',
  deprecated: true,
  deprecationMessage: 'epic.assigned is deprecated. Use epic.updated with changes.agentId instead.',
  schema: z.object({
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    previousAgentId: z.string().nullable().optional(),
    epicTitle: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
  }),
} as const;

export type EpicAssignedEventPayload = z.infer<typeof epicAssignedEvent.schema>;
