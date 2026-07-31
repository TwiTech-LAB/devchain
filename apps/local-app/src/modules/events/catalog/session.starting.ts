import { z } from 'zod';

/**
 * Emitted immediately BEFORE the launch pipeline types the provider command into tmux —
 * the moment DevChain commits to starting the agent, not the moment it finishes.
 *
 * `session.started` is deliberately not a substitute: it publishes only after the CLI has
 * produced output and the pipeline has waited out its minimum launch delay, so it lands
 * several seconds after the agent is visibly running. Anything that needs to react as the
 * session begins (rather than record that it did) should listen here instead.
 *
 * This is an intent, not an outcome. A launch can still fail after it and roll back, so
 * treat it as "starting", never as proof a session exists.
 */
export const sessionStartingEvent = {
  name: 'session.starting',
  schema: z.object({
    sessionId: z.string().min(1),
    projectId: z.string().min(1),
    agentId: z.string().min(1),
  }),
} as const;

export type SessionStartingEventPayload = z.infer<typeof sessionStartingEvent.schema>;
