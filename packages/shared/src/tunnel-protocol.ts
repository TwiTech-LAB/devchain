// Tunnel wire protocol — single source of truth shared between the local-app
// (tunnel client) and the devchain-bridge (tunnel server).
//
// The bridge is compiled to CommonJS. On the former Node <22.12 floor it could not
// rely on synchronously `require()`-ing an ESM-only package, so a runtime import was
// unsafe; the supported Node >=24 floor no longer has that compatibility constraint.
// The bridge still consumes this module as **types only** (`import type … from
// '@devchain/shared'`, fully erased at emit), while the local-app and this package's
// tests use the runtime guards/consts. Keeping the *shape* defined exactly once here
// prevents the two sides from drifting.

// Type-only import (fully erased at emit) so this module carries NO runtime cross-file `.js`
// specifier — the bridge's ts-jest compiles tunnel-protocol.ts directly and does not rewrite
// ESM `.js` imports to `.ts` (same constraint negotiation.ts follows). The runtime envelope
// shape check below is therefore inlined rather than importing `isE2eeEnvelope`.
import type { E2eeEnvelope } from './e2ee/envelope.js';

/**
 * Tunnel protocol versions negotiated during the attest handshake.
 * - `'1'` — JSON-RPC relay only (legacy; already deployed in the field).
 * - `'2'` — JSON-RPC relay **plus** server→client push frames.
 *
 * The bridge MUST keep accepting `'1'` during rollout so already-deployed v1
 * local-apps don't lose relay RPC. No lockstep deploy.
 */
export type TunnelProtocolVersion = '1' | '2';

/** Highest protocol version this contract describes (push-capable). */
export const TUNNEL_PROTOCOL_VERSION_PUSH: TunnelProtocolVersion = '2';

/** Every protocol version the bridge must continue to accept during rollout. */
export const SUPPORTED_TUNNEL_PROTOCOL_VERSIONS: readonly TunnelProtocolVersion[] = ['1', '2'];

/**
 * Discriminator for the server→client push frame. Distinct from JSON-RPC response
 * frames, which are correlated by a top-level `id`. A push frame NEVER carries an
 * RPC `id` and must never resolve/reject an inflight RPC entry.
 */
export const TUNNEL_PUSH_FRAME_TYPE = 'push';

/** Schema version of the push frame envelope (the inner `v` field). */
export const TUNNEL_PUSH_FRAME_VERSION = 2;

/**
 * Server→client push frame carried over the EXISTING tunnel WebSocket.
 *
 * The inner broadcast subtype is `eventType` (NOT `type`) on purpose: a second
 * `type` key would collide with the `type:'push'` frame discriminator and produce
 * an ambiguous/duplicate JSON key. The payload follows the projection contract in
 * the local-app `broadcast-registry`.
 *
 * `eventId` is **bridge-assigned**: the local-app sends a {@link TunnelPushEnvelope}
 * (no id), and the bridge stamps a monotonic id during SSE fan-out (sub-epic 4).
 */
export interface TunnelPushFrame<TPayload = unknown> {
  type: typeof TUNNEL_PUSH_FRAME_TYPE;
  v: typeof TUNNEL_PUSH_FRAME_VERSION;
  /** Fan-out topic, e.g. `session/<id>/transcript` (from the broadcast registry). */
  topic: string;
  /** Inner broadcast discriminator (the registry's `type`). */
  eventType: string;
  /** Bridge-assigned monotonic id; absent on the wire from the local-app. */
  eventId?: string | null;
  payload: TPayload;
}

/**
 * The frame the local-app puts on the wire — identical to {@link TunnelPushFrame}
 * but without `eventId`, which the bridge stamps on receipt.
 */
export type TunnelPushEnvelope<TPayload = unknown> = Omit<TunnelPushFrame<TPayload>, 'eventId'>;

/** Runtime check that a negotiated protocol version is one the bridge supports. */
export function isSupportedTunnelProtocolVersion(value: unknown): value is TunnelProtocolVersion {
  return value === '1' || value === '2';
}

/** True when `value` (v2 tunnels) is push-capable. */
export function isPushCapableTunnelProtocolVersion(value: unknown): value is '2' {
  return value === '2';
}

/**
 * Structural guard over untrusted, already-parsed JSON. Validates only the envelope
 * shape (not `eventId`, which the bridge assigns). Returns `false` — never throws —
 * for malformed frames so callers can drop them safely.
 */
