import { z } from 'zod';

export const WsEnvelopeSchema = z.object({
  topic: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.string().datetime(),
});

export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

export function createEnvelope(topic: string, type: string, payload: unknown): WsEnvelope {
  return {
    topic,
    type,
    payload,
    ts: new Date().toISOString(),
  };
}
