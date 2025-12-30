import { z } from 'zod';

/**
 * WebSocket multiplexed envelope schema
 * {topic, type, payload, ts}
 */
export const WsEnvelopeSchema = z.object({
  topic: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.string().datetime(),
});

export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

/**
 * Terminal frame payload schemas
 */
export const TerminalDataPayloadSchema = z.object({
  data: z.string(),
  sequence: z.number().optional(),
});

export const TerminalSeedPayloadSchema = z.object({
  data: z.string(),
  chunk: z.number(),
  totalChunks: z.number(),
  // Viewport-only mode metadata (optional)
  totalLines: z.number().optional(), // Total lines in server buffer
  viewportStart: z.number().optional(), // Where viewport starts in global buffer
  hasHistory: z.boolean().optional(), // Whether server has history before viewport
  // Terminal dimensions from tmux pane
  cols: z.number().optional(), // Terminal columns
  rows: z.number().optional(), // Terminal rows
});

export const TerminalResizePayloadSchema = z.object({
  rows: z.number(),
  cols: z.number(),
});

/**
 * Full history response payload (sent on scroll-up history request)
 */
export const FullHistoryPayloadSchema = z.object({
  history: z.string(),
  cursorX: z.number().optional(),
  cursorY: z.number().optional(),
  hasHistory: z.boolean().optional(), // More history available beyond what was sent
  capturedSequence: z.number().optional(), // Sequence at capture time for deduplication
});

export type TerminalDataPayload = z.infer<typeof TerminalDataPayloadSchema>;
export type TerminalSeedPayload = z.infer<typeof TerminalSeedPayloadSchema>;
export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>;
export type FullHistoryPayload = z.infer<typeof FullHistoryPayloadSchema>;

/**
 * Session lifecycle payloads
 */
export const SessionStatePayloadSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['started', 'ended', 'crashed', 'timeout']),
  message: z.string().optional(),
});

export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;

/**
 * Reconnection payload
 */
export const ReconnectPayloadSchema = z.object({
  lastSequence: z.number().optional(),
  sessionId: z.string(),
});

export type ReconnectPayload = z.infer<typeof ReconnectPayloadSchema>;

/**
 * Heartbeat payloads
 */
export const HeartbeatPayloadSchema = z.object({
  timestamp: z.string().datetime(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/**
 * Helper to create envelope
 */
export function createEnvelope(topic: string, type: string, payload: unknown): WsEnvelope {
  return {
    topic,
    type,
    payload,
    ts: new Date().toISOString(),
  };
}
