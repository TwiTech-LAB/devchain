import { z } from 'zod';

export const sessionTranscriptEndedEvent = {
  name: 'session.transcript.ended',
  schema: z.object({
    sessionId: z.string().min(1),
    transcriptPath: z.string().min(1),
    finalMetrics: z.object({
      totalTokens: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      messageCount: z.number().int().nonnegative(),
    }),
    endReason: z.enum(['session.stopped', 'session.crashed', 'watcher.closed', 'file.deleted']),
  }),
} as const;

export type SessionTranscriptEndedEventPayload = z.infer<typeof sessionTranscriptEndedEvent.schema>;
