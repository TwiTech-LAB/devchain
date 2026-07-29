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

export const TerminalSeedPayloadSchema = z
  .object({
    data: z.string(),
    chunk: z.number(),
    totalChunks: z.number(),
    // Viewport-only mode metadata (optional)
    totalLines: z.number().optional(), // Total lines in server buffer
    viewportStart: z.number().optional(), // Where viewport starts in global buffer
    // Per-snapshot omitted-content metadata: older primary-buffer content exists BEFORE the
    // delivered seed viewport (line providers set it only after truncation). This is NOT the
    // refresh capability — that is the `subscribed` ack's immutable `historyRefreshable`.
    // Conflating the two lets a non-truncated seed suppress every later scroll-up refresh.
    hasHistory: z.boolean().optional(),
    // Terminal dimensions from tmux pane
    cols: z.number().optional(), // Terminal columns
    rows: z.number().optional(), // Terminal rows
    cursorX: z.number().optional(),
    cursorY: z.number().optional(),
    // Recovery-seed watermark. `sequenceEpoch` scopes the replay numbers (which server
    // sequence-domain they belong to); `recoveryEpoch` scopes one recovery attempt within that
    // domain; `capturedSequence` is the domain-local sequence sampled after tmux capture. A
    // late chunk/callback from an old domain is rejected because its `sequenceEpoch` no longer
    // matches the live buffer.
    sequenceEpoch: z.string().min(1).optional(),
    recoveryEpoch: z.number().int().nonnegative().optional(),
    capturedSequence: z.number().int().nonnegative().optional(),
  })
  .superRefine((payload, context) => {
    const present = [payload.sequenceEpoch, payload.recoveryEpoch, payload.capturedSequence].filter(
      (value) => value !== undefined,
    ).length;
    if (present !== 0 && present !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sequenceEpoch, recoveryEpoch, and capturedSequence must be provided together',
      });
    }
  });

/**
 * Non-writing completion for a successful-but-empty initial capture. Distinct from a
 * `seed_ansi` chunk: it carries no data and must NOT reset xterm or clear live rows. It
 * pins `capturedSequence` (a valid baseline, including 0) so later live frames apply on
 * top of the empty seed instead of being replayed. Emitted through the same targeted
 * seed guards as `seed_ansi`.
 */
export const TerminalSeedEmptyPayloadSchema = z
  .object({
    capturedSequence: z.number().int().nonnegative(),
    cols: z.number().optional(),
    rows: z.number().optional(),
  })
  .strict();

export const TerminalResizePayloadSchema = z.object({
  rows: z.number(),
  cols: z.number(),
});

export const TerminalPromptPasteInputSchema = z
  .object({
    kind: z.literal('prompt-paste'),
    sessionId: z.string().min(1),
    requestId: z.string().uuid(),
    data: z.string(),
  })
  .strict();

export type TerminalPromptPasteInput = z.infer<typeof TerminalPromptPasteInputSchema>;

export const TerminalPromptPasteFailureCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNKNOWN_SESSION',
  'NOT_SUBSCRIBER',
  'NOT_AUTHORITY',
  'TMUX_UNAVAILABLE',
  'DELIVERY_ERROR',
  'REQUEST_CONFLICT',
  'BUSY',
]);

export type TerminalPromptPasteFailureCode = z.infer<typeof TerminalPromptPasteFailureCodeSchema>;

export const TerminalPromptPasteAckSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      code: z.literal('OK'),
      requestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: TerminalPromptPasteFailureCodeSchema,
      requestId: z.string(),
    })
    .strict(),
]);

export type TerminalPromptPasteAck = z.infer<typeof TerminalPromptPasteAckSchema>;

/**
 * Full history request payload (scroll-up history request).
 *
 * `correlationId` lets recovery invalidate a late response: the client stamps each
 * request and the server echoes it on `full_history`, so a response that arrives after
 * the request it belongs to was superseded can be dropped by the client.
 */
export const FullHistoryRequestPayloadSchema = z.object({
  sessionId: z.string().min(1),
  maxLines: z.number().optional(),
  correlationId: z.string().optional(),
});

