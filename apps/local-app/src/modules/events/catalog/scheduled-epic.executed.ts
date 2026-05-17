import { z } from 'zod';

export const scheduledEpicExecutedEvent = {
  name: 'scheduled_epic.executed',
  schema: z.object({
    scheduledEpicId: z.string().min(1),
    epicId: z.string().min(1),
    projectId: z.string().min(1),
    templateTitle: z.string().min(1),
    occurrenceCount: z.number().int().min(0),
  }),
} as const;

export type ScheduledEpicExecutedEventPayload = z.infer<typeof scheduledEpicExecutedEvent.schema>;
