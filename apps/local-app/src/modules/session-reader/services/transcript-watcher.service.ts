import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { SessionCacheService, type SourceChangeKind } from './session-cache.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { UnifiedMetrics } from '../dtos/unified-session.types';
import { EventsService } from '../../events/services/events.service';
import { buildChunks } from '../builders/chunk-builder';
import { encodeCursor } from './transcript-cursor';
import { truncateMessages, truncateChunks } from './transcript-truncation';
import {
  serializeChunk as serializeChunkToWire,
  serializeMessage as serializeMessageToWire,
} from './transcript-serialization';
import type { SessionTranscriptDiscoveredEventPayload } from '../../events/catalog/session.transcript.discovered';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';

/** Debounce window for coalescing rapid JSONL appends */
const DEBOUNCE_MS = 100;
const COSTLY_REFRESH_MS = 50;
const FILE_REFRESH_COOLDOWN_MS = 2_000;

/** Stat-poll fallback interval (covers fs.watch gaps on some platforms) */
const STAT_POLL_INTERVAL_MS = 3_000;

/** Max incremental delta before logging a warning (10 MB) */
const MAX_INCREMENTAL_BYTES = 10 * 1024 * 1024;

function requiresCanonicalRefetch(sourceChangeKind: SourceChangeKind): boolean {
  switch (sourceChangeKind) {
    case 'cache-hit':
    case 'same-file-append':
    case 'db-update':
      return false;
    case 'file-replacement':
    case 'file-truncation':
    case 'same-file-rewrite':
    case 'unknown-full-parse':
      return true;
    default:
      return assertNever(sourceChangeKind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source change kind: ${String(value)}`);
}

interface MetricsSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  messageCount: number;
}

interface WatcherState {
  sessionId: string;
  filePath: string;
  /** Path handed to fs.watch (file: the transcript; DB: the `-wal` sidecar hint). */
  watchPath: string;
  providerName: string;
  /** Source type — drives change detection (file size/inode vs DB freshness token). */
  sourceKind: 'file' | 'db';
  /** Resolved source-ref for DB sources (carries providerSessionId). */
  sourceRef?: SessionSourceRef;
  fsWatcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  active: boolean;
  pending: boolean;
  nextEligibleAt: number;
  lastDev: number;
  lastIno: number;
  lastSize: number;
  /** Set by the stat poll when it reopens a rotated file before the debounce runs. */
  replacementPending: boolean;
  /** File providers may announce a transcript path before creating the file. */
  pendingCreation: boolean;
  lastMessageCount: number;
  lastChunkCount: number;
  lastMetrics: MetricsSnapshot;
  /** Complete last parsed metrics for O(1) summary reads while this watcher is active. */
  lastSummaryMetrics: UnifiedMetrics | null;
  /** Opaque DB freshness token from the last observed revision (DB sources). */
  lastFreshnessToken?: unknown;
  /** Numeric source revision for the cursor's first component. */
  lastSourceVersion: number;
}

@Injectable()
export class TranscriptWatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(TranscriptWatcherService.name);
  private readonly watchers = new Map<string, WatcherState>();
  private readonly endingWatchers = new Map<string, WatcherState>();

  constructor(
    private readonly cacheService: SessionCacheService,
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly events: EventsService,
  ) {}

  onModuleDestroy(): void {
    this.endingWatchers.clear();
    const sessionIds = [...this.watchers.keys()];
    for (const sessionId of sessionIds) {
      this.cleanupResources(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  @OnEvent('session.transcript.discovered', { async: true })
  async handleTranscriptDiscovered(
    payload: SessionTranscriptDiscoveredEventPayload,
  ): Promise<void> {
    try {
      await this.startWatching(
        payload.sessionId,
        payload.transcriptPath,
        payload.providerName,
        payload.providerSessionId,
      );
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to start transcript watcher',
      );
    }
  }

  @OnEvent('session.stopped', { async: true })
  async handleSessionStopped(payload: SessionStoppedEventPayload): Promise<void> {
    await this.stopWatching(payload.sessionId, 'session.stopped');
  }

  @OnEvent('session.crashed', { async: true })
  async handleSessionCrashed(payload: SessionCrashedEventPayload): Promise<void> {
    await this.stopWatching(payload.sessionId, 'session.crashed');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async startWatching(
    sessionId: string,
    filePath: string,
    providerName: string,
    providerSessionId?: string,
  ): Promise<void> {
    if (this.watchers.has(sessionId)) {
      this.logger.debug({ sessionId }, 'Watcher already active — skipping');
      return;
    }

    const adapter = this.adapterFactory.getAdapter(providerName);
    const sourceKind = adapter?.sourceKind ?? 'file';
    if (sourceKind === 'db' && !providerSessionId) {
      this.logger.warn(
        { sessionId, filePath, providerName },
        'DB-backed watcher requires providerSessionId — skipping watcher',
      );
      return;
    }
    const sourceRef: SessionSourceRef | undefined =
      sourceKind === 'db' ? { filePath, providerName, providerSessionId, kind: 'db' } : undefined;
    const state: WatcherState = {
      sessionId,
      filePath,
      providerName,
      sourceKind,
      sourceRef,
      watchPath: sourceKind === 'db' ? `${filePath}-wal` : filePath,
      fsWatcher: null,
      pollTimer: null,
      debounceTimer: null,
      active: true,
      pending: false,
      nextEligibleAt: 0,
      lastDev: 0,
      lastIno: 0,
      lastSize: 0,
      replacementPending: false,
      pendingCreation: false,
      lastMessageCount: 0,
      lastChunkCount: 0,
      lastSourceVersion: 0,
      lastMetrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
      lastSummaryMetrics: null,
    };
    // Reserve ownership before I/O so stop/restart also fences the initial seed.
    this.endingWatchers.delete(sessionId);
    this.watchers.set(sessionId, state);

    let stat: fs.Stats | null = null;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (error) {
      if (!this.isCurrent(state)) return;
      const fsCode = (error as NodeJS.ErrnoException).code;
      if (sourceKind !== 'file' || fsCode !== 'ENOENT') {
        this.logger.warn(
          { sessionId, filePath, fsCode },
          'Cannot stat transcript file — skipping watcher',
        );
        this.cleanupResources(sessionId);
        return;
      }
      // Providers can announce a transcript before creating it; poll until it exists.
      state.pendingCreation = true;
    }
    if (!this.isCurrent(state)) return;
    state.lastDev = stat?.dev ?? 0;
    state.lastIno = stat?.ino ?? 0;
    state.lastSize = stat?.size ?? 0;
    state.lastSourceVersion = stat?.size ?? 0;
    if (stat) {
      try {
        state.fsWatcher = this.createFsWatcher(state);
      } catch {
        this.logger.warn(
          { sessionId, watchPath: state.watchPath },
          'fs.watch failed to start — using poll only (expected for not-yet-created -wal)',
        );
      }
    }

    try {
      if (adapter && (sourceKind === 'db' || (stat && stat.size > 0))) {
        const { session, sourceVersion } = await this.cacheService.getOrParseWithMeta(
          sessionId,
          sourceRef ?? filePath,
          adapter,
        );
        if (!this.isCurrent(state)) return;
        state.lastMessageCount = session.metrics.messageCount;
        state.lastChunkCount = buildChunks(session.messages).length;
        state.lastSourceVersion = sourceVersion;
        state.lastMetrics = this.toMetricsSnapshot(session.metrics);
        state.lastSummaryMetrics = session.metrics;
        if (sourceRef && adapter.getFreshnessToken) {
          const token = await adapter.getFreshnessToken(sourceRef);
          if (!this.isCurrent(state)) return;
          state.lastFreshnessToken = token;
        }
      }
    } catch (error) {
      if (!this.isCurrent(state)) return;
      this.logger.warn({ error, sessionId }, 'Failed to seed watcher state — starting from zero');
    }
    if (!this.isCurrent(state)) return;
    state.pollTimer = setInterval(() => this.requestRefresh(state, true), STAT_POLL_INTERVAL_MS);
    state.active = false;
    if (state.pending) this.requestRefresh(state);
    this.logger.log(
      {
        sessionId,
        filePath,
        watchPath: state.watchPath,
        sourceKind,
        pendingCreation: state.pendingCreation,
        hasFsWatch: !!state.fsWatcher,
      },
      'Started transcript watcher',
    );
  }

  private toMetricsSnapshot(metrics: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    messageCount: number;
  }): MetricsSnapshot {
    return {
      totalTokens: metrics.totalTokens,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      costUsd: metrics.costUsd,
      messageCount: metrics.messageCount,
    };
  }

  async stopWatching(
    sessionId: string,
    endReason:
      | 'session.stopped'
      | 'session.crashed'
      | 'watcher.closed'
      | 'file.deleted' = 'session.stopped',
  ): Promise<void> {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    const { filePath, providerName, lastMetrics } = state;

    // Cleanup first to prevent double-stop and stop timers
    this.cleanupResources(sessionId);
    this.endingWatchers.set(sessionId, state);

    // Final parse for up-to-date metrics (best effort)
    let finalMetrics: MetricsSnapshot = lastMetrics;
    try {
      const adapter = this.adapterFactory.getAdapter(providerName);
      if (adapter) {
        // DB sources resolve the session via the source-ref; file sources by path.
        const source = state.sourceKind === 'db' && state.sourceRef ? state.sourceRef : filePath;
        const session = await this.cacheService.getOrParse(sessionId, source, adapter);
        finalMetrics = this.toMetricsSnapshot(session.metrics);
      }
    } catch (error) {
      this.logger.warn({ error, sessionId }, 'Final parse failed — using last known metrics');
    }

    if (this.endingWatchers.get(sessionId) !== state) return;
    try {
      await this.events.publish('session.transcript.ended', {
        sessionId,
        transcriptPath: filePath,
        finalMetrics,
        endReason,
      });
    } catch (error) {
      this.logger.error({ error, sessionId }, 'Failed to emit transcript ended event');
    } finally {
      if (this.endingWatchers.get(sessionId) === state) this.endingWatchers.delete(sessionId);
    }
  }

  /** Number of active watchers. */
  get activeWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * O(1) read of the last known transcript `messageCount` for a session, straight
   * from the watcher cache (seeded on watcher start, updated on every file
   * change). Returns `null` when no watcher is active for the session — callers
   * must treat that as "no value" (best-effort), never as an error.
   *
   * Used by `chat.listAgents` to enrich each online agent with a per-session
   * `latestMessageCount`, so mobile can derive unread badges WITHOUT parsing the
   * transcript (the watcher already tracks this; no parse, no DB hit). This
   * matters because `listAgents` polls every 15s × N agents and the session
   * parse cache has a shared byte budget — a per-call parse can churn it.
   */
  getLastKnownMessageCount(sessionId: string): number | null {
    return this.watchers.get(sessionId)?.lastMessageCount ?? null;
  }

  getLastKnownSummaryMetrics(sessionId: string): UnifiedMetrics | null {
    return this.watchers.get(sessionId)?.lastSummaryMetrics ?? null;
  }

  invalidateLastKnownSummaryMetrics(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (watcher) watcher.lastSummaryMetrics = null;
  }

  // ---------------------------------------------------------------------------
  // Private: Debounce & Change Detection
  // ---------------------------------------------------------------------------

  private isCurrent(state: WatcherState): boolean {
    return this.watchers.get(state.sessionId) === state;
  }

  private requestRefresh(state: WatcherState, poll = false): void {
    if (!this.isCurrent(state)) return;
    state.pending = true;
    if (state.active || state.debounceTimer) return;

    const remaining = state.nextEligibleAt - performance.now();
    if (poll && remaining <= 0) {
      void this.runRefresh(state, true);
      return;
    }
    const delay = remaining > 0 ? remaining : DEBOUNCE_MS;
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void this.runRefresh(state, false);
    }, delay);
  }

  private async runRefresh(state: WatcherState, poll: boolean): Promise<void> {
    if (!this.isCurrent(state)) return;
    state.active = true;
    state.pending = false;
    const startedAt = performance.now();
    try {
      if (poll) {
        if (state.sourceKind === 'db') await this.checkDbPoll(state);
        else await this.checkStatPoll(state);
      } else if (state.sourceKind === 'db') {
        await this.handleDbChanged(state);
      } else {
        await this.handleFileChanged(state);
      }
    } catch (error) {
      this.logger.error({ error, sessionId: state.sessionId }, 'Source refresh failed');
    } finally {
      if (this.isCurrent(state)) {
        state.active = false;
        if (!poll && state.sourceKind === 'file') {
          const completedAt = performance.now();
          state.nextEligibleAt =
            completedAt - startedAt >= COSTLY_REFRESH_MS
              ? completedAt + FILE_REFRESH_COOLDOWN_MS
              : 0;
        }
        if (state.pending) this.requestRefresh(state);
      }
    }
  }

  /**
   * DB freshness poll: compare the adapter's opaque token; schedule a re-parse
   * when it changes. WAL writes don't move the main `.db` size, so the token
   * (count + max updated-time) is the authoritative change signal.
   */
  private async checkDbPoll(state: WatcherState): Promise<void> {
    const adapter = this.adapterFactory.getAdapter(state.providerName);
    if (!adapter?.getFreshnessToken || !state.sourceRef) return;

    let token: unknown;
    try {
      token = await adapter.getFreshnessToken(state.sourceRef);
    } catch (error) {
      // Container momentarily locked / mid-checkpoint — ignore, retry next tick.
      this.logger.debug({ error, sessionId: state.sessionId }, 'DB freshness poll failed — retry');
      return;
    }
    if (!this.isCurrent(state)) return;

    if (JSON.stringify(token) !== JSON.stringify(state.lastFreshnessToken)) {
      this.requestRefresh(state);
    }
  }

  private async checkStatPoll(state: WatcherState): Promise<void> {
    const { sessionId } = state;

    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(state.filePath);
    } catch (error) {
      if (!this.isCurrent(state)) return;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (state.pendingCreation) return;
        this.logger.warn({ sessionId }, 'Transcript file deleted — stopping watcher');
        await this.stopWatching(sessionId, 'file.deleted');
        return;
      }
      throw error;
    }
    if (!this.isCurrent(state)) return;

    if (state.pendingCreation) {
      state.pendingCreation = false;
      state.lastDev = stat.dev;
      state.lastIno = stat.ino;
      // Preserve the synthetic empty generation (revision 0) until the change
      // handler parses the newly materialized file and publishes a canonical
      // replacement signal.
      state.lastSize = 0;
      state.replacementPending = true;
      this.reopenFsWatcher(state);
      this.requestRefresh(state);
      this.logger.log(
        { sessionId, filePath: state.filePath },
        'Transcript file materialized — activating watcher',
      );
      return;
    }

    const identityChanged = stat.dev !== state.lastDev || stat.ino !== state.lastIno;

    // File identity rotation is a replacement even when the byte size is unchanged.
    if (identityChanged) {
      this.logger.debug({ sessionId }, 'Inode rotation detected via stat-poll');
      this.reopenFsWatcher(state);
      state.lastDev = stat.dev;
      state.lastIno = stat.ino;
      state.replacementPending = true;
    }

    if (identityChanged || state.replacementPending || stat.size !== state.lastSize) {
      this.requestRefresh(state);
    }
  }

  private async handleFileChanged(state: WatcherState): Promise<void> {
    const { sessionId } = state;

    try {
      let stat: fs.Stats;
      try {
        stat = await fsPromises.stat(state.filePath);
      } catch (error) {
        if (!this.isCurrent(state)) return;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (state.pendingCreation) return;
          this.logger.warn({ sessionId }, 'Transcript file deleted during change handling');
          await this.stopWatching(sessionId, 'file.deleted');
          return;
        }
        throw error;
      }
      if (!this.isCurrent(state)) return;

      const identityChanged = stat.dev !== state.lastDev || stat.ino !== state.lastIno;
      const isReplacement = state.pendingCreation || state.replacementPending || identityChanged;

      // Inode rotation
      if (identityChanged || state.pendingCreation) {
        this.logger.debug({ sessionId }, 'Inode rotation detected');
        this.reopenFsWatcher(state);
        state.lastDev = stat.dev;
        state.lastIno = stat.ino;
        state.pendingCreation = false;
      }

      // Bounded read warning
      const delta = stat.size - state.lastSize;
      if (delta > MAX_INCREMENTAL_BYTES) {
        this.logger.warn(
          { sessionId, delta, maxBytes: MAX_INCREMENTAL_BYTES },
          'Incremental delta exceeds 10MB bound — proceeding with parse',
        );
      }

      const adapter = this.adapterFactory.getAdapter(state.providerName);
      if (!adapter) {
        this.logger.error({ sessionId, providerName: state.providerName }, 'No adapter found');
        return;
      }

      const { session, sourceChangeKind, sourceVersion, boundaryFold } =
        await this.cacheService.getOrParseWithMeta(sessionId, state.filePath, adapter);
      if (!this.isCurrent(state)) return;
      const changedCacheHit =
        sourceChangeKind === 'cache-hit' && sourceVersion !== state.lastSourceVersion;

      const newMessageCount = session.metrics.messageCount - state.lastMessageCount;

      // A replacement or a parser-driven message-count deflation invalidates every prior
      // client chunk. Require a canonical fetch instead of slicing with stale generation
      // indices; messageCount === messages.length keeps the watcher state valid.
      const isFullRefresh = isReplacement || session.metrics.messageCount < state.lastMessageCount;
      if (isFullRefresh) {
        this.logger.debug(
          {
            sessionId,
            isReplacement,
            previousMessageCount: state.lastMessageCount,
            messageCount: session.metrics.messageCount,
          },
          'Transcript source replaced or messageCount deflated — requiring canonical refetch',
        );
      }

      // Build chunks for delta computation
      const chunks = buildChunks(session.messages);
      const prevCursor = encodeCursor(
        state.lastSourceVersion,
        state.lastMessageCount,
        state.lastChunkCount,
      );
      const cursor = encodeCursor(sourceVersion, session.metrics.messageCount, chunks.length);
      const replaceFromChunkIndex = isFullRefresh ? 0 : Math.max(0, state.lastChunkCount - 1);
      const sliceFromMessage = isFullRefresh ? 0 : state.lastMessageCount;
      const newChunkIds = chunks.slice(replaceFromChunkIndex).map((c) => c.id);
      const truncatedDeltaMessages = truncateMessages(session.messages.slice(sliceFromMessage));
      const truncatedDeltaChunks = truncateChunks(chunks.slice(replaceFromChunkIndex));
      const deltaChunks = truncatedDeltaChunks.map(serializeChunkToWire);
      const deltaMessages = truncatedDeltaMessages.map(serializeMessageToWire);

      // Update watcher state
      state.lastSize = stat.size;
      state.lastSourceVersion = sourceVersion;
      state.lastDev = stat.dev;
      state.lastIno = stat.ino;
      state.replacementPending = false;
      state.lastMessageCount = session.metrics.messageCount;
      state.lastChunkCount = chunks.length;
      state.lastMetrics = this.toMetricsSnapshot(session.metrics);
      state.lastSummaryMetrics = session.metrics;

      if (isReplacement || changedCacheHit || requiresCanonicalRefetch(sourceChangeKind)) {
        await this.events.publish('session.transcript.updated', {
          kind: 'full-refetch-required',
          sessionId,
          transcriptPath: state.filePath,
          sourceChangeKind,
        });
        return;
      }

      // In-place tail replacement for a cache-boundary fold: the tail assistant changed
      // (gained a folded tool_result) but no NEW message was added, so emit a zero-count
      // last-chunk replacement (replaceFromChunkIndex = lastChunkCount - 1, updated
      // deltaChunks) rather than suppressing it — mirrors handleDbChanged's in-place
      // semantics. Keeps rendering live without emitting a positive unread delta.
      const isInPlaceTailFold = boundaryFold && newMessageCount === 0 && !isFullRefresh;

      // Publish when new messages arrived, on a full-refresh deflation, or on an in-place
      // tail fold. The wire newMessageCount is clamped to ≥0 (never a negative delta),
      // matching handleDbChanged.
      if (newMessageCount > 0 || isFullRefresh || isInPlaceTailFold) {
        await this.events.publish('session.transcript.updated', {
          kind: 'delta',
          sessionId,
          transcriptPath: state.filePath,
          newMessageCount: Math.max(0, newMessageCount),
          metrics: state.lastMetrics,
          cursor,
          prevCursor,
          replaceFromChunkIndex,
          newChunkIds,
          totalChunkCount: chunks.length,
          deltaChunks,
          deltaMessages,
        });
      }
    } catch (error) {
      // Watcher isolation: log error but don't propagate to other watchers
      this.logger.error({ error, sessionId }, 'File change handler failed — watcher continues');
    }
  }

  /**
   * Handle a detected revision change for a DB-backed source. Re-reads the
   * snapshot and emits `session.transcript.updated` whenever the freshness token
   * changed — including **in-place part updates** that add no new messages
   * (surfaced as an in-place last-chunk replacement). Mirrors the file handler's
   * payload shape so mobile's windowed merge is identical.
   */
  private async handleDbChanged(state: WatcherState): Promise<void> {
    const { sessionId } = state;
    if (!state.sourceRef) return;

    try {
      const adapter = this.adapterFactory.getAdapter(state.providerName);
      if (!adapter) {
        this.logger.error({ sessionId, providerName: state.providerName }, 'No adapter found');
        return;
      }

      // Confirm a real revision change before the (heavier) snapshot re-read.
      let token: unknown = state.lastFreshnessToken;
      if (adapter.getFreshnessToken) {
        try {
          token = await adapter.getFreshnessToken(state.sourceRef);
        } catch (error) {
          this.logger.debug(
            { error, sessionId },
            'DB freshness check failed during change — retry',
          );
          return;
        }
        if (!this.isCurrent(state)) return;
        if (JSON.stringify(token) === JSON.stringify(state.lastFreshnessToken)) {
          return; // spurious wake (e.g. WAL checkpoint with no content change)
        }
      }

      const { session, sourceVersion } = await this.cacheService.getOrParseWithMeta(
        sessionId,
        state.sourceRef,
        adapter,
      );
      if (!this.isCurrent(state)) return;

      // Deflation guard: once the coalescer shrinks an OpenCode count (e.g. 85→~10),
      // the first refresh on this path would slice from the stale old count and publish
      // an out-of-range splice anchor (replaceFromChunkIndex beyond the new chunk set).
      // Treat any deflation as a FULL REFRESH — replace the window from chunk 0 with the
      // whole current transcript — mirroring the file-source guard in handleFileChanged.
      const isFullRefresh = session.metrics.messageCount < state.lastMessageCount;
      if (isFullRefresh) {
        this.logger.debug(
          {
            sessionId,
            previousMessageCount: state.lastMessageCount,
            messageCount: session.metrics.messageCount,
          },
          'DB transcript messageCount deflated — emitting full refresh',
        );
      }

      const chunks = buildChunks(session.messages);
      const newMessageCount = session.metrics.messageCount - state.lastMessageCount;
      const prevCursor = encodeCursor(
        state.lastSourceVersion,
        state.lastMessageCount,
        state.lastChunkCount,
      );
      const cursor = encodeCursor(sourceVersion, session.metrics.messageCount, chunks.length);
      const replaceFromChunkIndex = isFullRefresh ? 0 : Math.max(0, state.lastChunkCount - 1);
      const sliceFromMessage = isFullRefresh ? 0 : state.lastMessageCount;
      const newChunkIds = chunks.slice(replaceFromChunkIndex).map((c) => c.id);
      const truncatedDeltaMessages = truncateMessages(session.messages.slice(sliceFromMessage));
      const truncatedDeltaChunks = truncateChunks(chunks.slice(replaceFromChunkIndex));
      const deltaChunks = truncatedDeltaChunks.map(serializeChunkToWire);
      const deltaMessages = truncatedDeltaMessages.map(serializeMessageToWire);

      state.lastFreshnessToken = token;
      state.lastSourceVersion = sourceVersion;
      state.lastMessageCount = session.metrics.messageCount;
      state.lastChunkCount = chunks.length;
      state.lastMetrics = this.toMetricsSnapshot(session.metrics);
      state.lastSummaryMetrics = session.metrics;

      // Emit on ANY revision change (newMessageCount may be 0 for in-place edits).
      await this.events.publish('session.transcript.updated', {
        kind: 'delta',
        sessionId,
        transcriptPath: state.filePath,
        newMessageCount: Math.max(0, newMessageCount),
        metrics: state.lastMetrics,
        cursor,
        prevCursor,
        replaceFromChunkIndex,
        newChunkIds,
        totalChunkCount: chunks.length,
        deltaChunks,
        deltaMessages,
      });
    } catch (error) {
      this.logger.error({ error, sessionId }, 'DB change handler failed — watcher continues');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: fs.watch lifecycle
  // ---------------------------------------------------------------------------

  private createFsWatcher(state: WatcherState): fs.FSWatcher {
    const { sessionId } = state;
    const watcher = fs.watch(state.watchPath, (eventType) => {
      if (!this.isCurrent(state) || state.fsWatcher !== watcher) return;
      if (eventType === 'change' || eventType === 'rename') {
        this.requestRefresh(state);
      }
    });

    watcher.on('error', (err) => {
      if (!this.isCurrent(state) || state.fsWatcher !== watcher) return;
      this.logger.warn({ error: err, sessionId }, 'fs.watch error — relying on stat-poll fallback');
      state.fsWatcher = null;
      watcher.close();
    });

    return watcher;
  }

  private reopenFsWatcher(state: WatcherState): void {
    if (!this.isCurrent(state)) return;
    if (state.fsWatcher) {
      const previous = state.fsWatcher;
      state.fsWatcher = null;
      previous.close();
    }

    try {
      state.fsWatcher = this.createFsWatcher(state);
    } catch {
      this.logger.warn(
        { sessionId: state.sessionId },
        'Failed to reopen fs.watch after inode rotation',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Resource cleanup
  // ---------------------------------------------------------------------------

  private cleanupResources(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    this.watchers.delete(sessionId);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    state.pending = false;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.fsWatcher) state.fsWatcher.close();
    state.fsWatcher = null;

    this.logger.debug({ sessionId }, 'Cleaned up transcript watcher');
  }
}
