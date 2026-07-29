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
import { createHash } from 'node:crypto';
import { createLogger } from '../../../common/logging/logger';
import {
  TerminalStreamService,
  type ReconnectReplayResult,
  type SequenceCursor,
} from '../services/terminal-stream.service';
import { PtyService } from '../services/pty.service';
import { TerminalIOService } from '../services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../services/terminal-session/terminal-session-registry';
import { TerminalSeedDelivery, TerminalSeedService } from '../services/terminal-seed.service';
import { isControlKey, toTmuxKeys } from '../utils/control-keys';
import { SettingsService } from '../../settings/services/settings.service';
import {
  createEnvelope,
  FullHistoryRequestPayloadSchema,
  HeartbeatPayload,
  SessionStatePayload,
  SubscribedPayload,
  SubscribedPayloadSchema,
  TerminalResyncAbortPayloadSchema,
  TerminalResyncCompletePayloadSchema,
  TerminalResyncRequestPayloadSchema,
  TerminalPromptPasteInputSchema,
} from '../dtos/ws-envelope.dto';
import type { TerminalPromptPasteAck, TerminalPromptPasteInput } from '../dtos/ws-envelope.dto';
import type { FrameEvent } from '../services/terminal-session/terminal-frame-stream';
import type { TerminalSession } from '../services/terminal-session/terminal-session';
import { SessionsService } from '../../sessions/services/sessions.service';
import { normalizeLineEndings, stripFinalLineEnding } from '../utils/normalize-line-endings';
import { RealtimeBroadcastService } from '../../realtime/services/realtime-broadcast.service';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { SocketStats } from '../../metrics/types/metrics.types';
import {
  TerminalSendAdmission,
  TerminalSendSchedulerService,
  type TerminalSendAdmissionResult,
} from '../services/terminal-send-scheduler.service';

const logger = createLogger('TerminalGateway');

const THEME_HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface ThemeStyle {
  foregroundHex: string;
  backgroundHex: string;
}

interface ClientSession {
  socket: Socket;
  sessionId: string;
  lastHeartbeat: Date;
  subscriptions: Set<string>;
}

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 45000;

// Coalescing window for viewport-mode-restore redraws: collapses simultaneous viewers'
// post-seed/reconnect requests into one resize jiggle, avoiding redraw storms.
const VIEWPORT_RESTORE_COALESCE_MS = 500;
const STOPPED_REPLAY_RETENTION_MS = 60000;

interface LifecycleCleanupPolicy {
  replayRetentionMs: number;
  disposeTerminalState: boolean;
}

const INPUT_RATE_WINDOW_MS = 5000;
const INPUT_RATE_MSG_THRESHOLD = 500; // >100 msg/sec sustained over 5s = 500 msgs in window
const INPUT_RATE_BYTES_THRESHOLD = 512000; // >100KB/sec sustained over 5s = 500KB in window
export const PROMPT_PASTE_RETRY_WINDOW_MS = 60000;
export const PROMPT_PASTE_MAX_REQUESTS_PER_SESSION = 64;

interface InputRateEntry {
  messages: number;
  bytes: number;
  windowStart: number;
  warned: boolean;
}

interface PromptPastePending {
  kind: 'pending';
  sessionId: string;
  requestId: string;
  fingerprint: string;
  promise: Promise<TerminalPromptPasteAck>;
}

interface PromptPasteTombstone {
  kind: 'tombstone';
  sessionId: string;
  requestId: string;
  fingerprint: string;
  outcome: TerminalPromptPasteAck;
  expiresAt: number;
}

type PromptPasteLedgerEntry = PromptPastePending | PromptPasteTombstone;

interface TerminalRecoveryState {
  socketId: string;
  sessionId: string;
  /** The sequence-domain this recovery belongs to; a domain reset retires it. */
  sequenceEpoch: string;
  recoveryEpoch: number;
  phase: 'seeding' | 'tail-catch-up' | 'replacing';
  replacementAttempt: number;
  capturedSequence?: number;
}

/**
 * Classification of a subscribe cursor. The epoch and sequence are treated as required TOGETHER: a
 * correct client sends both (a domain-scoped cursor) or neither (first attach); a bare sequence is a
 * legacy/pre-epoch client and a bare epoch is malformed.
 */
type SubscribeCursor =
  | { kind: 'first-attach' }
  | { kind: 'cursor'; cursor: { sequenceEpoch: string; sequence: number } }
  | { kind: 'legacy-gap'; sequence: number }
  | { kind: 'invalid' };

