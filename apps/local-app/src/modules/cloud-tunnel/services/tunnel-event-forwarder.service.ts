import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TUNNEL_PUSH_FRAME_TYPE,
  TUNNEL_PUSH_FRAME_VERSION,
  type TunnelPushEnvelope,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { broadcastRegistry } from '../../events/catalog/broadcast-registry';
import { projectBroadcast } from '../../events/catalog/project-broadcast';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { TunnelClientService } from './tunnel-client.service';
import { TunnelPushCryptoService } from './tunnel-push-crypto.service';

const logger = createLogger('TunnelEventForwarder');

/**
 * The EXACT set of catalog events forwarded up the tunnel for mobile chat — an
 * explicit allowlist, never an open pipe. Board / epic / review events are NOT
 * forwarded (they belong to the web socket.io fan-out only).
 *
 * Phase 1 / Task 3 additions:
 *  - `agent.created` / `agent.deleted` (RC4): mobile list reflects agent add/remove live
 *    (topic `project/<id>/state`).
 *  - `chat.message.created` (RC3): forwarded for completeness so a future thread/group-chat
 *    mobile surface can ride the firehose; the existing single-agent open-chat already
 *    consumes `session.transcript.updated`, so no mobile consumer is wired here yet (the
 *    topic is allowlisted on both sides + sync-tested, but no mobile route subscribes —
 *    documented at the allowlist + in the Task 3 completion report).
 */
export const TUNNEL_FORWARDED_EVENTS = [
  'session.transcript.updated',
  'claude.hooks.ask_user_question.pending',
  'claude.hooks.ask_user_question.resolved',
  'session.presence.changed',
  'session.activity.changed',
  'agent.created',
  'agent.deleted',
  'chat.message.created',
] as const;

type ForwardedEvent = (typeof TUNNEL_FORWARDED_EVENTS)[number];

/**
 * The subset of forwarded events whose push `payload` carries real CONTENT (not just a
 * routing hint), so it must NEVER ship in plaintext to a non-E2EE-capable peer:
 *  - `claude.hooks.ask_user_question.pending` — the question text.
 *  - `chat.message.created` — the thread/group message body (latent; no mobile consumer yet).
 *  - `session.transcript.updated` — `deltaChunks`/`deltaMessages` carry transcript body text.
 *  - `agent.created` / `agent.deleted` — carry agent/team NAMES.
 *
 * When the lane can encrypt these are sealed like any other frame; when it can't, they are
 * WITHHELD (the phone recovers the content via its own encrypted per-topic catch-up / the
 * AUQ native push — push is a HINT, never the source of truth). Everything else is a pure
 * hint (counts/cursors/presence/ids) and may ride plaintext against an incapable peer.
 *
 * ALLOWLIST-IN-TWO-PLACES (development-standards §three-lanes): this set is the FORWARDER's
 * content policy; the canonical source of truth is each broadcast-registry entry's
 * `contentBearing` flag. `tunnel-push-content-policy-sync.spec` fails if the two drift — a
 * forwarded content-bearing registry entry with no matching policy entry would otherwise
 * leak real content onto a plaintext push frame for an incapable peer.
 */
