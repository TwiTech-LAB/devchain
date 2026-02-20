import { z } from 'zod';

export const claudeHooksSessionStartedEvent = {
  name: 'claude.hooks.session.started',
  schema: z.object({
    claudeSessionId: z.string().min(1),
    /** Session source: "startup" | "resume" | "clear" | "compact" */
    source: z.string().min(1),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    transcriptPath: z.string().min(1).optional(),
    tmuxSessionName: z.string().min(1),
    projectId: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    agentName: z.string().min(1).nullable().optional(),
    sessionId: z.string().uuid().nullable(),
  }),
} as const;

export type ClaudeHooksSessionStartedEventPayload = z.infer<
  typeof claudeHooksSessionStartedEvent.schema
>;