/**
 * Full history response payload (sent on scroll-up history request)
 */
export const FullHistoryPayloadSchema = z.object({
  history: z.string(),
  cursorX: z.number().optional(),
  cursorY: z.number().optional(),
  // Per-snapshot has-more: THIS response was truncated by `terminal.seeding.maxBytes`, so older
  // content was omitted from it. Snapshot metadata only — never the refresh capability, which the
  // `subscribed` ack's `historyRefreshable` owns.
  hasHistory: z.boolean().optional(),
  capturedSequence: z.number().optional(), // Sequence at capture time for deduplication
  // The server sequence-domain this snapshot belongs to. The client compares it against the
  // domain it currently holds so a fresh domain's lower `capturedSequence` is accepted instead
  // of suppressed against a stale higher baseline. The server omits the response entirely if the
  // domain changes during capture, so a delivered response always carries the domain it captured.
  sequenceEpoch: z.string().min(1).optional(),
  correlationId: z.string().optional(), // Echoed request token; lets recovery drop late responses
});

/**
 * Subscribed acknowledgement payload (first frame the client receives per attach).
 *
 * `historyRefreshable` is the immutable, provider-derived refresh capability: whether a
 * fresh tmux-backed history snapshot can ever be loaded for this session. It is NOT
 * per-snapshot has-more (that stays on `seed`/`full_history` as `hasHistory`) — a client
 * must not conflate the two, or a non-truncated seed would suppress every later refresh.
 */
export const SubscribedPayloadSchema = z.object({
  sessionId: z.string(),
  currentSequence: z.number(),
  // The opaque, restart-unique sequence-domain this `currentSequence` belongs to. It is always
  // present and emitted before any replay/live frame in the domain, so the client can pair every
  // subsequent cursor with it and detect a server-side domain reset (a lower `currentSequence`
  // under a new epoch is a fresh domain, not stale/rewound output).
  sequenceEpoch: z.string().min(1),
  replayStatus: z.enum(['seed', 'covered', 'gap']),
  historyRefreshable: z.boolean(),
});

export type TerminalDataPayload = z.infer<typeof TerminalDataPayloadSchema>;
export type TerminalSeedPayload = z.infer<typeof TerminalSeedPayloadSchema>;
export type TerminalSeedEmptyPayload = z.infer<typeof TerminalSeedEmptyPayloadSchema>;
export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>;
export type FullHistoryRequestPayload = z.infer<typeof FullHistoryRequestPayloadSchema>;
export type FullHistoryPayload = z.infer<typeof FullHistoryPayloadSchema>;
export type SubscribedPayload = z.infer<typeof SubscribedPayloadSchema>;

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

export const TerminalResyncRequestPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    reason: z.literal('client_write_overflow'),
  })
  .strict();

export type TerminalResyncRequestPayload = z.infer<typeof TerminalResyncRequestPayloadSchema>;

export const TerminalResyncAbortPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    // The sequence-domain the recovery attempt belongs to. The gateway rejects an abort whose
    // (sequenceEpoch, recoveryEpoch) pair does not match the live recovery, so an old-domain abort
    // cannot cancel a recovery that now belongs to a fresh domain. Optional on the wire for
    // backward compatibility; the server-side pair check is where it is required.
    sequenceEpoch: z.string().min(1).optional(),
    recoveryEpoch: z.number().int().nonnegative(),
  })
  .strict();

export type TerminalResyncAbortPayload = z.infer<typeof TerminalResyncAbortPayloadSchema>;

export const TerminalResyncCompletePayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    // See `TerminalResyncAbortPayloadSchema.sequenceEpoch`: the gateway requires the
    // (sequenceEpoch, recoveryEpoch, capturedSequence) triple to match the live recovery, so an
    // old-domain completion cannot finalize recovery in a new domain.
    sequenceEpoch: z.string().min(1).optional(),
    recoveryEpoch: z.number().int().nonnegative(),
    capturedSequence: z.number().int().nonnegative(),
  })
  .strict();

export type TerminalResyncCompletePayload = z.infer<typeof TerminalResyncCompletePayloadSchema>;

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
