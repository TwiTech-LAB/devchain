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
import { ModuleRef } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import { createLogger } from '../../../common/logging/logger';
import { TerminalStreamService } from '../services/terminal-stream.service';
import { PtyService } from '../services/pty.service';
import { TmuxService } from '../services/tmux.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TerminalSeedService } from '../services/terminal-seed.service';
import { isControlKey, toTmuxKeys } from '../utils/control-keys';
import { SettingsService } from '../../settings/services/settings.service';
import {
  createEnvelope,
  TerminalResizePayload,
  HeartbeatPayload,
  SessionStatePayload,
} from '../dtos/ws-envelope.dto';

const logger = createLogger('TerminalGateway');

interface ClientSession {
  sessionId: string;
  lastHeartbeat: Date;
  subscriptions: Set<string>;
}

/**
 * WebSocket gateway for multiplexed terminal and app events
 */
@WebSocketGateway({
  cors: false, // Local only, no CORS needed
  transports: ['websocket'],
})
@Injectable()
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private clientSessions: Map<string, ClientSession> = new Map();
  // Tracks authoritative client id (by socket id) for each session
  private authorityBySession: Map<string, string> = new Map();
  // Tracks last dimensions per session for deduplication
  private lastDimensions = new Map<string, { cols: number; rows: number }>();
  private heartbeatInterval?: NodeJS.Timeout;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly HEARTBEAT_TIMEOUT = 45000; // 45 seconds

  constructor(
    private readonly streamService: TerminalStreamService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => PtyService))
    private readonly ptyService: PtyService,
    private readonly moduleRef: ModuleRef,
    private readonly seedService: TerminalSeedService,
  ) {}

  afterInit() {
    logger.info('WebSocket gateway initialized');
    this.startHeartbeat();
  }

  handleConnection(@ConnectedSocket() client: Socket) {
    logger.info(
      { clientId: client.id, transport: client.conn.transport.name },
      'Client connected to WebSocket gateway',
    );
    this.clientSessions.set(client.id, {
      sessionId: '',
      lastHeartbeat: new Date(),
      subscriptions: new Set(),
    });

    // Send initial heartbeat
    this.sendHeartbeat(client);

    // DEBUG: Track if client subscribes within 5 seconds
    setTimeout(() => {
      const session = this.clientSessions.get(client.id);
      if (session && session.subscriptions.size === 0) {
        logger.warn(
          { clientId: client.id, connected: client.connected },
          'Client connected but has not subscribed to any topics after 5s',
        );
      }
    }, 5000);
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    logger.info({ clientId: client.id }, 'Client disconnected');

    // Release authority for any sessions owned by this client
    for (const [sessionId, clientId] of this.authorityBySession.entries()) {
      if (clientId === client.id) {
        this.authorityBySession.delete(sessionId);
        // Choose a new authority if any subscriber remains
        const room = this.server.sockets.adapter.rooms.get(`terminal:${sessionId}`);
        const nextClientId = room ? Array.from(room)[0] : undefined;
        if (nextClientId) {
          this.setAuthority(sessionId, nextClientId);
        } else {
          const envelope = createEnvelope(`terminal/${sessionId}`, 'focus_changed', {
            sessionId,
            clientId: null,
          });
          this.server.to(`terminal:${sessionId}`).emit('message', envelope);
        }
      }
    }

    this.clientSessions.delete(client.id);
  }

  /**
   * Subscribe to terminal session
   */
  @SubscribeMessage('terminal:subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { sessionId: string; lastSequence?: number; rows?: number; cols?: number },
  ) {
    const { sessionId, lastSequence, rows, cols } = payload;
    // Note: engine field removed from settings (Chat Mode only)
    const engine = 'chat';
    let sanitize = false;
    try {
      sanitize = this.ptyService.isSanitizerEnabled();
    } catch {}
    logger.info(
      { clientId: client.id, sessionId, lastSequence, rows, cols, engine, sanitize },
      'Client subscribing to session',
    );

    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) {
      return;
    }

    clientSession.sessionId = sessionId;
    // Subscribe to session lifecycle immediately
    clientSession.subscriptions.add(`session/${sessionId}`);
    client.join(`session:${sessionId}`);

    // Initialize buffer if needed
    this.streamService.initializeBuffer(sessionId);

    // Ensure PTY streaming is active for this session
    await this.ensurePtyStreaming(sessionId);

    // Grant focus authority BEFORE resize
    // This ensures the subscribing client can resize immediately
    if (!this.authorityBySession.has(sessionId)) {
      this.setAuthority(sessionId, client.id);
      logger.info({ sessionId, clientId: client.id }, 'Granted authority to subscribing client');
    } else {
      // Take over authority for the new subscribing client
      // This ensures dimensions sync with the active client
      const previousAuthority = this.authorityBySession.get(sessionId);
      this.setAuthority(sessionId, client.id);
      logger.info(
        { sessionId, clientId: client.id, previousAuthority },
        'Transferred authority to subscribing client',
      );
    }

    const isFirstAttach = typeof lastSequence !== 'number';
    const hasResizeDimensions =
      typeof rows === 'number' && rows > 0 && typeof cols === 'number' && cols > 0;

    if (hasResizeDimensions) {
      // Force resize on first attach to ensure dimensions sync
      // Otherwise, smart resize with deduplication
      const forceResize = isFirstAttach;

      this.tryResizePty(sessionId, cols!, rows!, forceResize);

      if (isFirstAttach) {
        // Invalidate cache on first attach to ensure fresh capture with correct dimensions
        this.seedService.invalidateCache(sessionId);

        // Wait briefly for tmux/shell to settle after resize
        await new Promise((resolve) => setTimeout(resolve, 50));

        logger.debug(
          { sessionId, cols, rows },
          'Resized PTY and invalidated cache for first attach (cursor position via tmux)',
        );
      }
    } else if (typeof rows === 'number' || typeof cols === 'number') {
      logger.warn({ sessionId, rows, cols }, 'Ignoring resize request with partial dimensions');
    }
    const { maxBytes: seedMaxBytes } = this.seedService.resolveSeedingConfig();
    logger.info({ sessionId, seedMaxBytes, source: 'tmux-ansi' }, 'Resolved seeding config');

    // OPTIMIZATION: Send subscription confirmation IMMEDIATELY (don't wait for seed)
    // This allows client to start receiving live terminal data right away
    const confirmEnvelope = createEnvelope(`terminal/${sessionId}`, 'subscribed', {
      sessionId,
      currentSequence: this.streamService.getCurrentSequence(sessionId),
    });
    client.emit('message', confirmEnvelope);

    // Join terminal room for live data immediately
    clientSession.subscriptions.add(`terminal/${sessionId}`);
    client.join(`terminal:${sessionId}`);

    // Authority already granted above (before resize)

    // OPTIMIZATION: Seed asynchronously (fire-and-forget, don't block)
    // Client will receive seed shortly after, and queues any live data during seeding
    // Seeding uses tmux ANSI capture as primary source with emulator fallback
    if (isFirstAttach) {
      // Fire-and-forget seeding - don't await
      this.seedService
        .emitSeedToClient({
          client,
          sessionId,
          maxBytes: seedMaxBytes,
          cols,
          rows,
        })
        .catch((error) => {
          logger.error({ sessionId, clientId: client.id, error }, 'Seed failed');
        });
    } else {
      // Reconnection: replay buffered frames
      const bufferedFrames = this.streamService.getFramesSince(sessionId, lastSequence);
      if (bufferedFrames.length > 0) {
        logger.info(
          { clientId: client.id, sessionId, frameCount: bufferedFrames.length },
          'Replaying buffered frames',
        );
        bufferedFrames.forEach((frame) => {
          client.emit('message', frame);
        });
      }
    }
  }

  @SubscribeMessage('events:subscribe')
  handleEventsSubscribe(@ConnectedSocket() client: Socket) {
    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) {
      logger.warn({ clientId: client.id }, 'Skipping events subscribe with no client session');
      return;
    }

    clientSession.subscriptions.add('events/logs');
    const confirmEnvelope = createEnvelope('events/logs', 'subscribed', { ok: true });
    client.emit('message', confirmEnvelope);
  }

  /**
   * Subscribe to chat thread
   */
  @SubscribeMessage('chat:subscribe')
  handleChatSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { threadId: string },
  ) {
    const { threadId } = payload;
    logger.info({ clientId: client.id, threadId }, 'Client subscribing to chat thread');

    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) {
      return;
    }

    clientSession.subscriptions.add(`chat/${threadId}`);
    client.join(`chat:${threadId}`);

    const confirmEnvelope = createEnvelope(`chat/${threadId}`, 'subscribed', { threadId });
    client.emit('message', confirmEnvelope);
  }

  /**
   * Unsubscribe from chat thread
   */
  @SubscribeMessage('chat:unsubscribe')
  handleChatUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { threadId: string },
  ) {
    const { threadId } = payload;
    logger.info({ clientId: client.id, threadId }, 'Client unsubscribing from chat thread');

    const clientSession = this.clientSessions.get(client.id);
    if (clientSession) {
      clientSession.subscriptions.delete(`chat/${threadId}`);
    }

    client.leave(`chat:${threadId}`);
  }

  /**
   * Unsubscribe from terminal session
   */
  @SubscribeMessage('terminal:unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string },
  ) {
    const { sessionId } = payload;
    logger.info({ clientId: client.id, sessionId }, 'Client unsubscribing from session');

    const clientSession = this.clientSessions.get(client.id);
    if (clientSession) {
      clientSession.subscriptions.delete(`terminal/${sessionId}`);
      clientSession.subscriptions.delete(`session/${sessionId}`);
    }

    client.leave(`terminal:${sessionId}`);
    client.leave(`session:${sessionId}`);
  }

  /**
   * Claim focus/resize authority for a session
   */
  @SubscribeMessage('terminal:focus')
  handleFocus(@ConnectedSocket() client: Socket, @MessageBody() payload: { sessionId: string }) {
    const { sessionId } = payload;
    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) {
      logger.warn({ clientId: client.id }, 'Ignoring focus with no client session');
      return;
    }
    if (!clientSession.subscriptions.has(`terminal/${sessionId}`)) {
      logger.warn(
        { clientId: client.id, sessionId },
        'Client not subscribed to session; focus ignored',
      );
      return;
    }
    this.setAuthority(sessionId, client.id);
  }

  /**
   * Handle terminal resize
   */
  @SubscribeMessage('terminal:resize')
  handleResize(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TerminalResizePayload & { sessionId: string },
  ) {
    const { sessionId, rows, cols } = payload;

    // Only authoritative client can resize
    const currentAuthority = this.authorityBySession.get(sessionId);
    if (currentAuthority && currentAuthority !== client.id) {
      logger.debug(
        { clientId: client.id, sessionId, rows, cols, authority: currentAuthority },
        'Ignoring resize from non-authoritative client',
      );
      return;
    }

    // Smart resize with deduplication - only resizes if dimensions changed
    const didResize = this.tryResizePty(sessionId, cols, rows);

    if (didResize) {
      // Broadcast resize to all other clients subscribed to this session
      const envelope = createEnvelope(`terminal/${sessionId}`, 'resize', { rows, cols });
      this.server.to(`terminal:${sessionId}`).emit('message', envelope);
    }
  }

  /**
   * Handle terminal input from client
   * For control characters (like ESC), sends raw keys; for text, uses paste-buffer with bracketed paste mode and submits with Enter
   * If ttyMode is true, sends all characters as raw keys without Enter
   */
  @SubscribeMessage('terminal:input')
  async handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string; data: string; ttyMode?: boolean },
  ) {
    const { sessionId, data, ttyMode = false } = payload;
    logger.debug({ clientId: client.id, sessionId, dataLength: data.length }, 'Terminal input');

    // Get session to find tmux session ID
    const sessionsService = this.moduleRef.get(SessionsService, { strict: false });
    const tmuxService = this.moduleRef.get(TmuxService, { strict: false });

    if (!sessionsService) {
      logger.error({ sessionId }, 'SessionsService not available');
      throw new Error('SessionsService not available');
    }

    if (!tmuxService) {
      logger.error({ sessionId }, 'TmuxService not available');
      throw new Error('TmuxService not available');
    }

    const session = sessionsService.getSession(sessionId);
    if (!session) {
      logger.error({ sessionId }, 'Session not found');
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.tmuxSessionId) {
      logger.error({ sessionId }, 'Session has no tmux session ID');
      throw new Error(`Session has no tmux session ID: ${sessionId}`);
    }

    // Handle special control characters and raw keys differently
    if (isControlKey(data)) {
      // Send raw key sequences directly without paste-buffer processing
      const keys = toTmuxKeys(data);
      await tmuxService.sendKeys(session.tmuxSessionId, keys);
      logger.debug({ sessionId, tmuxSessionId: session.tmuxSessionId, keys }, 'Sent raw keys');
    } else if (ttyMode) {
      // In TTY mode, send characters directly without Enter (for character-by-character transmission)
      // Use tmux send-keys with -l flag to send literal characters
      await tmuxService.sendKeys(session.tmuxSessionId, ['-l', data]);
      logger.debug(
        { sessionId, tmuxSessionId: session.tmuxSessionId, dataLength: data.length },
        'Sent TTY literal keys',
      );
    } else {
      // Use tmux pasteAndSubmit with bracketed paste mode for regular text (form mode)
      // This pastes the text with bracketed paste markers and then sends Enter
      await tmuxService.pasteAndSubmit(session.tmuxSessionId, data, { bracketed: true });
      logger.debug(
        { sessionId, tmuxSessionId: session.tmuxSessionId },
        'Text pasted and submitted',
      );
    }
  }

  /**
   * Check if the input data contains only control characters that should be sent as raw keys
   */
  private isControlCharacter(data: string): boolean {
    return isControlKey(data);
  }

  /**
   * Convert control character data to tmux key sequences
   */
  private convertToTmuxKeys(data: string): string[] {
    const mapped = toTmuxKeys(data);
    if (mapped.length === 1 && mapped[0] === data) {
      logger.warn({ data }, 'Unknown control character, sending as literal');
    }
    return mapped;
  }

  /**
   * Handle request for full history (dynamic loading on scroll).
   *
   * ## maxLines Input Validation Contract (Permissive Coercion)
   *
   * The `maxLines` parameter accepts various input types with the following behavior:
   *
   * | Input Type        | Example    | Result       | Notes                           |
   * |-------------------|------------|--------------|----------------------------------|
   * | Integer           | `100`      | `100`        | Accepted as-is                  |
   * | Float             | `100.7`    | `100`        | Floored to integer              |
   * | Numeric string    | `"100"`    | `100`        | Coerced via `Number()`          |
   * | Float string      | `"100.7"`  | `100`        | Coerced then floored            |
   * | Invalid string    | `"abc"`    | Error        | Throws WsException              |
   * | Zero              | `0`        | Error        | Must be positive                |
   * | Negative          | `-1`       | Error        | Must be positive                |
   * | undefined/null    | -          | `10000`      | Uses default value              |
   *
   * **Validation Rules:**
   * - Uses `Math.floor(Number(input))` for coercion
   * - Rejects non-finite numbers (NaN, Infinity)
   * - Rejects values < 1 (zero and negative)
   * - Final value is clamped to the server's scrollback setting
   *
   * @param client - Connected WebSocket client
   * @param payload - Request payload containing sessionId and optional maxLines
   * @param payload.sessionId - Terminal session to fetch history from
   * @param payload.maxLines - Maximum lines to return (default: 10000, clamped to scrollback)
   * @throws {WsException} When maxLines is invalid (non-numeric, zero, or negative)
   */
  @SubscribeMessage('terminal:request_full_history')
  async handleRequestFullHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string; maxLines?: number },
  ) {
    const { sessionId } = payload;

    // Validate and coerce maxLines input (see JSDoc for contract details)
    let clientMaxLines = 10000; // default
    if (payload.maxLines !== undefined && payload.maxLines !== null) {
      const parsed = Math.floor(Number(payload.maxLines));
      if (!Number.isFinite(parsed) || parsed < 1) {
        logger.warn(
          { clientId: client.id, sessionId, rawMaxLines: payload.maxLines },
          'Invalid maxLines value, must be positive integer',
        );
        throw new WsException('maxLines must be a positive integer');
      }
      clientMaxLines = parsed;
    }

    // Clamp maxLines to effective scrollback setting
    const effectiveScrollback = this.settingsService.getScrollbackLines();
    const maxLines = Math.min(clientMaxLines, effectiveScrollback);

    if (clientMaxLines > effectiveScrollback) {
      logger.warn(
        {
          clientId: client.id,
          sessionId,
          clientMaxLines,
          effectiveScrollback,
          clampedTo: maxLines,
        },
        'Client requested more lines than scrollback setting allows, clamping',
      );
    }

    logger.debug({ clientId: client.id, sessionId, maxLines }, 'Requesting full history');

    // Validate subscription
    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession?.subscriptions.has(`terminal/${sessionId}`)) {
      logger.warn({ sessionId, clientId: client.id }, 'History request from unsubscribed client');
      return;
    }

    // CRITICAL: Capture sequence BEFORE tmux capture
    // This marks the point in time for client-side deduplication
    const capturedSequence = this.streamService.getCurrentSequence(sessionId);
    logger.debug({ sessionId, capturedSequence }, 'Captured sequence for history deduplication');

    // Try to get full history from tmux first (includes all scrollback)
    let history = '';
    try {
      const sessionsService = this.moduleRef.get(SessionsService, { strict: false });
      const tmuxService = this.moduleRef.get(TmuxService, { strict: false });

      if (sessionsService && tmuxService) {
        const session = sessionsService.getSession(sessionId);
        if (session?.tmuxSessionId) {
          logger.info(
            { sessionId, tmuxSessionId: session.tmuxSessionId, maxLines },
            'Capturing full tmux history',
          );

          // Capture full scrollback from tmux with ANSI escape codes
          history = await tmuxService.capturePane(session.tmuxSessionId, maxLines, true);

          if (history && history.length > 0) {
            logger.info(
              { sessionId, historyBytes: history.length },
              'Captured full tmux history successfully',
            );
          }
        }
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to capture tmux history');
    }

    // NOTE: We no longer fall back to the emulator for history.
    // The emulator accumulates TUI content (from apps like Claude Code that don't use
    // alternate screen properly), causing duplicate/garbled history. tmux maintains
    // clean buffer separation, so we only use tmux capture for history requests.
    if (!history || history.length === 0) {
      logger.info({ sessionId }, 'No tmux history available, returning empty history');
    }

    // Trim trailing newline from tmux capture-pane output to avoid extra blank line
    // when reloading history (tmux capture-pane -p adds a final newline)
    if (history.endsWith('\n')) {
      history = history.slice(0, -1);
    }

    // Apply maxBytes guardrail to prevent huge WebSocket payloads.
    //
    // DESIGN DECISION (P1): Shared maxBytes setting for seeding and full-history
    //
    // Both terminal seeding and full-history responses use the same `terminal.seeding.maxBytes`
    // setting (default: 1MB, range: 64KB-4MB). This design was chosen because:
    //
    // 1. Full-history is primarily controlled by `maxLines` (clamped to scrollback setting),
    //    so maxBytes is just a secondary safety limit for WebSocket payload size.
    // 2. Adding a separate `terminal.fullHistory.maxBytes` setting would increase configuration
    //    complexity without significant benefit, since both paths have similar payload concerns.
    // 3. Users who want smaller seeding payloads for fast startup can reduce the shared setting;
    //    full-history will still work but may truncate earlier on very large sessions.
    //
    // If separate control is needed in the future, consider adding `terminal.fullHistory.maxBytes`
    // with its own min/max bounds.
    const { maxBytes } = this.seedService.resolveSeedingConfig();
    let hasHistory = false;
    const historyByteLength = Buffer.byteLength(history, 'utf-8');
    if (historyByteLength > maxBytes) {
      const { truncated, wasTruncated } = this.seedService.truncateToMaxBytes(history, maxBytes);
      history = truncated;
      hasHistory = wasTruncated;
      if (wasTruncated) {
        logger.info(
          { sessionId, originalBytes: historyByteLength, maxBytes, truncatedBytes: history.length },
          'Truncated full history response to fit maxBytes limit',
        );
      }
    }

    // Get cursor position to include in response
    let cursorX: number | undefined;
    let cursorY: number | undefined;

    try {
      const sessionsService = this.moduleRef.get(SessionsService, { strict: false });
      const tmuxService = this.moduleRef.get(TmuxService, { strict: false });

      if (sessionsService && tmuxService) {
        const session = sessionsService.getSession(sessionId);
        if (session?.tmuxSessionId) {
          const cursorPos = await tmuxService.getCursorPosition(session.tmuxSessionId);
          if (cursorPos) {
            cursorX = cursorPos.x;
            cursorY = cursorPos.y;
            logger.debug({ sessionId, cursorX, cursorY }, 'Captured cursor position for history');
          }
        }
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to get cursor position for history');
    }

    // Send response with history, cursor position, hasHistory flag, and capturedSequence
    const envelope = createEnvelope(`terminal/${sessionId}`, 'full_history', {
      history,
      cursorX,
      cursorY,
      hasHistory,
      capturedSequence, // For client-side sequence-based deduplication
    });

    client.emit('message', envelope);
    logger.debug(
      {
        clientId: client.id,
        sessionId,
        historyBytes: history.length,
        cursorX,
        cursorY,
        hasHistory,
        capturedSequence,
      },
      'Sent full ANSI history with cursor position and sequence',
    );
  }

  /**
   * Handle pong (heartbeat response)
   */
  @SubscribeMessage('pong')
  handlePong(@ConnectedSocket() client: Socket) {
    const clientSession = this.clientSessions.get(client.id);
    if (clientSession) {
      clientSession.lastHeartbeat = new Date();
    }
  }

  /**
   * Broadcast terminal data to subscribers
   */
  broadcastTerminalData(sessionId: string, data: string): void {
    const envelope = this.streamService.addFrame(sessionId, data);
    this.server.to(`terminal:${sessionId}`).emit('message', envelope);
  }

  // no-op: history seeding folded into full ANSI snapshot

  /**
   * Broadcast app event
   */
  broadcastEvent(topic: string, type: string, payload: unknown): void {
    const envelope = createEnvelope(topic, type, payload);
    logger.debug({ topic, type }, 'Broadcasting event');
    this.server.emit('message', envelope);
  }

  /**
   * Listen to session.crashed events from TmuxService
   */
  @OnEvent('session.crashed')
  handleSessionCrashed(payload: { sessionId: string; sessionName: string }) {
    const { sessionId, sessionName } = payload;
    logger.info({ sessionId, sessionName }, 'Session crashed - broadcasting to clients');

    const eventPayload: SessionStatePayload = {
      sessionId,
      status: 'crashed',
      message: 'Session unexpectedly terminated',
    };

    const envelope = createEnvelope(`session/${sessionId}`, 'state_change', eventPayload);
    this.server.to(`session:${sessionId}`).emit('message', envelope);

    // Clear buffer after a delay (give clients time to receive the crash event)
    setTimeout(() => {
      this.streamService.clearBuffer(sessionId);
    }, 60000); // 1 minute
  }

  /**
   * Listen to session.started events from SessionsService
   */
  @OnEvent('session.started')
  handleSessionStarted(payload: {
    sessionId: string;
    epicId: string | null;
    agentId: string;
    tmuxSessionName: string;
  }) {
    const { sessionId, epicId, agentId } = payload;
    logger.info({ sessionId, epicId, agentId }, 'Session started - broadcasting to clients');

    const eventPayload: SessionStatePayload = {
      sessionId,
      status: 'started',
      message: 'Session started successfully',
    };

    const envelope = createEnvelope('sessions', 'started', eventPayload);
    this.server.emit('message', envelope);
  }

  /**
   * Listen to session.stopped events from SessionsService
   */
  @OnEvent('session.stopped')
  handleSessionStopped(payload: { sessionId: string }) {
    const { sessionId } = payload;
    logger.info({ sessionId }, 'Session stopped - broadcasting to clients');

    const eventPayload: SessionStatePayload = {
      sessionId,
      status: 'ended',
      message: 'Session terminated',
    };

    const envelope = createEnvelope('sessions', 'stopped', eventPayload);
    this.server.emit('message', envelope);

    // Clear buffer after a delay
    setTimeout(() => {
      this.streamService.clearBuffer(sessionId);
    }, 60000); // 1 minute

    // Invalidate capture cache
    this.seedService.invalidateCache(sessionId);
  }

  // Marker-based MCP events removed; HTTP MCP remains the primary path.

  /**
   * Start heartbeat ping/pong
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();

      this.clientSessions.forEach((session, clientId) => {
        const timeSinceLastHeartbeat = now.getTime() - session.lastHeartbeat.getTime();

        if (timeSinceLastHeartbeat > this.HEARTBEAT_TIMEOUT) {
          logger.warn({ clientId }, 'Client heartbeat timeout - disconnecting');
          const client = this.server.sockets.sockets.get(clientId);
          if (client) {
            client.disconnect(true);
          }
          this.clientSessions.delete(clientId);
        } else {
          // Send ping
          const client = this.server.sockets.sockets.get(clientId);
          if (client) {
            this.sendHeartbeat(client);
          }
        }
      });
    }, this.HEARTBEAT_INTERVAL);

    logger.info({ intervalMs: this.HEARTBEAT_INTERVAL }, 'Heartbeat started');
  }

  /**
   * Send heartbeat to client
   */
  private sendHeartbeat(client: Socket): void {
    const payload: HeartbeatPayload = {
      timestamp: new Date().toISOString(),
    };
    const envelope = createEnvelope('system', 'ping', payload);
    client.emit('message', envelope);
  }

  /**
   * Set authoritative client for a session and broadcast change
   */
  private setAuthority(sessionId: string, clientId: string): void {
    const current = this.authorityBySession.get(sessionId);
    if (current === clientId) return;
    this.authorityBySession.set(sessionId, clientId);
    const focusEnvelope = createEnvelope(`terminal/${sessionId}`, 'focus_changed', {
      sessionId,
      clientId,
    });
    this.server.to(`terminal:${sessionId}`).emit('message', focusEnvelope);
  }

  /**
   * Smart resize with deduplication
   * Only resizes if dimensions have actually changed (unless force is true)
   * Returns true if resize was performed
   */
  private tryResizePty(sessionId: string, cols: number, rows: number, force = false): boolean {
    // Get actual PTY dimensions (source of truth)
    let actualPtyDims: { cols: number; rows: number } | null = null;
    try {
      actualPtyDims = this.ptyService.getDimensions(sessionId);
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to get PTY dimensions, will resize anyway');
    }

    // Check if dimensions actually changed (compare against PTY, not cache)
    if (!force && actualPtyDims && actualPtyDims.cols === cols && actualPtyDims.rows === rows) {
      this.lastDimensions.set(sessionId, { cols, rows }); // Sync cache
      return false;
    }

    // Update tracking and resize PTY
    this.lastDimensions.set(sessionId, { cols, rows });
    logger.debug({ sessionId, cols, rows, forced: force }, 'Resizing PTY');

    // Resize PTY
    this.ptyService.resize(sessionId, cols, rows);

    return true;
  }

  /**
   * Ensure PTY streaming is active for a session
   * If PTY is not streaming but the session is still running, restart it
   */
  private async ensurePtyStreaming(sessionId: string): Promise<void> {
    // Check if PTY is already streaming
    if (this.ptyService.isStreaming(sessionId)) {
      logger.debug({ sessionId }, 'PTY already streaming');
      return;
    }

    logger.info({ sessionId }, 'PTY not streaming, checking if session is still active');

    try {
      // Lazily get SessionsService to avoid circular dependency issues
      const sessionsService = this.moduleRef.get(SessionsService, { strict: false });
      if (!sessionsService) {
        logger.error({ sessionId }, 'SessionsService not available');
        return;
      }

      // Check if session exists and is running
      const session = sessionsService.getSession(sessionId);
      if (!session) {
        logger.warn({ sessionId }, 'Session not found in database');
        return;
      }

      if (session.status !== 'running') {
        logger.warn({ sessionId, status: session.status }, 'Session is not running');
        return;
      }

      if (!session.tmuxSessionId) {
        logger.warn({ sessionId }, 'Session has no tmux session ID');
        return;
      }

      // Lazily get TmuxService
      const tmuxService = this.moduleRef.get(TmuxService, { strict: false });
      if (!tmuxService) {
        logger.error({ sessionId }, 'TmuxService not available');
        return;
      }

      // Check if tmux session still exists
      const tmuxExists = await tmuxService.hasSession(session.tmuxSessionId);
      if (!tmuxExists) {
        logger.warn(
          { sessionId, tmuxSessionId: session.tmuxSessionId },
          'Tmux session no longer exists',
        );
        return;
      }

      // Restart PTY streaming
      logger.info(
        { sessionId, tmuxSessionId: session.tmuxSessionId },
        'Restarting PTY streaming for active session',
      );
      await this.ptyService.startStreaming(sessionId, session.tmuxSessionId);
    } catch (error) {
      logger.error({ sessionId, error }, 'Error ensuring PTY streaming');
    }
  }

  /**
   * Clean up on destroy
   */
  onModuleDestroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }
}