export const CONTENT_BEARING_PUSH_EVENTS: ReadonlySet<ForwardedEvent> = new Set<ForwardedEvent>([
  'claude.hooks.ask_user_question.pending',
  'chat.message.created',
  'session.transcript.updated',
  'agent.created',
  'agent.deleted',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Forwards a narrow allowlist of catalog events up the existing tunnel WebSocket as
 * `{type:'push', v:2, …}` frames, IN ADDITION to (and fully independent of) the
 * socket.io fan-out — the web path is untouched.
 *
 * ADR-005:143-170 keeps catalog projection in events infrastructure behind a single
 * `REALTIME_BROADCASTER`. Rather than refactor that boundary, this is a standalone
 * EventEmitter2 subscriber (decision (b)); to avoid the projection-duplication risk
 * (b) warns about, it reuses the SAME `broadcast-registry` projection via
 * `projectBroadcast()` — only the transport sink differs.
 *
 * Authorization is enforced AT SOURCE: the local-app is the authority and validates
 * each frame's project/session scope (via `ActiveSessionLookup`) before sending. The
 * bridge only authenticates user+instance.
 */
@Injectable()
export class TunnelEventForwarderService implements OnModuleInit, OnModuleDestroy {
  private readonly listeners: Array<{
    event: ForwardedEvent;
    handler: (payload: unknown) => void;
  }> = [];

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly activeSessions: ActiveSessionLookup,
    private readonly tunnelClient: TunnelClientService,
    private readonly pushCrypto: TunnelPushCryptoService,
  ) {}

  onModuleInit(): void {
    for (const event of TUNNEL_FORWARDED_EVENTS) {
      const handler = (payload: unknown) => {
        void this.handleEvent(event, payload as Record<string, unknown>);
      };
      this.eventEmitter.on(event, handler);
      this.listeners.push({ event, handler });
    }
    logger.info(
      { eventCount: TUNNEL_FORWARDED_EVENTS.length },
      'Tunnel event forwarder registered allowlisted handlers',
    );
  }

  onModuleDestroy(): void {
    for (const { event, handler } of this.listeners) {
      this.eventEmitter.off(event, handler);
    }
    this.listeners.length = 0;
  }

  private async handleEvent(
    event: ForwardedEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Nothing can be sent while the tunnel is down — skip before doing any work.
      // Mobile recovers via per-topic catch-up on reconnect (stream is a hint).
      if (!this.tunnelClient.canPush()) return;

      // AUTH-THEN-ENCRYPT: source-side scope authorization runs FIRST (the local-app
      // originates these frames), before any payload is sealed.
      if (!(await this.isFrameInScope(event, payload))) {
        logger.debug({ event }, 'Dropping event with unowned/unresolvable scope');
        return;
      }

      // Resolve how content may travel to the paired mobile right now (encrypted / plaintext
      // hints-only / blocked). The push `payload` is sealed when the lane can encrypt; the
      // routing fields (`type`/`v`/`topic`/`eventType`) always stay cleartext for the bridge.
      const channel = await this.pushCrypto.resolvePushChannel(this.tunnelClient.getInstanceId());
      const contentBearing = CONTENT_BEARING_PUSH_EVENTS.has(event);

      // Fail-closed content guard: plaintext content must NEVER silently ship over push.
      if (channel.mode === 'blocked') {
        // E2EE-required policy facing an incapable peer — withhold everything (even hints).
        logger.debug(
          { event, reason: channel.reason },
          'Push withheld — E2EE required but peer not capable',
        );
        return;
      }
      if (channel.mode === 'plaintext' && contentBearing) {
        logger.debug(
          { event, reason: channel.reason },
          'Content-bearing push withheld — peer not E2EE-capable',
        );
        return;
      }

      const entries = broadcastRegistry[event] ?? [];
      for (const entry of entries) {
        // Same gate the socket.io broadcaster applies, so the two transports cannot
        // disagree about which payloads are broadcastable.
        if (entry.shouldBroadcast && !entry.shouldBroadcast(payload)) continue;
        const projected = projectBroadcast(entry, payload);
        const outboundPayload =
          channel.mode === 'encrypted'
            ? await channel.seal!(projected.topic, projected.type, projected.payload)
            : projected.payload;
        const frame: TunnelPushEnvelope = {
          type: TUNNEL_PUSH_FRAME_TYPE,
          v: TUNNEL_PUSH_FRAME_VERSION,
          topic: projected.topic,
          eventType: projected.type,
          payload: outboundPayload,
        };
        this.tunnelClient.sendPush(frame);
      }
    } catch (err) {
      logger.error({ err, event }, 'Tunnel event forwarding failed');
    }
  }

  /**
   * Source-side authorization. The local-app owns the data, so it confirms each frame
   * resolves to an owned session/project before forwarding (fail-closed). Session-
   * centric frames (transcript, AskUserQuestion) MUST resolve to an owned session;
   * AskUserQuestion additionally cross-checks the event's own `projectId`. Presence is
   * agent-scoped and emitted by this instance's own presence tracker — a non-empty
   * `agentId` is required, and when a session is attached it must be owned by that
   * agent.
   */
  private async isFrameInScope(
    event: ForwardedEvent,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    switch (event) {
      case 'session.transcript.updated':
      case 'session.activity.changed': {
        // Both project `session/<id>` (transcript adds the `/transcript` suffix)
        // and carry a `sessionId`; forward only when it resolves to an owned
        // session — same fail-closed scope check.
        const sessionId = payload.sessionId;
        if (!isNonEmptyString(sessionId)) return false;
        return (await this.activeSessions.getSessionProjectScope(sessionId)) !== null;
      }

      case 'claude.hooks.ask_user_question.pending':
      case 'claude.hooks.ask_user_question.resolved': {
        const sessionId = payload.sessionId;
        if (!isNonEmptyString(sessionId)) return false;
        const scope = await this.activeSessions.getSessionProjectScope(sessionId);
        if (!scope) return false;
        const projectId = payload.projectId;
        if (isNonEmptyString(projectId) && scope.projectId !== projectId) {
          logger.warn({ event, sessionId }, 'Project scope mismatch — dropping frame');
          return false;
        }
        return true;
      }

      case 'session.presence.changed': {
        const agentId = payload.agentId;
        if (!isNonEmptyString(agentId)) return false;
        const sessionId = payload.sessionId;
        if (isNonEmptyString(sessionId)) {
          const scope = await this.activeSessions.getSessionProjectScope(sessionId);
          if (!scope) return false;
          if (isNonEmptyString(scope.agentId) && scope.agentId !== agentId) {
            logger.warn({ agentId, sessionId }, 'Presence agent/session mismatch — dropping frame');
            return false;
          }
        }
        return true;
      }

      case 'agent.created':
      case 'agent.deleted': {
        // Project-scoped lifecycle events (topic `project/<projectId>/state`). These are
        // emitted IN-PROCESS by this instance's own services for ITS OWN projects, so the
        // defense-in-depth check is the presence of a non-empty `projectId` matching the
        // registry projection's topic key. There is no `ActiveSessionLookup` for projects
        // (the lookup is session-scoped), and a DB round-trip per lifecycle event is
        // disproportionate — the in-process emitter is the authority here.
        const projectId = payload.projectId;
        if (!isNonEmptyString(projectId)) return false;
        return true;
      }

      case 'chat.message.created': {
        // Thread/group-chat message (topic `chat/<threadId>`). Same shape-only scope check
        // as agent lifecycle: a non-empty `threadId` is required. There is no active-thread
        // ownership lookup analogous to `getSessionProjectScope`; the in-process emitter is
        // the authority. Forwarded for firehose completeness — no mobile consumer is wired
        // yet (thread/group chat is a future mobile surface).
        const threadId = payload.threadId;
        if (!isNonEmptyString(threadId)) return false;
        return true;
      }

      default:
        return false;
    }
  }
}
