import { z } from 'zod';

export const ScheduledEpicErrorCodeSchema = z.enum([
  'CRON_INVALID',
  'TIMEZONE_INVALID',
  'TEMPLATE_RENDER_FAILED',
  'EPIC_CREATE_FAILED',
  'DUPLICATE_CLAIM',
  'STALE_RUNNING_RECOVERED',
  'SCHEDULE_DISABLED',
  'UNKNOWN',
]);

export const scheduledEpicExecutedEvent = {
  name: 'scheduled_epic.executed',
  schema: z.object({
    // Schedule / run identity
    scheduleId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    scheduleName: z.string().min(1),
    triggerSource: z.enum(['scheduler', 'manual']),

    // Run outcome
    status: z.enum(['completed', 'failed', 'skipped']),
    plannedFor: z.string().min(1),
    finishedAt: z.string().min(1),
    lagMs: z.number().nullable(),

    // Created epic (null on failure or skip)
    createdEpicId: z.string().nullable(),
    createdEpicTitle: z.string().nullable(),

    // Error info (null on success)
    errorCode: ScheduledEpicErrorCodeSchema.nullable(),
    errorMessage: z.string().nullable(),
  }),
} as const;

export type ScheduledEpicExecutedEventPayload = z.infer<typeof scheduledEpicExecutedEvent.schema>;
export type ScheduledEpicErrorCode = z.infer<typeof ScheduledEpicErrorCodeSchema>;
