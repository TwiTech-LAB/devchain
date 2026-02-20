import { z } from 'zod';

/**
 * Incoming hook event payload from the relay script.
 * The relay script augments Claude Code's hook JSON with env-derived fields.
 *
 * `hookEventName` determines which internal event to publish.
 * Currently only "SessionStart" is handled.
 */
export const HookEventSchema = z
  .object({
    /** Claude Code hook event name (e.g. "SessionStart") */
    hookEventName: z.string().min(1),

    // --- Fields provided by Claude Code hook JSON ---
    /** Claude Code session ID */
    claudeSessionId: z.string().min(1),
    /** Claude Code session source — how the session was initiated. Known values: "startup" (fresh session), "resume" (resumed from prior), "clear" (context cleared), "compact" (context compacted). */
    source: z.string().min(1),
    /** Model name (varies across Claude Code versions) */
    model: z.string().max(200).optional(),
    /** Permission mode (e.g. "default", "plan") */
    permissionMode: z.string().max(100).optional(),
    /** Transcript file path */
    transcriptPath: z.string().max(1000).optional(),

    // --- Fields injected by the relay script from DEVCHAIN_* env vars ---
    /** tmux session name where Claude is running */
    tmuxSessionName: z.string().min(1),
    /** DevChain project UUID */
    projectId: z.string().uuid(),
    /** DevChain agent UUID (nullable if not associated) */
    agentId: z.string().uuid().nullable(),
    /** DevChain session UUID (nullable — may not exist yet at hook time) */
    sessionId: z.string().uuid().nullable(),
  })
  .strict();

export type HookEventData = z.infer<typeof HookEventSchema>;

/**
 * Response shape returned to the relay script.
 * Extensible — future enrichments add fields to `data`.
 */
export interface HookEventResponse {
  ok: boolean;
  handled: boolean;
  data: Record<string, unknown>;
}