export function isTunnelPushFrame(value: unknown): value is TunnelPushFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === TUNNEL_PUSH_FRAME_TYPE &&
    frame.v === TUNNEL_PUSH_FRAME_VERSION &&
    typeof frame.topic === 'string' &&
    frame.topic.length > 0 &&
    typeof frame.eventType === 'string' &&
    frame.eventType.length > 0 &&
    'payload' in frame
  );
}

/**
 * One topic↔eventType rule in the Phase-2 mobile-chat push allowlist.
 *
 * `segments` is the topic split on `/`, where the literal `:id` marks a variable
 * instance/session/agent id segment (any non-empty value matches). Membership is
 * therefore matched by segment SHAPE, never by raw string equality.
 */
export interface MobilePushTopicRule {
  readonly segments: readonly string[];
  readonly eventTypes: readonly string[];
}

/** Sentinel marking a variable id segment in a {@link MobilePushTopicRule}. */
export const MOBILE_PUSH_TOPIC_ID_SEGMENT = ':id';

/**
 * Canonical allowlist of the Phase-2 mobile-chat push topic↔eventType pairs the
 * bridge receiver accepts onto the per-instance SSE firehose.
 *
 * This MIRRORS the mobile-chat subset of the local-app `broadcast-registry` (the
 * producer / source of truth): `session.transcript.updated`, the two AskUserQuestion
 * hooks, `session.presence.changed`, `session.activity.changed`, plus the Phase-1 /
 * Task-3 additions `agent.created`/`agent.deleted` (RC4 — agent list add/remove) and
 * `chat.message.created` (RC3 — thread/group chat, forwarded for completeness; no
 * mobile consumer is wired yet). The bridge cannot runtime-import this ESM-only
 * package, so it re-implements {@link isAllowlistedTunnelPushTopic} locally; a sync
 * test in the local-app drives the real registry through this allowlist so the two
 * cannot drift without turning a test red.
 */
export const MOBILE_PUSH_TOPIC_ALLOWLIST: readonly MobilePushTopicRule[] = [
  // session.transcript.updated → `session/<id>/transcript` + `updated`
  { segments: ['session', MOBILE_PUSH_TOPIC_ID_SEGMENT, 'transcript'], eventTypes: ['updated'] },
  // claude.hooks.ask_user_question.pending|resolved → `session/<id>` + `ask_user_question.*`;
  // session.activity.changed → `session/<id>` + `activity` (same topic shape, one more eventType).
  {
    segments: ['session', MOBILE_PUSH_TOPIC_ID_SEGMENT],
    eventTypes: ['ask_user_question.pending', 'ask_user_question.resolved', 'activity'],
  },
  // session.presence.changed → `agent/<id>` + `presence`
  { segments: ['agent', MOBILE_PUSH_TOPIC_ID_SEGMENT], eventTypes: ['presence'] },
  // agent.created/deleted (RC4) → `project/<id>/state` + `agent.created`/`agent.deleted`.
  // Drives the mobile chat-list live add/remove (catch-up = reload()).
  {
    segments: ['project', MOBILE_PUSH_TOPIC_ID_SEGMENT, 'state'],
    eventTypes: ['agent.created', 'agent.deleted'],
  },
  // chat.message.created (RC3) → `chat/<id>` + `message.created`. Thread/group-chat
  // messages — forwarded + allowlisted for completeness, but NO mobile consumer is
  // wired in Phase 1 (single-agent open-chat rides `session.transcript.updated`).
  // The topic is admitted so a future thread surface can ride the same firehose; it
  // is NOT consumed today, which is acceptable for a low-cadence lifecycle topic but
  // would need a re-review if thread chat becomes high-frequency.
  { segments: ['chat', MOBILE_PUSH_TOPIC_ID_SEGMENT], eventTypes: ['message.created'] },
];

/**
 * True when `(topic, eventType)` is a recognized Phase-2 mobile-chat push pair.
 *
 * The bridge receiver MUST reject any `type:'push'` frame for which this returns
 * `false` BEFORE dispatching to the SSE fan-out, so a syntactically-valid but
 * unknown/forged topic can never ride the per-instance firehose. Never throws.
 */
export function isAllowlistedTunnelPushTopic(topic: unknown, eventType: unknown): boolean {
  if (typeof topic !== 'string' || typeof eventType !== 'string') return false;
  const seg = topic.split('/');
  for (const rule of MOBILE_PUSH_TOPIC_ALLOWLIST) {
    if (rule.segments.length !== seg.length) continue;
    const shapeMatches = rule.segments.every((tmpl, i) =>
      tmpl === MOBILE_PUSH_TOPIC_ID_SEGMENT ? seg[i].length > 0 : tmpl === seg[i],
    );
    if (shapeMatches) return rule.eventTypes.includes(eventType);
  }
  return false;
}

