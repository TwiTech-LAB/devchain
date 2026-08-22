import type { EventEmitter2 } from '@nestjs/event-emitter';
import { z } from 'zod';

const promptStateIdentitySchema = z.object({
  sessionId: z.string().min(1),
  tmuxSessionName: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

const humanPromptActivatedSchema = promptStateIdentitySchema.extend({
  phase: z.literal('draft_active'),
});

const humanPromptSubmittedSchema = promptStateIdentitySchema.extend({
  phase: z.literal('awaiting_stable_idle'),
});

export const sessionHumanPromptStateChangedEvent = {
  name: 'session.human-prompt-state-changed',
  schema: z.discriminatedUnion('phase', [humanPromptActivatedSchema, humanPromptSubmittedSchema]),
} as const;

export type HumanPromptActivationBarrierPayload = z.infer<typeof humanPromptActivatedSchema>;
export type HumanPromptSubmitBarrierPayload = z.infer<typeof humanPromptSubmittedSchema>;
export type SessionHumanPromptStateChangedEventPayload = z.infer<
  typeof sessionHumanPromptStateChangedEvent.schema
>;

/**
 * Await every in-process state-change listener. Prompt activation uses this as a
 * correctness barrier so pool promotion settles before the terminal write proceeds.
 */
export async function emitHumanPromptStateChangedBarrier(
  eventEmitter: EventEmitter2,
  payload: SessionHumanPromptStateChangedEventPayload,
): Promise<void> {
  const parsed = sessionHumanPromptStateChangedEvent.schema.parse(payload);
  await eventEmitter.emitAsync(sessionHumanPromptStateChangedEvent.name, parsed);
}
