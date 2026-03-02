import { z } from 'zod';

export const sessionTranscriptUpdatedEvent = {
  name: 'session.transcript.updated',
  schema: z.object({
    sessionId: z.string().min(1),
    transcriptPath: z.string().min(1),
    newMessageCount: z.number().int().nonnegative(),
    metrics: z.object({
      totalTokens: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      messageCount: z.number().int().nonnegative(),
    }),
  }),
} as const;

export type SessionTranscriptUpdatedEventPayload = z.infer<
  typeof sessionTranscriptUpdatedEvent.schema
>;
