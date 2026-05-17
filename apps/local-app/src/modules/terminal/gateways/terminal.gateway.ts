import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { createLogger } from '../../../common/logging/logger';
import { TerminalStreamService } from '../services/terminal-stream.service';
import { PtyService } from '../services/pty.service';
import { TerminalIOService } from '../services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../services/terminal-session/terminal-session-registry';
import { TerminalSeedService } from '../services/terminal-seed.service';
import { isControlKey, toTmuxKeys } from '../utils/control-keys';
import { SettingsService } from '../../settings/services/settings.service';
import { createEnvelope, HeartbeatPayload, SessionStatePayload } from '../dtos/ws-envelope.dto';
import type { FrameEvent } from '../services/terminal-session/terminal-frame-stream';
import type { TerminalSession } from '../services/terminal-session/terminal-session';
import { SessionsService } from '../../sessions/services/sessions.service';
import { normalizeLineEndings } from '../utils/normalize-line-endings';
import { RealtimeBroadcastService } from '../../realtime/services/realtime-broadcast.service';

const logger = createLogger('TerminalGateway');

const THEME_HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface ThemeStyle {
  foregroundHex: string;
  backgroundHex: string;
}

interface ClientSession {
  sessionId: string;
  lastHeartbeat: Date;
  subscriptions: Set<string>;
}

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 45000;

const INPUT_RATE_WINDOW_MS = 5000;
const INPUT_RATE_MSG_THRESHOLD = 500; // >100 msg/sec sustained over 5s = 500 msgs in window
const INPUT_RATE_BYTES_THRESHOLD = 512000; // >100KB/sec sustained over 5s = 500KB in window

interface InputRateEntry {
  messages: number;
  bytes: number;
  windowStart: number;
  warned: boolean;
}

