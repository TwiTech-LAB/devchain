import { z } from 'zod';

export const sessionTranscriptDiscoveredEvent = {
  name: 'session.transcript.discovered',
  schema: z.object({
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    projectId: z.string().min(1),
    transcriptPath: z.string().min(1),
    providerName: z.string().min(1),
  }),
} as const;

export type SessionTranscriptDiscoveredEventPayload = z.infer<
  typeof sessionTranscriptDiscoveredEvent.schema
>;