/**
 * Discriminator for a tunnel CONTROL frame — a request/response carried on the same
 * WebSocket as RPC and push, but a THIRD distinct kind. Unlike the JSON-RPC relay
 * (mobile→bridge→local-app) and push (local-app→bridge), control frames are a
 * reverse-direction local-app→bridge query + bridge→local-app reply. They carry a
 * correlation `id` that MUST stay isolated from the RPC inflight map on both sides
 * (route by `type:'ctrl'` BEFORE any `id`-based RPC correlation), mirroring how the
 * push frame is discriminated before the RPC `id` check.
 */
export const TUNNEL_CONTROL_FRAME_TYPE = 'ctrl';

/** Schema version of the control frame envelope. */
export const TUNNEL_CONTROL_FRAME_VERSION = 1;

/** Control operations understood by both ends. */
export type TunnelControlOp = 'sse_liveness_query' | 'sse_liveness_result';

/**
 * local-app→bridge: "is my mobile SSE stream live right now?" The bridge derives
 * `{userId,instanceId}` from the tunnel connection itself — no params needed beyond
 * the correlation `id`.
 */
export interface TunnelLivenessQueryFrame {
  type: typeof TUNNEL_CONTROL_FRAME_TYPE;
  v: typeof TUNNEL_CONTROL_FRAME_VERSION;
  ctrl: 'sse_liveness_query';
  /** Correlation id (local-app-generated) echoed back on the result. */
  id: string;
}

/**
 * bridge→local-app: the liveness answer for the querying tunnel's `{userId,instanceId}`,
 * computed from the SSE liveness map within the bridge's grace window.
 */
export interface TunnelLivenessResultFrame {
  type: typeof TUNNEL_CONTROL_FRAME_TYPE;
  v: typeof TUNNEL_CONTROL_FRAME_VERSION;
  ctrl: 'sse_liveness_result';
  id: string;
  /** True when a mobile SSE connection was seen within the bridge grace window. */
  live: boolean;
  /** Epoch-ms of the last SSE heartbeat/connect, or `null` if not currently live. */
  lastSeenAt: number | null;
}

export type TunnelControlFrame = TunnelLivenessQueryFrame | TunnelLivenessResultFrame;

/** True for any structurally-valid `type:'ctrl'` envelope. Never throws. */
export function isTunnelControlFrame(value: unknown): value is TunnelControlFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === TUNNEL_CONTROL_FRAME_TYPE &&
    frame.v === TUNNEL_CONTROL_FRAME_VERSION &&
    (frame.ctrl === 'sse_liveness_query' || frame.ctrl === 'sse_liveness_result') &&
    typeof frame.id === 'string' &&
    frame.id.length > 0
  );
}

/** Narrow guard for the local-app→bridge liveness query. */
export function isTunnelLivenessQueryFrame(value: unknown): value is TunnelLivenessQueryFrame {
  return isTunnelControlFrame(value) && value.ctrl === 'sse_liveness_query';
}

