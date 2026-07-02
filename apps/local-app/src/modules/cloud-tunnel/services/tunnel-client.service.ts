import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  Optional,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { hostname } from 'os';
import {
  TUNNEL_PROTOCOL_VERSION_PUSH,
  TUNNEL_CONTROL_FRAME_TYPE,
  TUNNEL_CONTROL_FRAME_VERSION,
  isTunnelLivenessResultFrame,
  buildE2eeCapability,
  type TunnelPushEnvelope,
  type TunnelLivenessQueryFrame,
  type TunnelViewportFrame,
  type E2eeCapability,
} from '@devchain/shared';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { RefreshGateService } from '../../cloud/services/refresh-gate.service';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import { TunnelKeypairService } from './tunnel-keypair.service';
import { TunnelHandlerService } from './tunnel-handler.service';
import { TunnelRpcCryptoService, E2EE_REQUIRED_POLICY } from './tunnel-rpc-crypto.service';
import { ViewportFrameSink } from './viewport-frame-sink';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('TunnelClient');

const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000;
// How long to wait for the bridge's liveness reply before failing the query. Kept
// short: the AUQ gate treats an unanswered query as "not live" and delivers native.
const CONTROL_QUERY_TIMEOUT_MS = 5_000;

/** Result of an SSE-liveness control query against the bridge. */
export interface SseLivenessResult {
  live: boolean;
  lastSeenAt: number | null;
}