function classifySubscribeCursor(lastSequence: unknown, sequenceEpoch: unknown): SubscribeCursor {
  const sequence =
    typeof lastSequence === 'number' && Number.isFinite(lastSequence) ? lastSequence : undefined;
  const epoch =
    typeof sequenceEpoch === 'string' && sequenceEpoch.length > 0 ? sequenceEpoch : undefined;
  if (sequence !== undefined && epoch !== undefined) {
    return { kind: 'cursor', cursor: { sequenceEpoch: epoch, sequence } };
  }
  if (sequence !== undefined) return { kind: 'legacy-gap', sequence };
  if (epoch !== undefined) return { kind: 'invalid' };
  return { kind: 'first-attach' };
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
  /** Last viewport-mode-restore redraw per session — coalesces concurrent viewers. */
  private readonly viewportRestoreAt = new Map<string, number>();
  private readonly recoveries = new Map<string, TerminalRecoveryState>();
  private readonly targetedSeedAttempts = new Map<string, symbol>();
  /**
   * In-process at-most-once proof for acknowledged prompt pastes. Normal session retirement must
   * retain these entries because restore may reuse the session ID; module/process teardown is the
   * durability boundary.
   */
  private readonly promptPasteLedger = new Map<string, Map<string, PromptPasteLedgerEntry>>();
  private readonly promptPasteExpiryTimers = new Map<string, NodeJS.Timeout>();

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
    private readonly sendScheduler: TerminalSendSchedulerService,
    private readonly metricsService: MetricsService,
  ) {
    // The stopped-session replay-retention timer is owned by TerminalStreamService (the FrameBuffer
    // owner). Register the gateway-owned expiry side effect — retiring in-flight recoveries bound to
    // the retired sequence-domain — so moving timer ownership does not lose that coupling. A runtime
    // callback (not a constructor edge) keeps the service → gateway direction acyclic.
    this.streamService.setClearExpiryHandler((sessionId) =>
      this.retireSessionRecoveries(sessionId),
    );
  }

  afterInit() {
    this.realtimeBroadcast.setServer(this.server);
    this.metricsService.registerStatsProvider('sockets', () => this.getSocketStats());
    logger.info('WebSocket gateway initialized');
    this.startHeartbeat();
  }

  getSocketStats(): SocketStats {
    return {
      connectedClients: this.clientSessions.size,
      ...this.sendScheduler.getStats(),
      ...(this.seedService.getCaptureStats?.() ?? {}),
    };
  }

  handleConnection(client: Socket) {
    logger.info(
      { clientId: client.id, transport: client.conn?.transport?.name },
      'Client connected',
    );
    this.clientSessions.set(client.id, {
      socket: client,
      sessionId: '',
      lastHeartbeat: new Date(),
      subscriptions: new Set(),
    });
    this.sendScheduler.registerSocket(client);
    this.sendHeartbeat(client);
  }

  handleDisconnect(client: Socket) {
    logger.info({ clientId: client.id }, 'Client disconnected');
    this.releaseClientSession(client.id);
  }

  /**
   * Release every terminal authority a client held, then drop its tracking. Idempotent — safe
   * to call twice (double-disconnect, or a heartbeat kill that also triggers handleDisconnect).
   *
   * Sweeps the UNION of session ids drawn from the client's `session/<id>` AND `terminal/<id>`
   * subscription entries PLUS the singular `clientSession.sessionId`. The prefixes matter: a
   * subscribe adds `session/<id>` BEFORE the latch but `terminal/<id>` only AFTER the 50ms seed
   * settle, so a client that latches authority then dies inside that window holds only
   * `session/<id>`. A terminal/-only sweep would leak that authority and wedge the session — the
   * latch would then see `authority !== null` forever and no later subscriber could apply
   * geometry or send input until a live focusin steal.
   */
  private releaseClientSession(clientId: string): void {
    const clientSession = this.clientSessions.get(clientId);
    if (clientSession) {
      const sessionIds = new Set<string>();
      if (clientSession.sessionId) sessionIds.add(clientSession.sessionId);
      for (const sub of clientSession.subscriptions) {
        if (sub.startsWith('session/')) sessionIds.add(sub.slice('session/'.length));
        else if (sub.startsWith('terminal/')) sessionIds.add(sub.slice('terminal/'.length));
      }
      for (const sessionId of sessionIds) {
        this.registry.get(sessionId)?.unsubscribe(clientId);
      }
    }
    this.pruneInputRateEntries((key) => key.startsWith(`${clientId}:`));
    for (const [key, recovery] of this.recoveries) {
      if (recovery.socketId === clientId) this.recoveries.delete(key);
    }
    for (const key of this.targetedSeedAttempts.keys()) {
      if (key.startsWith(`${clientId}:`)) this.targetedSeedAttempts.delete(key);
    }
    this.sendScheduler.removeSocket(clientId);
    this.clientSessions.delete(clientId);
  }

  // ── Subscribe / Unsubscribe ─────────────────────────────────────────

  @SubscribeMessage('terminal:subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      sessionId: string;
      lastSequence?: number;
      sequenceEpoch?: string;
      rows?: number;
      cols?: number;
    },
  ) {
    const { sessionId, lastSequence, sequenceEpoch, rows, cols } = payload;
    logger.info(
      { clientId: client.id, sessionId, lastSequence, sequenceEpoch, rows, cols },
      'Client subscribing',
    );

    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession) return;

    // Cancel any pending stopped-session replay cleanup SYNCHRONOUSLY, before buffer init or any
    // await: a quick stop→resubscribe must keep the live sequence-domain (epoch, sequence, recovery
    // counter) instead of letting the old retention timer clear a buffer we are about to reuse.
    this.cancelReplayCleanup(sessionId);

    clientSession.sessionId = sessionId;
    clientSession.subscriptions.add(`session/${sessionId}`);
    client.join(`session:${sessionId}`);
    this.streamService.initializeBuffer(sessionId);

    const cursor = classifySubscribeCursor(lastSequence, sequenceEpoch);

    const session = this.registry.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No registry entry — using fallback seed path');
      const decision = this.resolveSubscribeReplay(sessionId, cursor);
      this.emitSubscribed(
        client,
        sessionId,
        decision.cursorSnapshot.currentSequence,
        decision.replayStatus,
        decision.cursorSnapshot.sequenceEpoch,
      );
      clientSession.subscriptions.add(`terminal/${sessionId}`);
      client.join(`terminal:${sessionId}`);
      this.streamService.resumeRetention(sessionId);
      await this.applySubscribeReplay(client, sessionId, cursor, decision, cols, rows, false);
      return;
    }

    const tmuxAlive = await this.terminalIO.sessionExists({ name: session.tmuxSessionName });
    if (!tmuxAlive) {
      await this.handleDeadTmuxSession(sessionId, client);
      return;
    }

    await this.ensurePtyStreaming(sessionId, session.tmuxSessionName, { cols, rows });

    // A seed attach reseeds from a fresh capture (first attach, or an invalid/malformed cursor).
    const isSeedAttach = cursor.kind === 'first-attach' || cursor.kind === 'invalid';
    const validDims = typeof rows === 'number' && rows > 0 && typeof cols === 'number' && cols > 0;
    // Gate the pty geometry apply on the initial-authority latch: exactly one subscriber wins
    // per session lifecycle, so a reconnect/mount burst flips geometry ONCE instead of per view.
    // Losers (and dimensionless subscribes) fall through to subscribe()'s first-subscriber grant.
    // Seed-invalidation + the 50ms settle bind to a seed attach that also won authority — two
    // independent predicates: a reconnecting winner resizes without invalidating; a seed-attach
    // loser does neither and seeds at the winner's width.
    let wonInitialAuthority = false;
    if (validDims && session.claimInitialAuthority(client.id)) {
      wonInitialAuthority = true;
      this.ptyService.resize(sessionId, cols, rows);
      if (isSeedAttach) {
        this.seedService.invalidateCache(sessionId);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Post-await liveness guard: the awaits above (sessionExists, ensurePtyStreaming, the 50ms
    // seed settle) can resume after the client already disconnected. Bail before wiring/subscribing;
    // the disconnect sweep releases any latched authority keyed on the now-dead client id.
    if (!this.clientSessions.has(client.id)) {
      logger.info({ sessionId, clientId: client.id }, 'Client gone mid-subscribe — skipping');
      return;
    }

    // Resolve the replay AFTER the settle so the ack's epoch + sequence and the replay decision come
    // from one post-settle read of the live domain.
    const decision = this.resolveSubscribeReplay(sessionId, cursor);

    this.emitSubscribed(
      client,
      sessionId,
      decision.cursorSnapshot.currentSequence,
      decision.replayStatus,
      decision.cursorSnapshot.sequenceEpoch,
    );
    clientSession.subscriptions.add(`terminal/${sessionId}`);
    client.join(`terminal:${sessionId}`);

    this.wireFrameListener(sessionId);
    // Forward the latched grant now that the listener is wired and the socket has joined
    // terminal:<id>. subscribe() below no-ops its own grant for the winner (authority already
    // set), so this is the sole focus_changed for an initial latch grant.
    if (wonInitialAuthority) {
      session.notifyInitialAuthority(client.id);
    }
    session.subscribe(client.id);
    this.streamService.resumeRetention(sessionId);

    await this.applySubscribeReplay(client, sessionId, cursor, decision, cols, rows, true);
  }

  /**
   * Resolve the `subscribed` ack fields and the replay decision from ONE atomic read of the live
   * domain. A domain-scoped cursor is classified epoch-aware (same domain → replay by number, a
   * retired domain → gap); a legacy bare-sequence cursor is a deterministic gap; first attach and an
   * invalid cursor reseed.
   */
  private resolveSubscribeReplay(
    sessionId: string,
    cursor: SubscribeCursor,
  ): {
    replayStatus: SubscribedPayload['replayStatus'];
    cursorSnapshot: SequenceCursor;
    replay?: ReconnectReplayResult;
  } {
    switch (cursor.kind) {
      case 'cursor': {
        const replay = this.streamService.getReconnectReplay(sessionId, cursor.cursor);
        return {
          replayStatus: replay.status,
          cursorSnapshot: {
            sequenceEpoch: replay.sequenceEpoch,
            currentSequence: replay.currentSequence,
          },
          replay,
        };
      }
      case 'legacy-gap':
        return { replayStatus: 'gap', cursorSnapshot: this.streamService.sampleCursor(sessionId) };
      case 'first-attach':
      case 'invalid':
        return { replayStatus: 'seed', cursorSnapshot: this.streamService.sampleCursor(sessionId) };
    }
  }

  /** Deliver the seed / covered replay / resync for a classified subscribe, after the ack. */
  private async applySubscribeReplay(
    client: Socket,
    sessionId: string,
    cursor: SubscribeCursor,
    decision: { cursorSnapshot: SequenceCursor; replay?: ReconnectReplayResult },
    cols: number | undefined,
    rows: number | undefined,
    restoreViewportOnCovered: boolean,
  ): Promise<void> {
    switch (cursor.kind) {
      case 'first-attach':
      case 'invalid':
        // An invalid (malformed) cursor reseeds exactly like a first attach.
        if (cursor.kind === 'invalid') {
          logger.warn({ sessionId, clientId: client.id }, 'Invalid subscribe cursor — reseeding');
        }
        await this.emitTargetedSeed(client, sessionId, cols, rows);
        return;
      case 'legacy-gap':
        await this.emitReplayResync(
          client,
          sessionId,
          cursor.sequence,
          { status: 'gap', currentSequence: decision.cursorSnapshot.currentSequence },
          cols,
          rows,
        );
        return;
      case 'cursor': {
        const replay = decision.replay;
        if (!replay) return;
        if (replay.status === 'covered') {
          for (const frame of replay.frames) this.enqueueLiveOrRecover(client, sessionId, frame);
          // NO-SEED / post-restart attach: there is no client-side seed window to discard a
          // redraw, so restore alt-screen + mouse modes now — sequenced AFTER ensurePtyStreaming
          // so triggerRedraw isn't a no-op on a freshly-rehydrated PTY. The seeded first attach
          // instead requests this from the client post-seed (terminal:restore_viewport_modes).
          if (restoreViewportOnCovered) this.maybeRestoreViewportModes(sessionId);
        } else {
          await this.emitReplayResync(
            client,
            sessionId,
            cursor.cursor.sequence,
            replay,
            cols,
            rows,
          );
        }
        return;
      }
    }
  }

  /**
   * Emit the validated `subscribed` acknowledgement for both the normal and fallback
   * attach paths. `historyRefreshable` is the immutable provider refresh capability
   * (line-oriented providers can reload primary-buffer history; alternate-screen TUIs
   * cannot) — published here, separate from the per-snapshot `hasHistory` on seeds.
   */
  private emitSubscribed(
    client: Socket,
    sessionId: string,
    currentSequence: number,
    replayStatus: SubscribedPayload['replayStatus'],
    sequenceEpoch: string,
  ): void {
    const payload = SubscribedPayloadSchema.parse({
      sessionId,
      currentSequence,
      sequenceEpoch,
      replayStatus,
      historyRefreshable: !this.sessionsService.usesAlternateScreenFor(sessionId),
    });
    client.emit('message', createEnvelope(`terminal/${sessionId}`, 'subscribed', payload));
  }

  private async emitReplayResync(
    client: Socket,
    sessionId: string,
    requestedSequence: number,
    replay: {
      status: 'gap';
      currentSequence: number;
      earliestAvailableSequence?: number;
    },
    cols?: number,
    rows?: number,
  ): Promise<void> {
    client.emit(
      'message',
      createEnvelope(`terminal/${sessionId}`, 'resync_required', {
        sessionId,
        requestedSequence,
        currentSequence: replay.currentSequence,
        earliestAvailableSequence: replay.earliestAvailableSequence,
      }),
    );

    await this.startRecovery(client, sessionId, cols, rows);
  }

  private async emitTargetedSeed(
    client: Socket,
    sessionId: string,
    cols?: number,
    rows?: number,
  ): Promise<void> {
    const { maxBytes } = this.seedService.resolveSeedingConfig();
    const recoveryKey = this.recoveryKey(client.id, sessionId);
    const seedAttempt = Symbol();
    this.targetedSeedAttempts.set(recoveryKey, seedAttempt);
    let failedAdmission: TerminalSendAdmissionResult | undefined;
    try {
      await this.seedService.emitSeedToClient({
        deliver: (envelope) => {
          const clientSession = this.clientSessions.get(client.id);
          if (
            this.targetedSeedAttempts.get(recoveryKey) !== seedAttempt ||
            !clientSession?.subscriptions.has(`terminal/${sessionId}`) ||
            this.recoveries.has(recoveryKey)
          ) {
            return TerminalSeedDelivery.Abort;
          }
          const admission = this.sendScheduler.enqueueRecovery(client, envelope);
          if (admission === TerminalSendAdmission.Accepted) {
            return TerminalSeedDelivery.Continue;
          }
          failedAdmission ??= admission;
          return TerminalSeedDelivery.Abort;
        },
        sessionId,
        maxBytes,
        cols,
        rows,
        // A successful empty first capture must still complete the client's seed attempt:
        // allowEmpty routes it to a non-writing `seed_empty` carrying this baseline sequence.
        allowEmpty: true,
        getCurrentSequence: () => this.streamService.getCurrentSequence(sessionId),
      });
      if (
        failedAdmission &&
        this.targetedSeedAttempts.get(recoveryKey) === seedAttempt &&
        this.clientSessions.get(client.id)?.subscriptions.has(`terminal/${sessionId}`)
      ) {
        logger.warn(
          { sessionId, clientId: client.id, admission: failedAdmission },
          'Initial targeted seed admission failed; starting bounded recovery',
        );
        await this.startRecovery(client, sessionId, cols, rows);
      }
    } catch (error) {
      logger.error({ sessionId, clientId: client.id, error }, 'Targeted terminal seed failed');
    } finally {
      if (this.targetedSeedAttempts.get(recoveryKey) === seedAttempt) {
        this.targetedSeedAttempts.delete(recoveryKey);
      }
    }
  }

  @SubscribeMessage('terminal:resync_request')
  async handleResyncRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
  ): Promise<void> {
    const parsed = TerminalResyncRequestPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const { sessionId } = parsed.data;
    const clientSession = this.clientSessions.get(client.id);
    if (!clientSession?.subscriptions.has(`terminal/${sessionId}`)) return;
    await this.startRecovery(client, sessionId);
  }

  @SubscribeMessage('terminal:resync_abort')
  handleResyncAbort(@ConnectedSocket() client: Socket, @MessageBody() payload: unknown): boolean {
    const parsed = TerminalResyncAbortPayloadSchema.safeParse(payload);
    if (!parsed.success) return false;
    const { sessionId, sequenceEpoch, recoveryEpoch } = parsed.data;
    const key = this.recoveryKey(client.id, sessionId);
    const state = this.recoveries.get(key);
    // Require the (sequenceEpoch, recoveryEpoch) pair to match the live recovery: an abort carrying
    // a retired domain's epoch — or none — cannot cancel a recovery that now belongs to a fresh
    // domain. `isCurrentRecovery` also rejects the case where the pair still matches a lingering
    // old-domain state but the stream epoch has already moved on, so the abort cannot remove the new
    // domain's lane.
    if (
      !state ||
      !this.isCurrentRecovery(state) ||
      state.phase !== 'seeding' ||
      state.sequenceEpoch !== sequenceEpoch ||
      state.recoveryEpoch !== recoveryEpoch
    ) {
      return false;
    }

    this.recoveries.delete(key);
    this.sendScheduler.removeLane(client.id, sessionId);
    return true;
  }

  @SubscribeMessage('terminal:resync_complete')
  handleResyncComplete(@ConnectedSocket() client: Socket, @MessageBody() payload: unknown): void {
    const parsed = TerminalResyncCompletePayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const completion = parsed.data;
    const state = this.recoveries.get(this.recoveryKey(client.id, completion.sessionId));
    // Require the full (sequenceEpoch, recoveryEpoch, capturedSequence) triple to match the live
    // recovery so an old-domain completion cannot finalize recovery in a new domain.
    // `isCurrentRecovery` additionally rejects a completion whose pair still matches a lingering
    // old-domain state after the stream epoch has moved on, so it cannot synchronize the new lane.
    if (
      !state ||
      !this.isCurrentRecovery(state) ||
      state.phase !== 'seeding' ||
      state.sequenceEpoch !== completion.sequenceEpoch ||
      state.recoveryEpoch !== completion.recoveryEpoch ||
      state.capturedSequence !== completion.capturedSequence
    ) {
      return;
    }

    state.phase = 'tail-catch-up';
    this.deliverCoveredTail(client, state, completion.capturedSequence);
  }

  private async startRecovery(
    client: Socket,
    sessionId: string,
    cols?: number,
    rows?: number,
  ): Promise<void> {
    const key = this.recoveryKey(client.id, sessionId);
    this.targetedSeedAttempts.delete(key);
    if (this.recoveries.has(key)) return;
    await this.launchRecovery(client, sessionId, cols, rows);
  }

  private enqueueLiveOrRecover(
    client: Socket,
    sessionId: string,
    envelope: Parameters<TerminalSendSchedulerService['enqueueLive']>[1],
  ): void {
    const admission = this.sendScheduler.enqueueLive(client, envelope);
    if (admission === TerminalSendAdmission.NewlyDesynchronized) {
      void this.startRecovery(client, sessionId);
    }
  }

  private async launchRecovery(
    client: Socket,
    sessionId: string,
    cols?: number,
    rows?: number,
    replacementAttempt: number = 0,
  ): Promise<void> {
    // The recovery counter lives in the FrameBuffer, so it survives a quick stop→restore (same
    // domain: A/6 → A/7) and resets only when a new domain is minted (B/1). Sample the domain epoch
    // atomically with allocating the counter — both read/mutate the same live buffer.
    const sequenceEpoch = this.streamService.sampleCursor(sessionId).sequenceEpoch;
    const recoveryEpoch = this.streamService.nextRecoveryCounter(sessionId);
    const state: TerminalRecoveryState = {
      socketId: client.id,
      sessionId,
      sequenceEpoch,
      recoveryEpoch,
      phase: 'seeding',
      replacementAttempt,
    };
    this.recoveries.set(this.recoveryKey(client.id, sessionId), state);
    if (!this.sendScheduler.beginRecovery(client, sessionId, recoveryEpoch)) {
      this.disconnectUnrecoverableRecovery(client, state, 'recovery_begin_rejected');
      return;
    }
    this.seedService.invalidateCache(sessionId);

    const { maxBytes } = this.seedService.resolveSeedingConfig();
    let admissionFailed = false;
    try {
      const watermark = await this.seedService.emitSeedToClient({
        deliver: (envelope) => {
          if (!this.isCurrentRecovery(state)) return TerminalSeedDelivery.Abort;
          const admission = this.sendScheduler.enqueueRecovery(client, envelope);
          if (admission !== TerminalSendAdmission.Accepted) {
            admissionFailed = true;
            return TerminalSeedDelivery.Abort;
          }
          return TerminalSeedDelivery.Continue;
        },
        sessionId,
        maxBytes,
        cols,
        rows,
        allowEmpty: true,
        recovery: {
          sequenceEpoch,
          recoveryEpoch,
          getCurrentSequence: () => this.streamService.getCurrentSequence(sessionId),
          onCapturedSequence: (capturedSequence) => {
            if (this.isCurrentRecovery(state)) state.capturedSequence = capturedSequence;
          },
        },
      });
      if (!this.isCurrentRecovery(state)) return;
      if (admissionFailed) {
        this.disconnectUnrecoverableRecovery(client, state, 'recovery_seed_admission_failed');
        return;
      }
      if (!watermark) {
        this.disconnectUnrecoverableRecovery(client, state, 'recovery_seed_capture_failed');
        return;
      }
      state.capturedSequence = watermark.capturedSequence;
    } catch (error) {
      logger.error(
        { sessionId, clientId: client.id, recoveryEpoch, error },
        'Targeted recovery seed failed',
      );
      this.disconnectUnrecoverableRecovery(client, state, 'recovery_seed_failed');
    }
  }

  private deliverCoveredTail(
    client: Socket,
    state: TerminalRecoveryState,
    afterSequence: number,
  ): void {
    if (!this.isCurrentRecovery(state)) return;
    const replay = this.streamService.getFramesSince(state.sessionId, afterSequence);
    if (replay.status === 'gap') {
      this.scheduleReplacementSeed(client, state);
      return;
    }

    if (replay.frames.length === 0) {
      this.finishRecovery(state);
      return;
    }

    for (let index = 0; index < replay.frames.length; index += 1) {
      const isLast = index === replay.frames.length - 1;
      const admission = this.sendScheduler.enqueueRecovery(
        client,
        replay.frames[index],
        isLast ? () => this.deliverCoveredTail(client, state, replay.currentSequence) : undefined,
      );
      if (admission !== TerminalSendAdmission.Accepted) {
        this.disconnectUnrecoverableRecovery(client, state, 'recovery_tail_admission_failed');
        return;
      }
    }
  }

  private scheduleReplacementSeed(client: Socket, state: TerminalRecoveryState): void {
    if (!this.isCurrentRecovery(state) || state.phase === 'replacing') return;
    if (state.replacementAttempt >= 1) {
      this.disconnectUnrecoverableRecovery(client, state, 'recovery_tail_gap_repeated');
      return;
    }
    state.phase = 'replacing';
    void this.launchRecovery(client, state.sessionId, undefined, undefined, 1);
  }

  private disconnectUnrecoverableRecovery(
    client: Socket,
    state: TerminalRecoveryState,
    reason: string,
  ): void {
    if (!this.isCurrentRecovery(state)) return;
    logger.warn(
      {
        clientId: client.id,
        sessionId: state.sessionId,
        recoveryEpoch: state.recoveryEpoch,
        reason,
      },
      'Terminal recovery failed closed; disconnecting affected socket',
    );
    this.recoveries.delete(this.recoveryKey(state.socketId, state.sessionId));
    client.conn.close();
    this.releaseClientSession(client.id);
  }

  private finishRecovery(state: TerminalRecoveryState): void {
    if (!this.isCurrentRecovery(state)) return;
    this.sendScheduler.markSynchronized(state.socketId, state.sessionId, state.recoveryEpoch);
    this.recoveries.delete(this.recoveryKey(state.socketId, state.sessionId));
  }

  private isCurrentRecovery(state: TerminalRecoveryState): boolean {
    // Map identity alone is not enough: a recovery started before a domain reset (e.g. a stopped
    // session's delayed replay-buffer expiry) can linger in the map after its sequence-domain is
    // retired. Every continuation must also confirm the stream's CURRENT epoch still equals the
    // recovery's, so an old-domain seed/tail/callback cannot enqueue frames, synchronize, or cancel a
    // lane in the new domain. A cleared buffer reports `undefined`, which never matches.
    return (
      this.recoveries.get(this.recoveryKey(state.socketId, state.sessionId)) === state &&
      this.streamService.getSequenceEpoch(state.sessionId) === state.sequenceEpoch
    );
  }

  private recoveryKey(socketId: string, sessionId: string): string {
    return `${socketId}:${sessionId}`;
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
    const recoveryKey = this.recoveryKey(client.id, sessionId);
    this.recoveries.delete(recoveryKey);
    this.targetedSeedAttempts.delete(recoveryKey);
    this.sendScheduler.removeLane(client.id, sessionId);
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
        // Gate the SIGWINCH redraw jiggle on the provider's alt-screen policy. A non-alt-screen
        // Ink TUI (claude/codex) repaints its transcript tail into scrollback at the resized
        // geometry, baking duplicated history. tmux window style + the dedup cache stay ungated
        // for every provider — only the jiggle is skipped (mirrors maybeRestoreViewportModes).
        if (this.sessionsService.usesAlternateScreenFor(sessionId)) {
          void this.ptyService.triggerRedraw(sessionId);
        } else {
          logger.debug({ sessionId }, 'terminal_theme_redraw_skipped_non_altscreen');
        }
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
    if (result.ptyDimensions) {
      this.ptyService.resize(sessionId, result.ptyDimensions.cols, result.ptyDimensions.rows);
      this.server.to(`terminal:${sessionId}`).emit(
        'message',
        createEnvelope(`terminal/${sessionId}`, 'resize', {
          rows: result.ptyDimensions.rows,
          cols: result.ptyDimensions.cols,
        }),
      );
    }
  }

  @SubscribeMessage('terminal:input')
  async handleInput(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload:
      | { sessionId: string; data: string; ttyMode?: boolean; kind?: never }
      | TerminalPromptPasteInput,
  ): Promise<void | TerminalPromptPasteAck> {
    if (payload.kind === 'prompt-paste') {
      return this.handlePromptPasteInput(client, payload);
    }

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

  private handlePromptPasteInput(
    client: Socket,
    rawPayload: TerminalPromptPasteInput,
  ): Promise<TerminalPromptPasteAck> {
    const parsed = TerminalPromptPasteInputSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return Promise.resolve({
        ok: false,
        code: 'INVALID_REQUEST',
        requestId:
          typeof (rawPayload as { requestId?: unknown }).requestId === 'string'
            ? rawPayload.requestId
            : '',
      });
    }

    const payload = parsed.data;
    const session = this.registry.get(payload.sessionId);
    if (!session) {
      return Promise.resolve(this.promptPasteFailure(payload.requestId, 'UNKNOWN_SESSION'));
    }
    if (!session.hasSubscriber(client.id)) {
      return Promise.resolve(this.promptPasteFailure(payload.requestId, 'NOT_SUBSCRIBER'));
    }
    if (session.getAuthority() !== client.id) {
      return Promise.resolve(this.promptPasteFailure(payload.requestId, 'NOT_AUTHORITY'));
    }

    this.trackInputRate(client.id, payload.sessionId, payload.data.length);

    const fingerprint = createHash('sha256').update(payload.data, 'utf8').digest('hex');
    const requests = this.getPromptPasteRequests(payload.sessionId);
    this.pruneExpiredPromptPastes(payload.sessionId, requests);

    const existing = requests.get(payload.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(this.promptPasteFailure(payload.requestId, 'REQUEST_CONFLICT'));
      }
      return existing.kind === 'pending' ? existing.promise : Promise.resolve(existing.outcome);
    }

    if (requests.size >= PROMPT_PASTE_MAX_REQUESTS_PER_SESSION) {
      return Promise.resolve(this.promptPasteFailure(payload.requestId, 'BUSY'));
    }

    let settle!: (outcome: TerminalPromptPasteAck) => void;
    const promise = new Promise<TerminalPromptPasteAck>((resolve) => {
      settle = resolve;
    });
    const pending: PromptPastePending = {
      kind: 'pending',
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      fingerprint,
      promise,
    };

    // Publish the single-flight promise before sessionExists/delivery reaches its first await.
    requests.set(payload.requestId, pending);
    void this.executePromptPaste(session, client, payload).then((outcome) => {
      const current = requests.get(payload.requestId);
      if (current === pending) {
        const expiresAt = Date.now() + PROMPT_PASTE_RETRY_WINDOW_MS;
        requests.set(payload.requestId, {
          kind: 'tombstone',
          sessionId: payload.sessionId,
          requestId: payload.requestId,
          fingerprint,
          outcome,
          expiresAt,
        });
        this.schedulePromptPasteExpiry(payload.sessionId, payload.requestId, expiresAt);
      }
      settle(outcome);
    });

    return promise;
  }

  private async executePromptPaste(
    session: TerminalSession,
    client: Socket,
    payload: TerminalPromptPasteInput,
  ): Promise<TerminalPromptPasteAck> {
    try {
      const target = { name: session.tmuxSessionName };
      const tmuxAlive = await this.terminalIO.sessionExists(target);
      if (!tmuxAlive) {
        await this.handleDeadTmuxSession(payload.sessionId, client);
        return this.promptPasteFailure(payload.requestId, 'TMUX_UNAVAILABLE');
      }

      session.signalInput();
      await this.terminalIO.deliverImmediate(target, payload.data, {
        bracketed: true,
        submitKeys: [],
      });
      return { ok: true, code: 'OK', requestId: payload.requestId };
    } catch (error) {
      logger.warn(
        { sessionId: payload.sessionId, requestId: payload.requestId, error: String(error) },
        'Prompt paste delivery failed',
      );
      return this.promptPasteFailure(payload.requestId, 'DELIVERY_ERROR');
    }
  }

  private promptPasteFailure(
    requestId: string,
    code: Exclude<TerminalPromptPasteAck, { ok: true }>['code'],
  ): TerminalPromptPasteAck {
    return { ok: false, code, requestId };
  }

  private getPromptPasteRequests(sessionId: string): Map<string, PromptPasteLedgerEntry> {
    const existing = this.promptPasteLedger.get(sessionId);
    if (existing) return existing;
    const requests = new Map<string, PromptPasteLedgerEntry>();
    this.promptPasteLedger.set(sessionId, requests);
    return requests;
  }

  private pruneExpiredPromptPastes(
    sessionId: string,
    requests: Map<string, PromptPasteLedgerEntry>,
  ): void {
    const now = Date.now();
    for (const [requestId, entry] of requests) {
      if (entry.kind === 'tombstone' && entry.expiresAt <= now) {
        requests.delete(requestId);
        const timerKey = this.promptPasteTimerKey(sessionId, requestId);
        const timer = this.promptPasteExpiryTimers.get(timerKey);
        if (timer) clearTimeout(timer);
        this.promptPasteExpiryTimers.delete(timerKey);
      }
    }
  }

  private schedulePromptPasteExpiry(sessionId: string, requestId: string, expiresAt: number): void {
    const timerKey = this.promptPasteTimerKey(sessionId, requestId);
    const existing = this.promptPasteExpiryTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        this.promptPasteExpiryTimers.delete(timerKey);
        const requests = this.promptPasteLedger.get(sessionId);
        const entry = requests?.get(requestId);
        if (entry?.kind === 'tombstone' && entry.expiresAt <= Date.now()) {
          requests?.delete(requestId);
          if (requests?.size === 0) this.promptPasteLedger.delete(sessionId);
        }
      },
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref();
    this.promptPasteExpiryTimers.set(timerKey, timer);
  }

  private promptPasteTimerKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  @SubscribeMessage('terminal:request_full_history')
  async handleRequestFullHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { sessionId: string; maxLines?: number; correlationId?: string },
  ) {
    const { sessionId } = payload;

    // Validate the optional correlation token without disturbing the bespoke maxLines
    // error contract below; a malformed token is rejected rather than silently echoed.
    const correlationParse = FullHistoryRequestPayloadSchema.shape.correlationId.safeParse(
      payload.correlationId,
    );
    if (!correlationParse.success) {
      throw new WsException('correlationId must be a string');
    }
    const correlationId = correlationParse.data;

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

    const target = { name: session.tmuxSessionName };

    // Sample the domain epoch before capture; if it changes across the capture/cursor awaits the
    // snapshot belongs to a retired domain and its lower `capturedSequence` would mislead the
    // client, so we drop the response rather than emit under the wrong (or new) epoch.
    const beforeEpoch = this.streamService.sampleCursor(sessionId).sequenceEpoch;

    const captureResult = await this.terminalIO.captureHistory(target, maxLines, true);
    // Sample the sequence AFTER the tmux capture completes (and before the cursor
    // lookup): frames stamped while capture-pane ran are already inside the snapshot,
    // so they must fall at or below capturedSequence or the client replays them on
    // top of the snapshot and duplicates the tail.
    const capturedSequence = this.streamService.getCurrentSequence(sessionId);
    let history = captureResult.ok ? captureResult.output : '';
    history = normalizeLineEndings(stripFinalLineEnding(history));

    const { maxBytes } = this.seedService.resolveSeedingConfig();
    let hasHistory = false;
    if (Buffer.byteLength(history, 'utf-8') > maxBytes) {
      const { truncated, wasTruncated } = this.seedService.truncateToMaxBytes(history, maxBytes);
      history = truncated;
      hasHistory = wasTruncated;
    }
    const cursorPos = await this.terminalIO.getCursorPosition(target);

    const afterEpoch = this.streamService.sampleCursor(sessionId).sequenceEpoch;
    if (afterEpoch !== beforeEpoch) {
      logger.warn(
        { sessionId, beforeEpoch, afterEpoch },
        'Sequence domain changed during full_history capture; dropping response',
      );
      return;
    }

    client.emit(
      'message',
      createEnvelope(`terminal/${sessionId}`, 'full_history', {
        history,
        cursorX: cursorPos?.x,
        cursorY: cursorPos?.y,
        hasHistory,
        capturedSequence,
        // The (unchanged) domain this snapshot belongs to, so the client can accept a fresh
        // domain's lower `capturedSequence` instead of suppressing it against a stale baseline.
        sequenceEpoch: beforeEpoch,
        // Echo the request token so recovery can drop a response that arrives after the
        // request it belongs to was superseded.
        ...(correlationId !== undefined && { correlationId }),
      }),
    );
  }

  /**
   * Client-initiated, post-seed request to restore the terminal's viewport modes
   * (alt-screen + mouse-tracking). `capture-pane -e` replays visible cells but NOT DEC
   * private modes, and frames arriving DURING the client seed are discarded — so on a
   * seeded (re)connect into a full-screen TUI the modes are lost until something repaints.
   * The client fires this once its seed has settled; the server GATES it on the provider's
   * alt-screen policy (non-alt-screen providers no-op) and coalesces the resize jiggle.
   */
  @SubscribeMessage('terminal:restore_viewport_modes')
  handleRestoreViewportModes(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string },
  ) {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    const cs = this.clientSessions.get(client.id);
    if (!cs?.subscriptions.has(`terminal/${sessionId}`)) return;
    this.maybeRestoreViewportModes(sessionId);
  }

  @SubscribeMessage('pong')
  handlePong(@ConnectedSocket() client: Socket) {
    const cs = this.clientSessions.get(client.id);
    if (cs) cs.lastHeartbeat = new Date();
  }

  // ── Broadcasts ──────────────────────────────────────────────────────

  broadcastTerminalData(sessionId: string, data: string): void {
    const session = this.registry.get(sessionId);
    if (!this.hasWebSubscribers(sessionId)) {
      session?.pushFrame(data);
      this.streamService.markDiscontinuous(sessionId);
      return;
    }

    this.streamService.resumeRetention(sessionId);
    const envelopes = this.streamService.addFrame(sessionId, data);
    for (const envelope of envelopes) {
      const chunk = (envelope.payload as { data: string }).data;
      session?.pushFrame(chunk);
      for (const clientSession of this.clientSessions.values()) {
        if (clientSession.subscriptions.has(`terminal/${sessionId}`)) {
          this.enqueueLiveOrRecover(clientSession.socket, sessionId, envelope);
        }
      }
    }
  }

  private hasWebSubscribers(sessionId: string): boolean {
    const session = this.registry.get(sessionId);
    if (session) return session.getSubscriberCount() > 0;
    for (const clientSession of this.clientSessions.values()) {
      if (clientSession.subscriptions.has(`terminal/${sessionId}`)) return true;
    }
    return false;
  }

  // ── Session lifecycle events ────────────────────────────────────────

  @OnEvent('session.crashed')
  handleSessionCrashed(payload: { sessionId: string; sessionName: string }) {
    // Mirror handleDeadTmuxSession: without this the DB row stays 'running'
    // and the registry entry survives, blocking a later restore with
    // "TerminalSession already exists".
    this.sessionsService.markSessionFailed(payload.sessionId, 'tmux session lost (health check)');
    this.cleanupSessionLifecycle(payload.sessionId, {
      replayRetentionMs: 0,
      disposeTerminalState: true,
    });
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'crashed',
      message: 'Session unexpectedly terminated',
    };
    this.server
      .to(`session:${payload.sessionId}`)
      .emit('message', createEnvelope(`session/${payload.sessionId}`, 'state_change', ep));
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
    // Defense-in-depth: the restore pipeline already cancels the replay clear SYNCHRONOUSLY at its
    // true start (before the first buffer-producing await), which is the boundary that actually keeps
    // the live sequence-domain. This event fires only at pipeline Phase 9, far too late to be that
    // guarantee; the re-cancel here is a harmless idempotent backstop for any restore path that
    // reaches this handler without having gone through that seam.
    this.cancelReplayCleanup(payload.sessionId);

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
    this.cleanupSessionLifecycle(payload.sessionId, {
      replayRetentionMs: STOPPED_REPLAY_RETENTION_MS,
      disposeTerminalState: false,
    });
    const ep: SessionStatePayload = {
      sessionId: payload.sessionId,
      status: 'ended',
      message: 'Session terminated',
    };
    this.server.emit('message', createEnvelope('sessions', 'stopped', ep));
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      this.clientSessions.forEach((cs, clientId) => {
        if (now.getTime() - cs.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT) {
          logger.warn({ clientId }, 'Client heartbeat timeout');
          this.server.sockets.sockets.get(clientId)?.disconnect(true);
          // Same authority sweep as handleDisconnect — disconnect(true) may not route through it,
          // and a plain clientSessions.delete would leak authority on every latched session.
          this.releaseClientSession(clientId);
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

    const FORWARDED_FRAME_TYPES = new Set(['focus_changed', 'resize_jiggle', 'full_history']);
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
    this.cleanupSessionLifecycle(sessionId, {
      replayRetentionMs: 0,
      disposeTerminalState: true,
    });
    const ep: SessionStatePayload = {
      sessionId,
      status: 'crashed',
      message: 'Terminal session is no longer available',
    };
    const envelope = createEnvelope(`session/${sessionId}`, 'state_change', ep);
    client.emit('message', envelope);
    this.server.to(`session:${sessionId}`).emit('message', envelope);
  }

  /** Cancel a pending stopped-session replay clear, if any. Idempotent. Delegates to the replay
   * -lifecycle owner (TerminalStreamService), which owns the timer. */
  private cancelReplayCleanup(sessionId: string): void {
    this.streamService.cancelScheduledClear(sessionId);
  }

  private cleanupSessionLifecycle(sessionId: string, policy: LifecycleCleanupPolicy): void {
    this.cancelReplayCleanup(sessionId);

    this.unwireFrameListener(sessionId);
    this.seedService.invalidateCache(sessionId);
    this.themeCache.delete(sessionId);
    this.viewportRestoreAt.delete(sessionId);
    this.pruneInputRateEntries((key) => key.endsWith(`:${sessionId}`));
    this.retireSessionRecoveries(sessionId);
    // The recovery counter is now domain-local (owned by the FrameBuffer); it is retired together
    // with the buffer when the domain is cleared below, and retained otherwise.

    if (policy.disposeTerminalState) {
      this.ptyService.stopStreaming(sessionId);
      this.registry.dispose(sessionId);
    }

    if (policy.replayRetentionMs === 0) {
      this.streamService.clearBuffer(sessionId);
      return;
    }

    // Delegate the delayed clear to the FrameBuffer owner. On expiry it clears the buffer and runs
    // the registered expiry handler (retireSessionRecoveries): a still-subscribed client can send
    // terminal:resync_request in the retention window (after this stop cleanup, before the timer
    // fires), starting a recovery whose FrameBuffer domain the expiry now retires — dropping it keeps
    // its map entry/lane from outliving the domain and its late callbacks no-ops.
    this.streamService.scheduleClear(sessionId, policy.replayRetentionMs);
  }

  /**
   * Drop every in-flight recovery state, targeted-seed attempt, and scheduler lane bound to
   * `sessionId`. Run both at stop cleanup and when the delayed retention timer clears the buffer, so a
   * recovery started in the retention window cannot outlive its retired sequence-domain.
   */
  private retireSessionRecoveries(sessionId: string): void {
    for (const [key, recovery] of this.recoveries) {
      if (recovery.sessionId === sessionId) this.recoveries.delete(key);
    }
    for (const clientId of this.clientSessions.keys()) {
      this.targetedSeedAttempts.delete(this.recoveryKey(clientId, sessionId));
    }
    this.sendScheduler.removeSession(sessionId);
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

  /**
   * Restore a TUI session's alt-screen + mouse modes via a {@link PtyService.triggerRedraw}
   * jiggle. GATED on the provider's alt-screen policy (non-alt-screen providers no-op) and
   * COALESCED across simultaneous viewers within {@link VIEWPORT_RESTORE_COALESCE_MS} so a
   * burst of post-seed/reconnect requests collapses to a single redraw. triggerRedraw is
   * itself a no-op when the PTY isn't streaming.
   */
  private maybeRestoreViewportModes(sessionId: string): void {
    if (!this.sessionsService.usesAlternateScreenFor(sessionId)) return;
    const now = Date.now();
    const last = this.viewportRestoreAt.get(sessionId) ?? 0;
    if (now - last < VIEWPORT_RESTORE_COALESCE_MS) {
      logger.debug({ sessionId }, 'viewport_mode_restore_coalesced');
      return;
    }
    this.viewportRestoreAt.set(sessionId, now);
    logger.debug({ sessionId }, 'viewport_mode_restore_redraw');
    void this.ptyService.triggerRedraw(sessionId);
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

  private pruneInputRateEntries(matches: (key: string) => boolean): void {
    for (const key of this.inputRateTracker.keys()) {
      if (matches(key)) this.inputRateTracker.delete(key);
    }
  }

  onModuleDestroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    // Scheduled replay clears are owned by TerminalStreamService now and retired in its own
    // onModuleDestroy.
    for (const sessionId of [...this.frameListeners.keys()]) {
      this.unwireFrameListener(sessionId);
    }
    this.themeCache.clear();
    this.viewportRestoreAt.clear();
    this.inputRateTracker.clear();
    this.recoveries.clear();
    for (const timer of this.promptPasteExpiryTimers.values()) clearTimeout(timer);
    this.promptPasteExpiryTimers.clear();
    this.promptPasteLedger.clear();
    this.sendScheduler.dispose();
    this.clientSessions.clear();
  }
}