/** Narrow guard for the bridge→local-app liveness result. */
export function isTunnelLivenessResultFrame(value: unknown): value is TunnelLivenessResultFrame {
  return (
    isTunnelControlFrame(value) &&
    value.ctrl === 'sse_liveness_result' &&
    typeof (value as TunnelLivenessResultFrame).live === 'boolean'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Live viewport (MobileLiveViewport) — single source of truth for the read-only
// tmux screen stream: local-app→bridge tunnel frame + the session-scoped mobile
// SSE event the bridge re-emits. Consumed by local-app (streamer), bridge (relay
// + SSE endpoint), and mobile (viewport sheet).
//
// Rendering model is SERVER-RENDERED SCREEN STATE: `lines` are ALREADY-RENDERED
// rows carrying ANSI/SGR markup (from tmux `capture-pane -e`); there is no
// terminal emulator on the wire and no raw-byte forwarding. The full-screen body
// is the recovery anchor — there is no diff-replay: on a `seq` gap the consumer
// resubscribes/reconnects and the next `full` re-anchors it.
//
// IMPORTANT: a viewport frame is a SEPARATE LANE from the push firehose. It is its
// own `type:'viewport'` discriminator (sibling to `'push'`/`'ctrl'`) and is NOT a
// push topic — it must never be added to MOBILE_PUSH_TOPIC_ALLOWLIST nor ride the
// per-instance SSE firehose. It travels only over a push-capable (v2) tunnel; see
// {@link isPushCapableTunnelProtocolVersion}.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Discriminator for the local-app→bridge live-viewport frame. A THIRD sibling to
 * `type:'push'` and `type:'ctrl'`; route by `type` BEFORE any `id`-based RPC
 * correlation, exactly like push/ctrl. A viewport frame NEVER carries an RPC `id`.
 */
export const TUNNEL_VIEWPORT_FRAME_TYPE = 'viewport';

/** Schema version of the viewport frame envelope (the inner `v` field). */
export const TUNNEL_VIEWPORT_FRAME_VERSION = 1;

/** Cursor position within the rendered screen grid (0-based column/row). */
export interface ViewportCursor {
  x: number;
  y: number;
}

/**
 * A full rendered screen snapshot — the recovery anchor sent on every (re)connect.
 * `lines` are already-rendered rows bearing ANSI/SGR markup (NOT raw bytes, NOT an
 * emulator model). `cols`/`rows` are the pane geometry that produced them.
 */
export interface ViewportScreen {
  lines: string[];
  cursor: ViewportCursor;
  cols: number;
  rows: number;
}

/** A single changed row in a diff body — full SGR-bearing replacement text for `row`. */
export interface ViewportChangedLine {
  row: number;
  text: string;
}

/** Full-screen body: the recovery anchor. Carries the entire screen state. */
export interface ViewportFullBody {
  kind: 'full';
  screen: ViewportScreen;
}

/**
 * Incremental body: only the rows that changed since the previous `seq`. `cursor`/
 * `cols`/`rows` are present only when they changed (typically absent in v1, which has
 * no mobile resize). There is no diff-replay — a `full` always re-anchors state.
 */
export interface ViewportDiffBody {
  kind: 'diff';
  changedLines: ViewportChangedLine[];
  cursor?: ViewportCursor;
  cols?: number;
  rows?: number;
}

/**
 * Encrypted full-frame body (Phase 4 — E2EE viewport lane). The full {@link ViewportScreen}
 * (the sensitive terminal content) is SEALED into an {@link E2eeEnvelope}; only the `kind`
 * discriminator stays cleartext so the bridge can route/buffer the latest opaque full frame
 * (`{instanceId, sessionId, seq, frameKind}`) WITHOUT reading screen content.
 *
 * v1 is FULL-FRAME-ONLY for encrypted viewport — there is no encrypted `diff` (the existing
 * "fresh full on every (re)connect, next full re-anchors" model makes dropping bridge-side
 * diff folding low-cost). The mobile opens `enc` back into a {@link ViewportScreen} and the
 * AAD binds `lane:'viewport'` + `routeKey:sessionId` + the frame `seq`.
 */
export interface ViewportEncryptedFullBody {
  kind: 'enc-full';
  /** The sealed {@link ViewportScreen}. */
  enc: E2eeEnvelope;
}

/**
 * Discriminated viewport payload: a plaintext `full` recovery anchor, an incremental `diff`,
 * or an `enc-full` (the whole screen sealed; v1 encrypted viewport is full-frame-only).
 */
export type ViewportBody = ViewportFullBody | ViewportDiffBody | ViewportEncryptedFullBody;

/**
 * local-app→bridge live-viewport frame carried over the EXISTING (v2) tunnel WebSocket.
 *
 * `subscriptionId` correlates the frame to a `terminal.viewport.subscribe` lease so a
 * single tunnel can multiplex several viewport subscriptions. `seq` is a per-subscription
 * MONOTONIC counter assigned at the source (local-app) for gap detection; the bridge
 * forwards it unchanged. `sessionId` scopes the frame to one tmux session — the bridge's
 * session-scoped SSE endpoint fans it out (see {@link MobileViewportSseEvent}).
 */
export interface TunnelViewportFrame {
  type: typeof TUNNEL_VIEWPORT_FRAME_TYPE;
  v: typeof TUNNEL_VIEWPORT_FRAME_VERSION;
  subscriptionId: string;
  sessionId: string;
  seq: number;
  body: ViewportBody;
}

/**
 * Structural guard over untrusted, already-parsed JSON. Validates the envelope and the
 * discriminated body shape; returns `false` — never throws — for malformed frames.
 */
export function isTunnelViewportFrame(value: unknown): value is TunnelViewportFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === TUNNEL_VIEWPORT_FRAME_TYPE &&
    frame.v === TUNNEL_VIEWPORT_FRAME_VERSION &&
    typeof frame.subscriptionId === 'string' &&
    frame.subscriptionId.length > 0 &&
    typeof frame.sessionId === 'string' &&
    frame.sessionId.length > 0 &&
    typeof frame.seq === 'number' &&
    Number.isInteger(frame.seq) &&
    frame.seq >= 0 &&
    isViewportBody(frame.body)
  );
}

