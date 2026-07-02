import { z } from 'zod';

export const claudeHooksSessionStartedEvent = {
  // Provider-neutral despite the legacy `claude.` name (kept to avoid churning the
  // 0005 renew-instructions seeder + event-fields catalog — see provider-standards.md).
  // Claude and Copilot both publish here; `providerName` discriminates.
  name: 'claude.hooks.session.started',
  schema: z.object({
    /**
     * Provider-native session id. For Claude this is the Claude Code session id;
     * for Copilot the relay sets `providerSessionId` and the publisher mirrors it
     * here (so existing Claude subscribers keep a non-empty id).
     */
    claudeSessionId: z.string().min(1),
    /** Provider that produced the hook. Absent ⇒ `claude` (legacy relay). */
    providerName: z.string().min(1).optional(),
    /** Provider-native session id (e.g. Copilot's `session_id`) — explicit successor to `claudeSessionId`. */
    providerSessionId: z.string().min(1).optional(),
    /** Session source. Claude: "startup"|"resume"|"clear"|"compact". Copilot: "new"|"resume"|"startup". */
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
