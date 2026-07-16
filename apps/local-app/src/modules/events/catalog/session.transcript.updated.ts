import { z } from 'zod';

const sourceChangeKindSchema = z.enum([
  'cache-hit',
  'same-file-append',
  'file-replacement',
  'file-truncation',
  'same-file-rewrite',
  'db-update',
  'unknown-full-parse',
]);

const sessionTranscriptUpdatedBaseSchema = z.object({
  sessionId: z.string().min(1),
  transcriptPath: z.string().min(1),
});

export const sessionTranscriptUpdatedEvent = {
  name: 'session.transcript.updated',
  schema: z.discriminatedUnion('kind', [
    sessionTranscriptUpdatedBaseSchema
      .extend({
        kind: z.literal('delta'),
        newMessageCount: z.number().int().nonnegative(),
        metrics: z.object({
          totalTokens: z.number().int().nonnegative(),
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          costUsd: z.number().nonnegative(),
          messageCount: z.number().int().nonnegative(),
        }),
        cursor: z.string().min(1),
        prevCursor: z.string().min(1),
        replaceFromChunkIndex: z.number().int().nonnegative(),
        newChunkIds: z.array(z.string()),
        totalChunkCount: z.number().int().nonnegative(),
        deltaChunks: z.array(z.unknown()),
        deltaMessages: z.array(z.unknown()),
      })
      .strict(),
    sessionTranscriptUpdatedBaseSchema
      .extend({
        kind: z.literal('full-refetch-required'),
        sourceChangeKind: sourceChangeKindSchema,
      })
      .strict(),
  ]),
} as const;

export type SessionTranscriptUpdatedEventPayload = z.infer<
  typeof sessionTranscriptUpdatedEvent.schema
>;