@WebSocketGateway({ cors: false, transports: ['websocket'] })
@Injectable()
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private clientSessions = new Map<string, ClientSession>();
  private frameListeners = new Map<
    string,
    { session: TerminalSession; listener: (frame: FrameEvent) => void }
  >();
  private heartbeatInterval?: NodeJS.Timeout;
  private inputRateTracker = new Map<string, InputRateEntry>();
  private readonly themeCache = new Map<string, ThemeStyle>();

  constructor(
    private readonly streamService: TerminalStreamService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => PtyService))
    private readonly ptyService: PtyService,
    private readonly seedService: TerminalSeedService,
    @Inject(forwardRef(() => TerminalIOService))
    private readonly terminalIO: TerminalIOService,
    private readonly registry: TerminalSessionRegistry,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly realtimeBroadcast: RealtimeBroadcastService,
  ) {}

  afterInit() {
    this.realtimeBroadcast.setServer(this.server);
    logger.info('WebSocket gateway initialized');
    this.startHeartbeat();
  }

  handleConnection(client: Socket) {
    logger.info(
      { clientId: client.id, transport: client.conn?.transport?.name },
      'Client connected',
    );
    this.clientSessions.set(client.id, {
      sessionId: '',
      lastHeartbeat: new Date(),
      subscriptions: new Set(),
    });
    this.sendHeartbeat(client);
  }

  handleDisconnect(client: Socket) {
    logger.info({ clientId: client.id }, 'Client disconnected');
    const clientSession = this.clientSessions.get(client.id);
    if (clientSession?.sessionId) {
      const session = this.registry.get(clientSession.sessionId);
      if (session) {
        session.unsubscribe(client.id);
      }
    }
    this.clientSessions.delete(client.id);
  }

  // ── Subscribe / Unsubscribe ─────────────────────────────────────────

  @SubscribeMessage('terminal:subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { sessionId: string; lastSequence?: number; rows?: number; cols?: number },
  ) {
    const { sessionId, lastSequence, rows, cols } = payload;
    logger.info({ clientId: client.id, sessionId, lastSequence, rows, cols }, 'Client subscribing');

    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) return;

    clientSession.sessionId = sessionId;
    clientSession.subscriptions.add(`session/${sessionId}`);
    client.join(`session:${sessionId}`);
    this.streamService.initializeBuffer(sessionId);

    const session = this.registry.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No registry entry — using fallback seed path');
      client.emit(
        'message',
        createEnvelope(`terminal/${sessionId}`, 'subscribed', {
          sessionId,
          currentSequence: 0,
        }),
      );
      clientSession.subscriptions.add(`terminal/${sessionId}`);
      client.join(`terminal:${sessionId}`);
      if (typeof lastSequence !== 'number') {
        const { maxBytes: seedMaxBytes } = this.seedService.resolveSeedingConfig();
        this.seedService
          .emitSeedToClient({
            client,
            sessionId,
            maxBytes: seedMaxBytes,
            cols,
            rows,
          })
          .catch((error) => {
            logger.error({ sessionId, clientId: client.id, error }, 'Fallback seed failed');
          });
      }
      return;
    }

    const tmuxAlive = await this.terminalIO.sessionExists({ name: session.tmuxSessionName });
    if (!tmuxAlive) {
      await this.handleDeadTmuxSession(sessionId, client);
      return;
    }

    await this.ensurePtyStreaming(sessionId, session.tmuxSessionName, { cols, rows });

    const isFirstAttach = typeof lastSequence !== 'number';
    if (typeof rows === 'number' && rows > 0 && typeof cols === 'number' && cols > 0) {
      this.ptyService.resize(sessionId, cols, rows);
      if (isFirstAttach) {
        this.seedService.invalidateCache(sessionId);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    client.emit(
      'message',
      createEnvelope(`terminal/${sessionId}`, 'subscribed', {
        sessionId,
        currentSequence: this.streamService.getCurrentSequence(sessionId),
      }),
    );
    clientSession.subscriptions.add(`terminal/${sessionId}`);
    client.join(`terminal:${sessionId}`);

    this.wireFrameListener(sessionId);
    session.subscribe(client.id);

    if (!isFirstAttach) {
      const bufferedFrames = this.streamService.getFramesSince(sessionId, lastSequence);
      for (const frame of bufferedFrames) {
        client.emit('message', frame);
      }
    }
  }

  @SubscribeMessage('events:subscribe')
  handleEventsSubscribe(@ConnectedSocket() client: Socket) {
    const cs = this.clientSessions.get(client.id);
    if (!cs) return;
    cs.subscriptions.add('events');
    client.join('events');
    logger.debug({ clientId: client.id }, 'Subscribed to events');
  }

  @SubscribeMessage('chat:subscribe')
  handleChatSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { threadId: string },
  ) {
    const cs = this.clientSessions.get(client.id);
    if (!cs) return;
    const topic = `chat/${payload.threadId}`;
    cs.subscriptions.add(topic);
    client.join(`chat:${payload.threadId}`);
    logger.debug({ clientId: client.id, threadId: payload.threadId }, 'Joined chat room');
  }

  @SubscribeMessage('chat:unsubscribe')
  handleChatUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { threadId: string },
  ) {
    const cs = this.clientSessions.get(client.id);
    if (!cs) return;
    cs.subscriptions.delete(`chat/${payload.threadId}`);
    client.leave(`chat:${payload.threadId}`);
  }

  @SubscribeMessage('terminal:unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string },
  ) {
    const { sessionId } = payload;
    const cs = this.clientSessions.get(client.id);
    if (!cs) return;

    cs.subscriptions.delete(`terminal/${sessionId}`);
    cs.subscriptions.delete(`session/${sessionId}`);
    client.leave(`terminal:${sessionId}`);
    client.leave(`session:${sessionId}`);

    const session = this.registry.get(sessionId);
    if (session) session.unsubscribe(client.id);
  }

  // ── Theme sync ─────────────────────────────────────────────────────

  @SubscribeMessage('terminal:theme')
  async handleTheme(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { foregroundHex: string; backgroundHex: string },
  ): Promise<void> {
    const cs = this.clientSessions.get(client.id);
    if (!cs) return;

    const { foregroundHex, backgroundHex } = payload ?? {};
    if (!THEME_HEX_RE.test(foregroundHex) || !THEME_HEX_RE.test(backgroundHex)) {
      throw new WsException(
        'Invalid terminal:theme payload: foregroundHex and backgroundHex must be strict #RRGGBB hex',
      );
    }

    // V1: any subscribed client may set theme; last-writer-wins across multiple clients.
    const subscribedSessionIds = [...cs.subscriptions]
      .filter((s) => s.startsWith('terminal/'))
      .map((s) => s.slice('terminal/'.length));

    for (const sessionId of subscribedSessionIds) {
      const session = this.registry.get(sessionId);
      if (!session) continue;

      const cached = this.themeCache.get(sessionId);
      if (cached?.foregroundHex === foregroundHex && cached?.backgroundHex === backgroundHex) {
        logger.debug({ sessionId }, 'terminal_theme_skipped_unchanged');
        continue;
      }

      try {
        await this.terminalIO.applyWindowTheme(
          { name: session.tmuxSessionName },
          foregroundHex,
          backgroundHex,
        );
        this.themeCache.set(sessionId, { foregroundHex, backgroundHex });
        logger.debug({ sessionId }, 'terminal_theme_applied');
        void this.ptyService.triggerRedraw(sessionId);
      } catch (error) {
        logger.debug({ sessionId, error: String(error) }, 'terminal_theme_apply_failed');
      }
    }
  }

  // ── Focus / Resize / Input ──────────────────────────────────────────

  @SubscribeMessage('terminal:focus')
  handleFocus(@ConnectedSocket() client: Socket, @MessageBody() payload: { sessionId: string }) {
    const session = this.registry.get(payload.sessionId);
    if (!session) return;
    if (!session.hasSubscriber(client.id)) {
      logger.warn(
        { sessionId: payload.sessionId, clientId: client.id, reason: 'not_subscriber' },
        'Focus rejected',
      );
      return;
    }
    session.claimAuthority(client.id);
  }

  @SubscribeMessage('terminal:resize')
  async handleResize(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string; rows: number; cols: number },
  ) {
    const { sessionId, rows, cols } = payload;
    const session = this.registry.get(sessionId);
    if (!session) return;

    const tmuxAlive = await this.terminalIO.sessionExists({ name: session.tmuxSessionName });
    if (!tmuxAlive) {
      await this.handleDeadTmuxSession(sessionId, client);
      return;
    }

    const result = session.resize(client.id, { cols, rows });
    if (result.applied) {
      this.ptyService.resize(sessionId, cols, rows);
      this.server
        .to(`terminal:${sessionId}`)
        .emit('message', createEnvelope(`terminal/${sessionId}`, 'resize', { rows, cols }));
    }
  }

  @SubscribeMessage('terminal:input')
  async handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string; data: string; ttyMode?: boolean },
  ) {
    const { sessionId, data, ttyMode = false } = payload;
    const session = this.registry.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Input for unknown session');
      return;
    }

    if (!session.hasSubscriber(client.id)) {
      logger.warn({ sessionId, clientId: client.id, reason: 'not_subscriber' }, 'Input rejected');
      return;
    }

    if (session.getAuthority() !== client.id) {
      logger.warn({ sessionId, clientId: client.id, reason: 'not_authority' }, 'Input rejected');
      return;
    }

    this.trackInputRate(client.id, sessionId, data.length);

    const tmuxAlive = await this.terminalIO.sessionExists({ name: session.tmuxSessionName });
    if (!tmuxAlive) {
      await this.handleDeadTmuxSession(sessionId, client);
      return;
    }

    session.signalInput();
    const target = { name: session.tmuxSessionName };

    if (isControlKey(data)) {
      await this.terminalIO.sendControl(target, toTmuxKeys(data));
    } else if (ttyMode) {
      await this.terminalIO.sendControl(target, ['-l', '--', data]);
    } else {
      try {
        await this.terminalIO.deliverImmediate(target, data, { bracketed: true });
      } catch (error) {
        logger.warn({ sessionId, error: String(error) }, 'deliverImmediate failed');
      }
    }
  }

  @SubscribeMessage('terminal:request_full_history')
  async handleRequestFullHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string; maxLines?: number },
  ) {
    const { sessionId } = payload;

    let maxLines = 10000;
    if (payload.maxLines !== undefined && payload.maxLines !== null) {
      const parsed = Math.floor(Number(payload.maxLines));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new WsException('maxLines must be a positive integer');
      }
      maxLines = parsed;
    }
    maxLines = Math.min(maxLines, this.settingsService.getScrollbackLines());

    const cs = this.clientSessions.get(client.id);
    if (!cs?.subscriptions.has(`terminal/${sessionId}`)) return;

    const session = this.registry.get(sessionId);
    if (!session) return;

    const capturedSequence = this.streamService.getCurrentSequence(sessionId);
    const target = { name: session.tmuxSessionName };

    const captureResult = await this.terminalIO.captureHistory(target, maxLines, true);
    let history = captureResult.ok ? captureResult.output : '';
    if (history.endsWith('\n')) history = history.slice(0, -1);

    const { maxBytes } = this.seedService.resolveSeedingConfig();
    let hasHistory = false;
    if (Buffer.byteLength(history, 'utf-8') > maxBytes) {
      const { truncated, wasTruncated } = this.seedService.truncateToMaxBytes(history, maxBytes);
      history = truncated;
      hasHistory = wasTruncated;
    }

    history = normalizeLineEndings(history);

    const cursorPos = await this.terminalIO.getCursorPosition(target);

    client.emit(
      'message',
      createEnvelope(`terminal/${sessionId}`, 'full_history', {
        history,
        cursorX: cursorPos?.x,
        cursorY: cursorPos?.y,
        hasHistory,
        capturedSequence,
      }),
    );
  }

  @SubscribeMessage('pong')
  handlePong(@ConnectedSocket() client: Socket) {
    const cs = this.clientSessions.get(client.id);
    if (cs) cs.lastHeartbeat = new Date();
  }

  // ── Broadcasts ──────────────────────────────────────────────────────

  broadcastTerminalData(sessionId: string, data: string): void {
    this.registry.get(sessionId)?.pushFrame(data);
    const envelope = this.streamService.addFrame(sessionId, data);
    this.server.to(`terminal:${sessionId}`).emit('message', envelope);
  }

  // ── Session lifecycle events ────────────────────────────────────────

  @OnEvent('session.crashed')
  handleSessionCrashed(payload: { sessionId: string; sessionName: string }) {
    this.unwireFrameListener(payload.sessionId);
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'crashed',
      message: 'Session unexpectedly terminated',
    };
    this.server
      .to(`session:${payload.sessionId}`)
      .emit('message', createEnvelope(`session/${payload.sessionId}`, 'state_change', ep));
    setTimeout(() => this.streamService.clearBuffer(payload.sessionId), 60000);
    this.themeCache.delete(payload.sessionId);
  }

  @OnEvent('session.started')
  handleSessionStarted(payload: {
    sessionId: string;
    epicId: string | null;
    agentId: string;
    tmuxSessionName: string;
  }) {
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'started',
      message: 'Session started successfully',
    };
    this.server.emit('message', createEnvelope('sessions', 'started', ep));
  }

  @OnEvent('session.restored')
  handleSessionRestored(payload: {
    sessionId: string;
    epicId: string | null;
    agentId: string;
    tmuxSessionName: string;
    providerName: string;
  }) {
    if (!this.registry.get(payload.sessionId) && payload.tmuxSessionName) {
      try {
        this.registry.create(payload.sessionId, payload.tmuxSessionName, {
          normalizeCapturedLineEndings: true,
        });
        this.registry.bind(payload.sessionId, this.terminalIO);
      } catch {
        // Registry entry may already exist from a concurrent restore
      }
    }
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'started',
      message: 'Session restored successfully',
    };
    this.server.emit('message', createEnvelope('sessions', 'started', ep));
  }

  @OnEvent('session.stopped')
  handleSessionStopped(payload: { sessionId: string }) {
    this.unwireFrameListener(payload.sessionId);
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'ended',
      message: 'Session terminated',
    };
    this.server.emit('message', createEnvelope('sessions', 'stopped', ep));
    setTimeout(() => this.streamService.clearBuffer(payload.sessionId), 60000);
    this.seedService.invalidateCache(payload.sessionId);
    this.themeCache.delete(payload.sessionId);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      this.clientSessions.forEach((cs, clientId) => {
        if (now.getTime() - cs.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT) {
          logger.warn({ clientId }, 'Client heartbeat timeout');
          this.server.sockets.sockets.get(clientId)?.disconnect(true);
          this.clientSessions.delete(clientId);
        } else {
          const sock = this.server.sockets.sockets.get(clientId);
          if (sock) this.sendHeartbeat(sock);
        }
      });
    }, HEARTBEAT_INTERVAL);
  }

  private sendHeartbeat(client: Socket): void {
    const p: HeartbeatPayload = { timestamp: new Date().toISOString() };
    client.emit('message', createEnvelope('system', 'ping', p));
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private wireFrameListener(sessionId: string): void {
    const session = this.registry.get(sessionId);
    if (!session) return;

    const existing = this.frameListeners.get(sessionId);
    if (existing?.session === session) return;

    if (existing) {
      existing.session.stream.off('frame', existing.listener);
      logger.info({ sessionId }, 'Rewiring stale frame listener for restored session');
      this.frameListeners.delete(sessionId);
    }

    const FORWARDED_FRAME_TYPES = new Set([
      'focus_changed',
      'seed_ansi',
      'resize_jiggle',
      'full_history',
    ]);
    const listener = (frame: FrameEvent) => {
      if (FORWARDED_FRAME_TYPES.has(frame.type)) {
        this.server
          .to(`terminal:${sessionId}`)
          .emit('message', createEnvelope(`terminal/${sessionId}`, frame.type, frame.payload));
      }
    };
    session.stream.on('frame', listener);
    this.frameListeners.set(sessionId, { session, listener });
  }

  private unwireFrameListener(sessionId: string): void {
    const existing = this.frameListeners.get(sessionId);
    if (!existing) return;

    existing.session.stream.off('frame', existing.listener);
    this.frameListeners.delete(sessionId);
  }

  private async handleDeadTmuxSession(sessionId: string, client: Socket): Promise<void> {
    logger.warn({ sessionId }, 'Dead tmux detected — marking session failed');
    this.sessionsService.markSessionFailed(sessionId, 'tmux session no longer exists');
    this.ptyService.stopStreaming(sessionId);
    this.unwireFrameListener(sessionId);
    this.registry.dispose(sessionId);
    this.themeCache.delete(sessionId);
    const ep: SessionStatePayload = {
      sessionId,
      status: 'crashed',
      message: 'Terminal session is no longer available',
    };
    const envelope = createEnvelope(`session/${sessionId}`, 'state_change', ep);
    client.emit('message', envelope);
    this.server.to(`session:${sessionId}`).emit('message', envelope);
  }

  private async ensurePtyStreaming(
    sessionId: string,
    tmuxSessionName: string,
    options?: { cols?: number; rows?: number },
  ): Promise<void> {
    if (this.ptyService.isStreaming(sessionId)) return;
    const alive = await this.terminalIO.sessionExists({ name: tmuxSessionName });
    if (!alive) return;
    await this.ptyService.startStreaming(sessionId, tmuxSessionName, options);
  }

  private trackInputRate(clientId: string, sessionId: string, dataBytes: number): void {
    const key = `${clientId}:${sessionId}`;
    const now = Date.now();
    let entry = this.inputRateTracker.get(key);

    if (!entry) {
      entry = { messages: 0, bytes: 0, windowStart: now, warned: false };
      this.inputRateTracker.set(key, entry);
    }

    const elapsed = now - entry.windowStart;

    if (elapsed >= INPUT_RATE_WINDOW_MS) {
      if (
        !entry.warned &&
        (entry.messages > INPUT_RATE_MSG_THRESHOLD || entry.bytes > INPUT_RATE_BYTES_THRESHOLD)
      ) {
        const windowSec = elapsed / 1000;
        logger.warn(
          {
            clientId,
            sessionId,
            msgRate: Math.round(entry.messages / windowSec),
            byteRate: Math.round(entry.bytes / windowSec),
            messages: entry.messages,
            bytes: entry.bytes,
            windowMs: elapsed,
          },
          'Input rate threshold exceeded',
        );
      }
      entry.messages = 0;
      entry.bytes = 0;
      entry.windowStart = now;
      entry.warned = false;
    }

    entry.messages++;
    entry.bytes += dataBytes;
  }

  onModuleDestroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    for (const sessionId of [...this.frameListeners.keys()]) {
      this.unwireFrameListener(sessionId);
    }
    this.themeCache.clear();
  }
}