/** True for a structurally-valid `full` or `diff` viewport body. Never throws. */
export function isViewportBody(value: unknown): value is ViewportBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  if (body.kind === 'full') {
    const screen = body.screen as Record<string, unknown> | undefined;
    return (
      typeof screen === 'object' &&
      screen !== null &&
      Array.isArray(screen.lines) &&
      screen.lines.every((l) => typeof l === 'string') &&
      isViewportCursor(screen.cursor) &&
      typeof screen.cols === 'number' &&
      typeof screen.rows === 'number'
    );
  }
  if (body.kind === 'diff') {
    return (
      Array.isArray(body.changedLines) &&
      body.changedLines.every(
        (l) =>
          typeof l === 'object' &&
          l !== null &&
          typeof (l as Record<string, unknown>).row === 'number' &&
          typeof (l as Record<string, unknown>).text === 'string',
      ) &&
      (body.cursor === undefined || isViewportCursor(body.cursor)) &&
      (body.cols === undefined || typeof body.cols === 'number') &&
      (body.rows === undefined || typeof body.rows === 'number')
    );
  }
  // Encrypted full frame: validate ONLY the envelope shape — the screen content is opaque
  // ciphertext and is never inspected/folded (that is the whole point of the encrypted lane).
  // Inlined (not `isE2eeEnvelope` from ./e2ee) to keep this module free of runtime cross-file
  // imports; the checked shape MUST stay in sync with `isE2eeEnvelope` in ./e2ee/envelope.ts.
  if (body.kind === 'enc-full') {
    const enc = body.enc as Record<string, unknown> | undefined;
    return (
      typeof enc === 'object' &&
      enc !== null &&
      typeof enc.v === 'number' &&
      typeof enc.kid === 'string' &&
      enc.kid.length > 0 &&
      typeof enc.alg === 'string' &&
      typeof enc.nonce === 'string' &&
      enc.nonce.length > 0 &&
      typeof enc.ct === 'string' &&
      enc.ct.length > 0
    );
  }
  return false;
}

/** True for a `{ x:number, y:number }` cursor. Never throws. */
export function isViewportCursor(value: unknown): value is ViewportCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.x === 'number' && typeof c.y === 'number';
}

/**
 * SSE event NAME the bridge's session-scoped viewport endpoint emits (the `event:` line).
 * The mobile client subscribes to this single event name; its `data:` is a JSON-encoded
 * {@link MobileViewportSseEvent}.
 */
export const MOBILE_VIEWPORT_SSE_EVENT = 'viewport';

/** Express-style route template for the session-scoped mobile viewport SSE endpoint. */
export const MOBILE_VIEWPORT_SSE_PATH_TEMPLATE =
  '/v1/instances/:instanceId/sessions/:sessionId/viewport';

/**
 * Build the concrete session-scoped viewport SSE path the mobile client connects to.
 * Mirrors {@link MOBILE_VIEWPORT_SSE_PATH_TEMPLATE}; segments are URL-encoded.
 */
export function mobileViewportSsePath(instanceId: string, sessionId: string): string {
  return `/v1/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(
    sessionId,
  )}/viewport`;
}

/**
 * The session-scoped mobile SSE event payload (the SSE `data:` body), re-emitted by the
 * bridge from a {@link TunnelViewportFrame}. The stream is already session-scoped by URL,
 * so `subscriptionId` (a tunnel-internal routing detail) is intentionally dropped here.
 *
 * Contract: the bridge sends a `full` body on every (re)connect (from its latest-only
 * per-session buffer), then `diff` bodies; `seq` is the source-assigned monotonic counter
 * for client-side gap detection. On a gap the client reconnects and the next `full`
 * re-anchors — there is no diff-replay.
 */
export interface MobileViewportSseEvent {
  sessionId: string;
  seq: number;
  body: ViewportBody;
}

/** Structural guard for an untrusted, already-parsed mobile viewport SSE event. Never throws. */
export function isMobileViewportSseEvent(value: unknown): value is MobileViewportSseEvent {
  if (typeof value !== 'object' || value === null) return false;
  const ev = value as Record<string, unknown>;
  return (
    typeof ev.sessionId === 'string' &&
    ev.sessionId.length > 0 &&
    typeof ev.seq === 'number' &&
    Number.isInteger(ev.seq) &&
    ev.seq >= 0 &&
    isViewportBody(ev.body)
  );
}
