import { z } from 'zod';

/**
 * Incoming hook event payload from a provider relay script.
 * The relay augments the provider's hook JSON with env-derived fields.
 *
 * `hookEventName` is the discriminator. Four variants are accepted:
 *  - `SessionStart`  — session lifecycle start; requires `source`. Claude + Copilot.
 *  - `Stop`          — agent finished a turn (Copilot `agentStop`); carries
 *                      `transcriptPath` + `stopReason` for downstream metrics.
 *  - `PreToolUse`    — matched to `AskUserQuestion`; carries the pending questions.
 *  - `PostToolUse`   — matched to `AskUserQuestion`; reconciliation (resolved).
 *
 * Each variant is `.strict()`: unknown keys are rejected. The Claude ingestion
 * contract is byte-for-byte backward compatible — `claudeSessionId` is still
 * required on the Claude-only tool variants (`PreToolUse`/`PostToolUse`), and the
 * provider-neutral fields below are additive (absent ⇒ legacy Claude relay).
 */

/**
 * Fields injected by the relay from DEVCHAIN_* env vars, shared by all variants.
 * Session identity is provider-neutral: legacy Claude relays send `claudeSessionId`
 * (added per-variant below); provider-neutral relays (Copilot) send `providerSessionId`.
 */
const baseInjectedFields = {
  /** Provider that produced this hook (absent ⇒ `claude`, the legacy relay). */
  providerName: z.string().min(1).optional(),
  /** Provider-native session id (e.g. Copilot's `session_id`) — successor to `claudeSessionId`. */
  providerSessionId: z.string().min(1).optional(),
  /** tmux session name where the provider CLI is running */
  tmuxSessionName: z.string().min(1),
  /** DevChain project UUID */
  projectId: z.string().uuid(),
  /** DevChain agent UUID (nullable if not associated) */
  agentId: z.string().uuid().nullable(),
  /** DevChain session UUID (nullable — may not exist yet at hook time) */
  sessionId: z.string().uuid().nullable(),
} as const;

/**
 * `claudeSessionId` required — kept on the Claude-only tool variants so the
 * existing AskUserQuestion ingestion + pending-store path is byte-for-byte unchanged.
 */
const claudeSessionIdRequired = { claudeSessionId: z.string().min(1) } as const;

/**
 * `claudeSessionId` optional — on the cross-provider lifecycle variants
 * (`SessionStart`/`Stop`). Copilot omits it and sends `providerSessionId` instead;
 * Claude still always sends it, so existing Claude payloads validate unchanged.
 */
const claudeSessionIdOptional = { claudeSessionId: z.string().min(1).optional() } as const;

/** Optional Claude-provided metadata shared by all variants. */
const claudeMetaFields = {
  /** Model name (varies across Claude Code versions) */
  model: z.string().max(200).optional(),
  /** Permission mode (e.g. "default", "plan") */
  permissionMode: z.string().max(100).optional(),
  /** Transcript file path */
  transcriptPath: z.string().max(1000).optional(),
} as const;

export const SessionStartHookSchema = z
  .object({
    hookEventName: z.literal('SessionStart'),
    /**
     * Session source — how the session was initiated.
     * Claude: "startup" | "resume" | "clear" | "compact". Copilot: "new" | "resume" | "startup".
     */
    source: z.string().min(1),
    ...claudeMetaFields,
    ...claudeSessionIdOptional,
    ...baseInjectedFields,
  })
  .strict();

export const StopHookSchema = z
  .object({
    hookEventName: z.literal('Stop'),
    /** Why the turn ended (e.g. Copilot "end_turn"). Optional — providers may omit it. */
    stopReason: z.string().min(1).optional(),
    ...claudeMetaFields,
    ...claudeSessionIdOptional,
    ...baseInjectedFields,
  })
  .strict();

export const PreToolUseHookSchema = z
  .object({
    hookEventName: z.literal('PreToolUse'),
    /** Tool about to run (relay matcher restricts this to "AskUserQuestion"). */
    toolName: z.string().min(1),
    /** Raw tool input object — forwarded with --argjson so the questions OBJECT is preserved. */
    toolInput: z.record(z.unknown()),
    /** Claude tool-use id correlating Pre/Post for the same call. */
    toolUseId: z.string().min(1),
    ...claudeMetaFields,
    ...claudeSessionIdRequired,
    ...baseInjectedFields,
  })
  .strict();

export const PostToolUseHookSchema = z
  .object({
    hookEventName: z.literal('PostToolUse'),
    toolName: z.string().min(1),
    toolInput: z.record(z.unknown()),
    toolUseId: z.string().min(1),
    /** Tool response — string or object; relay size-caps large values. */
    toolResponse: z.union([z.string(), z.record(z.unknown())]).optional(),
    ...claudeMetaFields,
    ...claudeSessionIdRequired,
    ...baseInjectedFields,
  })
  .strict();

export const HookEventSchema = z.discriminatedUnion('hookEventName', [
  SessionStartHookSchema,
  StopHookSchema,
  PreToolUseHookSchema,
  PostToolUseHookSchema,
]);

export type SessionStartHookEvent = z.infer<typeof SessionStartHookSchema>;
export type StopHookEvent = z.infer<typeof StopHookSchema>;
export type PreToolUseHookEvent = z.infer<typeof PreToolUseHookSchema>;
export type PostToolUseHookEvent = z.infer<typeof PostToolUseHookSchema>;
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
