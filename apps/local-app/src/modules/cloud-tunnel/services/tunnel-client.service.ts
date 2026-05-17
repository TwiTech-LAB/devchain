import { Injectable, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { hostname } from 'os';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { RefreshGateService } from '../../cloud/services/refresh-gate.service';
import { TunnelKeypairService } from './tunnel-keypair.service';
import { TunnelHandlerService } from './tunnel-handler.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('TunnelClient');

const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000;

@Injectable()
export class TunnelClientService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private ws: WebSocket | null = null;
  private reconnectDelay = BASE_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingHeartbeatPong = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChallenge: { nonce: string; ts: string } | null = null;
  private destroyed = false;

  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
    private readonly keypair: TunnelKeypairService,
    private readonly handler: TunnelHandlerService,
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

    const token = this.cloudSession.getAccessToken();
    if (!token) return;

    const bridgeUrl = process.env.BRIDGE_SERVICE_URL ?? 'https://bridge.devchain.twitechlab.com';
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
      await this.keypair.setInstanceId(instanceId);
      this.startHeartbeat();
      logger.info({ instanceId }, 'Tunnel ready');
      return;
    }

    if ('jsonrpc' in msg && msg.method) {
      const response = await this.handler.handle(
        msg as unknown as Parameters<typeof this.handler.handle>[0],
      );
      this.ws?.send(JSON.stringify(response));
    }
  }

  private async respondToChallenge(nonce: string, ts: string): Promise<void> {
    try {
      const kp = await this.keypair.getOrCreate();
      const signPayload = nonce + (kp.instanceId ?? '') + ts;
      const signature = await this.keypair.sign(signPayload, kp.privateKey);

      this.ws?.send(
        JSON.stringify({
          type: 'attest',
          publicKey: kp.publicKey,
          signature,
          label: hostname(),
          protocolVersion: '1',
          instanceId: kp.instanceId,
        }),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to respond to challenge');
      this.ws?.close();
    }
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    this.stopReadyTimeout();
    this.stopHeartbeat();
    this.ws = null;
    this.pendingChallenge = null;

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
  }
}
