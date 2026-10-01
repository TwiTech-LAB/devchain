import { z } from 'zod';

export const sessionStoppedSourceSchema = z.enum([
  'web-api',
  'mobile-rpc',
  'subscriber',
  'team-management',
  'remote-operation',
]);

export const sessionStoppedReasonSchema = z.enum(['user-requested', 'restart', 'agent-deletion']);

export type SessionStoppedSource = z.infer<typeof sessionStoppedSourceSchema>;
export type SessionStoppedReason = z.infer<typeof sessionStoppedReasonSchema>;

export type SessionTerminationContext = {
  readonly source: SessionStoppedSource;
  readonly reason: SessionStoppedReason;
};

export const sessionStoppedEvent = {
  name: 'session.stopped',
  schema: z.object({
    sessionId: z.string().min(1),
    source: sessionStoppedSourceSchema,
    reason: sessionStoppedReasonSchema,
  }),
} as const;

export type SessionStoppedEventPayload = z.infer<typeof sessionStoppedEvent.schema>;