@Injectable()
export class TunnelClientService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, ViewportFrameSink
{
  private ws: WebSocket | null = null;
  private reconnectDelay = BASE_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingHeartbeatPong = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChallenge: { nonce: string; ts: string } | null = null;
  private destroyed = false;
  // True only between receiving `ready` and the socket being torn down. Gates push
  // sends so a frame is never written before the handshake completes or after close.
  private tunnelReady = false;
  // Bridge-assigned instance id (from the `ready` frame). Used to stamp AUQ egress
  // payloads; the bridge derives liveness from the tunnel itself, so queries omit it.
  private instanceId: string | null = null;
  // In-flight control-frame queries (reverse-direction request/response), keyed by a
  // local correlation id. DELIBERATELY separate from anything RPC: the local-app only
  // RESPONDS to RPC, so there is no RPC inflight map here for this to collide with.
  private readonly pendingControl = new Map<
    string,
    { resolve: (r: SseLivenessResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private controlSeq = 0;
  // Listeners notified each time the tunnel (re)reaches `ready`. The viewport streamer
  // uses this to re-anchor with a fresh full-screen after a reconnect (the latest-only
  // bridge buffer must be re-primed). Pure observers — they never write to this map.
  private readonly readyListeners = new Set<() => void>();

  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
    private readonly keypair: TunnelKeypairService,
    private readonly handler: TunnelHandlerService,
    private readonly e2eeKeypair: E2eeKeypairService,
    private readonly rpcCrypto: TunnelRpcCryptoService,
    // PC-side E2EE-required policy (Phase 2, Task:2): advertised in the attest capability
    // descriptor so the mobile negotiates consistently, AND enforced by TunnelRpcCryptoService.
    @Optional() @Inject(E2EE_REQUIRED_POLICY) private readonly e2eeRequired: boolean = false,
  ) {}

  onModuleInit() {
    if (this.cloudSession.getStatus().connected) {
      this.connect();
    }
  }

  onApplicationBootstrap() {
    if (this.cloudSession.getStatus().connected) {
      this.connect();
    }
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.disconnect();
  }

  @OnEvent('session.cloud_connected')
  handleCloudConnected() {
    this.connect();
  }

  @OnEvent('session.cloud_disconnected')
  handleCloudDisconnected() {
    this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.destroyed || this.ws) return;

    // Every new socket starts not-ready; push sends stay gated until its own `ready`.
    this.tunnelReady = false;

    const token = this.cloudSession.getAccessToken();
    if (!token) return;

    const bridgeUrl = process.env.BRIDGE_SERVICE_URL ?? 'https://api.devchain.cc';
    const wsUrl = bridgeUrl.replace(/^http/, 'ws') + '/v1/tunnel';

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));
      this.ws.on('error', (err) => {
        logger.error({ err }, 'Tunnel WS error');
        this.handleSocketError();
      });
      this.startReadyTimeout(this.ws);
    } catch (err) {
      logger.error({ err }, 'Failed to create tunnel WS connection');
      this.scheduleReconnect();
    }
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;

    if (msg.type === 'challenge') {
      const nonce = msg.nonce as string;
      const ts = msg.ts as string;
      this.pendingChallenge = { nonce, ts };
      await this.respondToChallenge(nonce, ts);
      return;
    }

    if (msg.type === 'ready') {
      this.stopReadyTimeout();
      this.reconnectDelay = BASE_RECONNECT_DELAY;
      const instanceId = msg.instanceId as string;
      this.instanceId = instanceId;
      await this.keypair.setInstanceId(instanceId);
      this.startHeartbeat();
      this.tunnelReady = true;
      logger.info({ instanceId }, 'Tunnel ready');
      this.notifyReadyListeners();
      return;
    }

    // Reverse-direction control reply (e.g. SSE liveness). Routed before the JSON-RPC
    // branch and never touched by RPC correlation.
    if (msg.type === TUNNEL_CONTROL_FRAME_TYPE && isTunnelLivenessResultFrame(msg)) {
      this.resolveControlQuery(msg.id, { live: msg.live, lastSeenAt: msg.lastSeenAt });
      return;
    }

    if ('jsonrpc' in msg && msg.method) {
      // RPC transport seam (Phase 2): decrypt encrypted params BEFORE the handler runs its
      // scope/auth (decrypt-then-auth), then seal the handler's result/error on the way
      // back. `method` + `id` stay cleartext. Plaintext params pass straight through.
      const response = await this.rpcCrypto.handle(
        msg as unknown as Parameters<typeof this.handler.handle>[0],
        this.instanceId,
        // The crypto layer supplies a trusted `cryptoCtx` (verified sender kid) ONLY on the
        // sealed lane; thread it to the handler so sealed-only methods can act on it.
        (plain, cryptoCtx) =>
          this.handler.handle(
            plain as unknown as Parameters<typeof this.handler.handle>[0],
            cryptoCtx,
          ),
      );
      this.ws?.send(JSON.stringify(response));
    }
  }

  /**
   * Whether an unsolicited server→client push frame can be written right now: the
   * handshake has completed (`ready` received) and the socket is open. Used by the
   * tunnel event forwarder to skip projection work when nothing can be sent — the
   * mobile SSE per-topic catch-up is the source of truth, so dropping while
   * disconnected is safe.
   */
  canPush(): boolean {
    return this.tunnelReady && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a discriminated `{type:'push', v:2, …}` frame up the tunnel, alongside the
   * JSON-RPC responses this client already sends. Best-effort: returns `false`
   * (never throws) when the tunnel isn't push-ready. `eventId` is bridge-assigned,
   * so it is intentionally absent from the wire envelope.
   */
  sendPush(frame: TunnelPushEnvelope): boolean {
    if (!this.canPush()) return false;
    try {
      this.ws!.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      logger.warn({ err, topic: frame.topic }, 'Failed to send tunnel push frame');
      return false;
    }
  }

  /**
   * Send a discriminated `{type:'viewport', …}` frame up the tunnel. A SEPARATE LANE from
   * push: it carries the live tmux screen for one `{sessionId, subscriptionId}` and is
   * gated by the same `canPush()` readiness. Best-effort — returns `false` (never throws)
   * when the tunnel isn't ready; the streamer re-anchors with a full on the next `ready`.
   */
  sendViewport(frame: TunnelViewportFrame): boolean {
    if (!this.canPush()) return false;
    try {
      this.ws!.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      logger.warn(
        { err, sessionId: frame.sessionId, subscriptionId: frame.subscriptionId },
        'Failed to send tunnel viewport frame',
      );
      return false;
    }
  }

  /**
   * Register a callback fired each time the tunnel (re)reaches `ready`. Returns an
   * idempotent unregister fn. Used by the viewport streamer to re-send a full screen after
   * a reconnect so the bridge's latest-only buffer is re-primed.
   */
  onPushReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  private notifyReadyListeners(): void {
    for (const listener of this.readyListeners) {
      try {
        listener();
      } catch (err) {
        logger.warn({ err }, 'Tunnel ready listener threw');
      }
    }
  }

  /** Bridge-assigned instance id once the tunnel is `ready`, else `null`. */
  getInstanceId(): string | null {
    return this.instanceId;
  }

  /**
   * Ask the bridge whether this instance's mobile SSE stream is live (reverse-direction
   * control frame). Resolves `{live:false}` — never rejects — when the tunnel isn't
   * push-ready or the bridge doesn't answer within {@link CONTROL_QUERY_TIMEOUT_MS}, so
   * the AUQ gate fails toward delivering the native push rather than silently dropping it.
   */
  querySseLiveness(): Promise<SseLivenessResult> {
    if (!this.canPush()) {
      return Promise.resolve({ live: false, lastSeenAt: null });
    }

    const id = `ctrl-${++this.controlSeq}`;
    return new Promise<SseLivenessResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        resolve({ live: false, lastSeenAt: null });
      }, CONTROL_QUERY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      this.pendingControl.set(id, { resolve, timer });

      const frame: TunnelLivenessQueryFrame = {
        type: TUNNEL_CONTROL_FRAME_TYPE,
        v: TUNNEL_CONTROL_FRAME_VERSION,
        ctrl: 'sse_liveness_query',
        id,
      };
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        logger.warn({ err }, 'Failed to send SSE liveness query');
        this.resolveControlQuery(id, { live: false, lastSeenAt: null });
      }
    });
  }

  private resolveControlQuery(id: string, result: SseLivenessResult): void {
    const pending = this.pendingControl.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControl.delete(id);
    pending.resolve(result);
  }

  /** Fail any in-flight control queries (socket torn down) — resolve not-live. */
  private failPendingControlQueries(): void {
    if (this.pendingControl.size === 0) return;
    for (const { resolve, timer } of this.pendingControl.values()) {
      clearTimeout(timer);
      resolve({ live: false, lastSeenAt: null });
    }
    this.pendingControl.clear();
  }

  private async respondToChallenge(nonce: string, ts: string): Promise<void> {
    try {
      const kp = await this.keypair.getOrCreate();
      const signPayload = nonce + (kp.instanceId ?? '') + ts;
      const signature = await this.keypair.sign(signPayload, kp.privateKey);
      const e2ee = await this.buildE2eeCapability();

      this.ws?.send(
        JSON.stringify({
          type: 'attest',
          publicKey: kp.publicKey,
          signature,
          label: hostname(),
          // v2 = RPC + server→client push. The bridge accepts both v1 and v2, so this
          // bump is backward-compatible (sub-epic 2: tunnel.gateway handleAttest).
          protocolVersion: TUNNEL_PROTOCOL_VERSION_PUSH,
          instanceId: kp.instanceId,
          // E2EE capability descriptor (Task:5): the bridge stores it in presence and
          // relays it to the mobile via the instance listing so an email-logged-in phone
          // can adopt this PC key (TOFU). Best-effort: a failure falls back to advertising
          // no E2EE support rather than blocking the (Ed25519-authenticated) tunnel.
          ...(e2ee ? { e2ee } : {}),
        }),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to respond to challenge');
      this.ws?.close();
    }
  }

  /**
   * Build this PC's E2EE capability descriptor for the attest handshake: the dedicated
   * X25519 public key + kid (fingerprint) so the mobile can adopt it on email login.
   * Returns `null` (advertise "no E2EE") if the keypair can't be exported — never blocks
   * the tunnel, which authenticates separately via the Ed25519 attestation key.
   */
  private async buildE2eeCapability(): Promise<E2eeCapability | null> {
    try {
      const pub = await this.e2eeKeypair.exportPublic();
      return buildE2eeCapability({
        e2eeRequired: this.e2eeRequired,
        key: { kid: pub.kid, publicKeyB64: pub.publicKeyB64 },
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to export E2EE public key for attest — advertising no E2EE');
      return null;
    }
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    this.stopReadyTimeout();
    this.stopHeartbeat();
    this.ws = null;
    this.pendingChallenge = null;
    this.failPendingControlQueries();

    if (this.destroyed) return;

    logger.info({ code, reason }, 'Tunnel closed');

    if (code === 4001) {
      const outcome = await this.refreshGate.attemptRefresh();
      if (outcome === 'success') {
        this.scheduleReconnect();
        return;
      }
      if (outcome === 'transient_failure') {
        this.scheduleReconnect();
        return;
      }
      logger.error({ code, reason, outcome }, 'Tunnel auth permanently failed');
      return;
    }

    if (code === 4002) {
      logger.warn('Instance revoked; not reconnecting');
      return;
    }

    if (code === 4003) {
      logger.error('Protocol incompatible; not reconnecting');
      return;
    }

    this.scheduleReconnect();
  }

  private handleSocketError(): void {
    const socket = this.ws;
    if (!socket) return;

    this.stopReadyTimeout();
    this.stopHeartbeat();
    this.ws = null;
    this.pendingChallenge = null;
    this.failPendingControlQueries();

    try {
      socket.terminate();
    } catch {
      socket.close();
    }

    this.scheduleReconnect();
  }

  private startReadyTimeout(socket: WebSocket): void {
    this.stopReadyTimeout();
    this.readyTimer = setTimeout(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;

      logger.warn('Tunnel ready timeout — reconnecting');
      this.stopHeartbeat();
      this.ws = null;
      this.pendingChallenge = null;
      this.failPendingControlQueries();

      try {
        socket.terminate();
      } catch {
        socket.close();
      }

      this.scheduleReconnect();
    }, READY_TIMEOUT_MS);
  }

  private stopReadyTimeout(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const jitter = Math.random() * 1000;
    const delay = this.reconnectDelay + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const socket = this.ws;
    if (!socket) return;

    socket.on('pong', () => {
      if (this.ws !== socket) return;
      this.clearHeartbeatPongTimeout();
    });

    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      if (this.awaitingHeartbeatPong) {
        this.handleHeartbeatTimeout(socket);
        return;
      }

      this.awaitingHeartbeatPong = true;
      socket.ping();
      this.heartbeatPongTimer = setTimeout(() => {
        if (
          this.ws === socket &&
          this.awaitingHeartbeatPong &&
          socket.readyState === WebSocket.OPEN
        ) {
          this.handleHeartbeatTimeout(socket);
        }
      }, HEARTBEAT_PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatPongTimeout();
  }

  private clearHeartbeatPongTimeout(): void {
    if (this.heartbeatPongTimer) {
      clearTimeout(this.heartbeatPongTimer);
      this.heartbeatPongTimer = null;
    }
    this.awaitingHeartbeatPong = false;
  }

  private handleHeartbeatTimeout(socket: WebSocket): void {
    logger.warn('Tunnel heartbeat timeout — reconnecting');
    this.stopReadyTimeout();
    this.stopHeartbeat();

    if (this.ws === socket) {
      this.ws = null;
      this.pendingChallenge = null;
    }
    this.failPendingControlQueries();

    try {
      socket.terminate();
    } catch {
      socket.close();
    }

    this.scheduleReconnect();
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopReadyTimeout();
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingChallenge = null;
    this.failPendingControlQueries();
  }
}
