import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  SessionCacheService,
  type GetOrParseResult,
  type SourceChangeKind,
} from './session-cache.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type {
  IncrementalResult,
  SessionReaderAdapter,
  SessionSourceRef,
  TailDescriptor,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedMessage, UnifiedMetrics } from '../dtos/unified-session.types';
import { EventsService } from '../../events/services/events.service';
import { buildChunks } from '../builders/chunk-builder';
import {
  anchorsEqual,
  hashFileAnchors,
  type FileContentAnchors,
  type FileFreshnessSnapshot,
} from './bounded-anchor-proof';
import { computeLeadingContinuationFold, describeTail, mergeMetrics } from './metrics-merge';
import {
  estimateMessageTokens,
  estimateVisibleFromMessages,
} from '../adapters/utils/estimate-content-tokens';
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

/** The identity/size/mtime snapshot of a stat, in the form the anchor proof and the lane compare. */
function toFreshnessSnapshot(stat: fs.Stats): FileFreshnessSnapshot & { fileIdentity: string } {
  return {
    size: stat.size,
    mtimeMs: stat.mtime.getTime(),
    fileIdentity: `${stat.dev}:${stat.ino}`,
  };
}

interface MetricsSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  messageCount: number;
}

/**
 * O(1) per-session state for the metrics-only lane (file+delta adapters without a cache entry).
 * The watcher advances this from small transient slices and drops the message bodies, so an
 * unviewed session costs O(new bytes) CPU and O(1) memory and never enters the parsed cache.
 * Kept ALWAYS current — refreshed from every body-path result too — so no reseed is needed if
 * the entry is later evicted (eviction gives no signal).
 */
interface LaneState {
  /** Proven line-boundary end offset of the merged prefix. */
  offset: number;
  /** Bounded head/tail anchors proving `[0, offset)`; absent only for a zero-length prefix. */
  anchors: FileContentAnchors | undefined;
  /** `dev:ino` identity the anchors were proven against; a change forces a full rescan. */
  fileIdentity: string | undefined;
  /**
   * mtimeMs of the snapshot the lane last proved. With fileIdentity and offset it is the lane's
   * accepted freshness token: the redundant-signal no-op requires all three equal, so a same-size
   * in-place rewrite (new mtime, unchanged size) falls through to a metrics-only full rescan
   * instead of being mistaken for an already-consumed append.
   */
  revision: number | undefined;
  /** Running merged metrics (the summary this session reports). */
  metrics: UnifiedMetrics;
  /** Descriptor of the last merged message (drives the boundary fold). */
  tail: TailDescriptor | undefined;
  /** Visible-context tokens in MERGE terms (running; see estimateVisibleFromMessages). */
  visibleContextTokens: number;
  /** Epoch ms of the positional first/last message (merge-term durationMs). */
  firstMessageTimestamp: number | undefined;
  lastMessageTimestamp: number | undefined;
  /** Opaque continuation state for the next incremental parse (Codex token baseline). */
  continuationState: unknown;
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
  /**
   * Metrics-only lane state for file+delta sessions without a cache entry. Present once seeded;
   * kept current on every pass (lane or body) so it survives cache eviction with no reseed.
   */
  lane?: LaneState;
  /** True while this session is served by the lane (no cache entry). Drives the lane→body switch. */
  inLane: boolean;
  /** Seq of the last reader-paid full parse this watcher has accounted for (lane cooldown gate). */
  lastFullParseSeqSeen?: number;
  /**
   * Set within a single runRefresh when a publishing lane pass answered a reader's costly full
   * parse; makes runRefresh treat the pass as costly and re-arm the refresh cooldown. Reset at the
   * start of every runRefresh.
   */
  costlyLanePass: boolean;
  /**
   * The in-flight refresh pass for this session, if any. stopWatching awaits it so the final lane
   * pass never overlaps a running one on the same state.
   */
  activeRefresh?: Promise<void>;
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
      inLane: false,
      costlyLanePass: false,
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
        // File+delta sessions without a cache entry seed the metrics-only lane (no retained
        // parse). DB/snapshot sources, and any session a reader already cached, take the body path.
        const seeded =
          this.isLaneEligible(adapter) && !this.cacheService.getEntry(sessionId)
            ? await this.buildLaneFromSummary(state, adapter)
            : false;
        if (!this.isCurrent(state)) return;
        if (!seeded) {
          const result = await this.cacheService.getOrParseWithMeta(
            sessionId,
            sourceRef ?? filePath,
            adapter,
          );
          if (!this.isCurrent(state)) return;
          this.applyBodyResultToState(state, adapter, result, stat);
        }
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
        // A lane session (file+delta, no cache entry) refreshes its always-current lane one last
        // time so an append made inside the cancelled debounce or the cooldown is still counted.
        // It never getOrParse — that would create a 2x-size entry for an ending unviewed session.
        if (this.isLaneEligible(adapter) && !this.cacheService.getEntry(sessionId)) {
          finalMetrics = await this.finalizeLaneMetrics(state, adapter, lastMetrics);
        } else {
          // DB sources resolve the session via the source-ref; file sources by path.
          const source = state.sourceKind === 'db' && state.sourceRef ? state.sourceRef : filePath;
          const session = await this.cacheService.getOrParse(sessionId, source, adapter);
          finalMetrics = this.toMetricsSnapshot(session.metrics);
        }
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

  /**
   * Ownership predicate for a lane pass. The live path checks the `watchers` entry (identical to
   * isCurrent); the final stop pass checks the `endingWatchers` entry, because cleanupResources has
   * already removed the `watchers` entry by the time it runs. A restart re-homes ownership, so a
   * stale pass loses it and returns without touching the new watcher or publishing.
   */
  private laneOwned(state: WatcherState, ending: boolean): boolean {
    const map = ending ? this.endingWatchers : this.watchers;
    return map.get(state.sessionId) === state;
  }

  private requestRefresh(state: WatcherState, poll = false): void {
    if (!this.isCurrent(state)) return;
    state.pending = true;
    if (state.active || state.debounceTimer) return;

    const remaining = state.nextEligibleAt - performance.now();
    if (poll && remaining <= 0) {
      this.launchRefresh(state, true);
      return;
    }
    const delay = remaining > 0 ? remaining : DEBOUNCE_MS;
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.launchRefresh(state, false);
    }, delay);
  }

  /**
   * Run a refresh pass and record its promise on the state, clearing it once settled. stopWatching
   * awaits this promise so its final lane pass never overlaps a still-running pass on the same state.
   */
  private launchRefresh(state: WatcherState, poll: boolean): void {
    const pass = this.runRefresh(state, poll);
    state.activeRefresh = pass;
    void pass.finally(() => {
      if (state.activeRefresh === pass) state.activeRefresh = undefined;
    });
  }

  private async runRefresh(state: WatcherState, poll: boolean): Promise<void> {
    if (!this.isCurrent(state)) return;
    state.active = true;
    state.pending = false;
    state.costlyLanePass = false;
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
          // A lane pass answering a reader's costly full parse counts as costly even though the
          // pass itself was cheap: the full-parse cost is paid in the reader's fetch, which this
          // cost-based cooldown otherwise never sees.
          const costly = completedAt - startedAt >= COSTLY_REFRESH_MS || state.costlyLanePass;
          state.nextEligibleAt = costly ? completedAt + FILE_REFRESH_COOLDOWN_MS : 0;
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

      // File+delta sessions use the metrics-only lane until a reader creates a cache entry. The
      // atomic refresh either refreshes that entry (body path) or reports it absent (lane path)
      // without ever recreating an evicted entry (which would thrash the byte budget).
      if (this.isLaneEligible(adapter)) {
        const outcome = await this.cacheService.refreshIfPresent(
          sessionId,
          state.filePath,
          adapter,
        );
        if (!this.isCurrent(state)) return;
        if (!outcome.present) {
          // A reader answered a previous lane event with a NEW full parse of this session that
          // was itself costly (its entry cannot stay resident, so it re-parses every time). The
          // lane pass below is cheap and would not trip the cost cooldown, so carry that cost into
          // it — restoring the previous phase's refresh throttle exactly where it used to engage.
          const last = outcome.lastFullParse;
          const readerPaidCostlyFullParse =
            last !== undefined &&
            last.seq !== state.lastFullParseSeqSeen &&
            last.durationMs >= COSTLY_REFRESH_MS;
          state.lastFullParseSeqSeen = last?.seq;
          await this.runFileLane(state, stat, adapter, isReplacement, {
            readerPaidCostlyFullParse,
          });
          return;
        }
        // A reader created the entry: adopt its PRE-parse generation as our previous so the
        // first body delta lines up with what that client already holds (or publishes nothing
        // on a cache hit). Never a full-refetch on the switch — that would force a second load.
        if (state.inLane) {
          state.lastSourceVersion = outcome.preParse.sourceVersion;
          state.lastMessageCount = outcome.preParse.messageCount;
          state.lastChunkCount = outcome.preParse.chunkCount;
          state.inLane = false;
        }
        await this.publishBodyResult(state, stat, adapter, outcome.result, isReplacement);
        return;
      }

      const result = await this.cacheService.getOrParseWithMeta(sessionId, state.filePath, adapter);
      if (!this.isCurrent(state)) return;
      await this.publishBodyResult(state, stat, adapter, result, isReplacement);
    } catch (error) {
      // Watcher isolation: log error but don't propagate to other watchers
      this.logger.error({ error, sessionId }, 'File change handler failed — watcher continues');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: metrics-only lane (file + delta sources without a cache entry)
  // ---------------------------------------------------------------------------

  /** The lane applies only to file-backed, delta-merge adapters (Claude, Codex). */
  private isLaneEligible(adapter: SessionReaderAdapter): boolean {
    return (adapter.sourceKind ?? 'file') === 'file' && adapter.incrementalMode === 'delta';
  }

  private laneRef(state: WatcherState): SessionSourceRef {
    return (
      state.sourceRef ?? {
        filePath: state.filePath,
        providerName: state.providerName,
        kind: 'file',
      }
    );
  }

  private async laneFreshness(filePath: string): Promise<FileFreshnessSnapshot | undefined> {
    try {
      return toFreshnessSnapshot(await fsPromises.stat(filePath));
    } catch {
      return undefined;
    }
  }

  private async tryHashAnchors(
    filePath: string,
    expected: FileFreshnessSnapshot,
    offset: number,
    allowGrowth = false,
  ): Promise<FileContentAnchors | undefined> {
    try {
      return await hashFileAnchors(filePath, expected, offset, allowGrowth);
    } catch (error) {
      this.logger.debug({ error, filePath }, 'Lane anchor proof unavailable — rescanning');
      return undefined;
    }
  }

  /**
   * Seed (or reseed) the lane from the adapter's metrics-only scan. Returns false when the
   * adapter yields no lane seed (the caller then falls back to the body path); true otherwise,
   * including when ownership was lost mid-scan.
   */
  private async buildLaneFromSummary(
    state: WatcherState,
    adapter: SessionReaderAdapter,
    ending = false,
  ): Promise<boolean> {
    if (!adapter.getSummary) return false;
    const summary = await adapter.getSummary(this.laneRef(state));
    if (!this.laneOwned(state, ending)) return true;
    if (!summary?.laneSeed) return false;
    const seed = summary.laneSeed;
    const fresh = await this.laneFreshness(state.filePath);
    if (!this.laneOwned(state, ending)) return true;
    const anchors = fresh
      ? await this.tryHashAnchors(state.filePath, fresh, seed.endOffset)
      : undefined;
    if (!this.laneOwned(state, ending)) return true;
    state.lane = {
      offset: seed.endOffset,
      anchors,
      fileIdentity: fresh?.fileIdentity,
      revision: fresh?.mtimeMs,
      // Report the full-scan summary metrics unchanged: its visibleContextTokens counts the
      // compact-summary message, which is the value the body path also reports at seed time. The
      // MERGE-term seed (which starts after that message) lives only in lane.visibleContextTokens
      // below, for the next incremental merge.
      metrics: { ...summary.metrics },
      tail: seed.tail,
      visibleContextTokens: seed.visibleContextTokens,
      firstMessageTimestamp: seed.firstMessageTimestamp,
      lastMessageTimestamp: seed.lastMessageTimestamp,
      continuationState: seed.continuationState,
      messageCount: seed.messageCount,
    };
    state.inLane = true;
    this.applyLaneToState(state);
    return true;
  }

  /** Record that `stat` was fully handled: later polls compare against it and no replacement is pending. */
  private markStatConsumed(state: WatcherState, stat: fs.Stats): void {
    state.lastSize = stat.size;
    state.lastDev = stat.dev;
    state.lastIno = stat.ino;
    state.replacementPending = false;
  }

  /** Copy the lane's summary values onto the O(1) watcher getters (message count, metrics). */
  private applyLaneToState(state: WatcherState): void {
    const lane = state.lane;
    if (!lane) return;
    state.lastMessageCount = lane.messageCount;
    state.lastMetrics = this.toMetricsSnapshot(lane.metrics);
    state.lastSummaryMetrics = lane.metrics;
  }

  /**
   * Refresh the lane from a body-path result so it stays current: an eviction later resumes the
   * lane from here with no reseed (eviction gives no signal). File+delta sessions only.
   */
  private refreshLaneFromResult(
    state: WatcherState,
    result: GetOrParseResult,
    stat: fs.Stats,
  ): void {
    const msgs = result.session.messages;
    const last = msgs[msgs.length - 1];
    // An incremental append already merged the MERGE-term visible sum into the result metrics, so
    // copy it (O(1)) instead of rescanning every message on each viewed append — that O(messages)
    // rescan dominated CPU for a hot single-session viewer. Only a full parse reports the parser
    // term (it counts the compact-summary message), so there — and it is rare (first open /
    // post-eviction) — recompute the merge term.
    const visibleContextTokens =
      result.sourceChangeKind === 'same-file-append'
        ? result.session.metrics.visibleContextTokens
        : estimateVisibleFromMessages(msgs);
    const fresh = toFreshnessSnapshot(stat);
    state.lane = {
      offset: result.lastOffset,
      anchors: result.fileContentAnchors,
      fileIdentity: fresh.fileIdentity,
      revision: fresh.mtimeMs,
      metrics: result.session.metrics,
      tail: describeTail(last),
      visibleContextTokens,
      firstMessageTimestamp: msgs.length > 0 ? msgs[0].timestamp.getTime() : undefined,
      lastMessageTimestamp: last ? last.timestamp.getTime() : undefined,
      continuationState: result.continuationState,
      messageCount: msgs.length,
    };
  }

  /** Advance the merge-term visible sum over a slice (mirrors estimateVisibleFromMessages). */
  private advanceVisible(base: number, messages: UnifiedMessage[]): number {
    let visible = base;
    for (const m of messages) {
      if (m.isCompactSummary) {
        visible = 0; // reset AND drop the compact summary's own tokens
        continue;
      }
      if (m.isSidechain) continue;
      visible += estimateMessageTokens(m.content);
    }
    return visible;
  }

  /**
   * Fold + merge a proven slice into the lane state (bodies dropped afterward). Returns whether
   * the merged generation changed (new messages or an in-place tail fold) — the publish gate.
   */
  private advanceLaneWithSlice(
    lane: LaneState,
    slice: IncrementalResult,
    proofAnchors: FileContentAnchors,
    fresh: FileFreshnessSnapshot,
  ): boolean {
    const newMessages = slice.entries as UnifiedMessage[];
    const fold = computeLeadingContinuationFold(lane.tail, newMessages);
    const netNew = newMessages.length - fold.foldCount;
    const newCount = lane.messageCount + netNew;
    const newVisible = this.advanceVisible(lane.visibleContextTokens, newMessages);
    const firstTs =
      lane.firstMessageTimestamp ??
      (newMessages.length > 0 ? newMessages[0].timestamp.getTime() : undefined);
    // The merged tail is the slice's last message unless the whole slice folded onto the prior
    // tail (then the tail — and its timestamp — is unchanged).
    const lastTs =
      netNew > 0
        ? newMessages[newMessages.length - 1].timestamp.getTime()
        : lane.lastMessageTimestamp;
    let durationMs = lane.metrics.durationMs;
    if (newCount >= 2 && firstTs !== undefined && lastTs !== undefined) {
      durationMs = lastTs - firstTs;
    }
    const derived = { messageCount: newCount, visibleContextTokens: newVisible, durationMs };
    lane.metrics = slice.metrics
      ? mergeMetrics(lane.metrics, slice.metrics, derived)
      : { ...lane.metrics, ...derived };
    lane.offset = slice.nextByteOffset;
    lane.anchors = proofAnchors;
    lane.fileIdentity = fresh.fileIdentity;
    lane.revision = fresh.mtimeMs;
    lane.tail = fold.newTail;
    lane.visibleContextTokens = newVisible;
    lane.firstMessageTimestamp = firstTs;
    lane.lastMessageTimestamp = lastTs;
    lane.continuationState = slice.continuationState;
    lane.messageCount = newCount;
    return netNew > 0 || fold.tailMutatedWithoutNewMessage;
  }

  /**
   * A metrics-only lane pass. Proves the append with the bounded anchors and parses only the new
   * slice (bodies transient, then dropped); an unproven append or any unsafe change falls back to
   * a metrics-only full rescan. Never retains a parse and never creates a cache entry.
   */
  private async runFileLane(
    state: WatcherState,
    stat: fs.Stats,
    adapter: SessionReaderAdapter,
    isReplacement: boolean,
    {
      readerPaidCostlyFullParse = false,
      ending = false,
    }: { readerPaidCostlyFullParse?: boolean; ending?: boolean } = {},
  ): Promise<void> {
    state.inLane = true;
    const fresh = toFreshnessSnapshot(stat);
    const lane = state.lane;

    // A redundant change signal for bytes we already proved (the poll can re-fire after an append
    // is fully consumed): the lane already reflects these exact bytes. No-op — reseeding here would
    // re-scan needlessly and, worse, replace the merge-derived running metrics (visible sum,
    // positional duration) with a fresh full parse. This mirrors the body path treating a redundant
    // refresh as a cache hit. The revision (mtimeMs) must match too: a same-size in-place rewrite
    // keeps the identity and offset but bumps mtime, and must fall through to the full rescan below.
    if (
      !isReplacement &&
      lane !== undefined &&
      lane.fileIdentity === fresh.fileIdentity &&
      lane.revision === fresh.mtimeMs &&
      fresh.size === lane.offset
    ) {
      this.markStatConsumed(state, stat);
      return;
    }

    const canAppend =
      !isReplacement &&
      lane !== undefined &&
      lane.anchors !== undefined &&
      lane.fileIdentity === fresh.fileIdentity &&
      fresh.size > lane.offset;

    let advanced = false;
    let changed = false;
    if (canAppend && lane) {
      const preAnchors = await this.tryHashAnchors(state.filePath, fresh, lane.offset);
      if (!this.laneOwned(state, ending)) return;
      if (anchorsEqual(preAnchors, lane.anchors)) {
        const slice = await adapter.parseIncremental(state.filePath, {
          byteOffset: lane.offset,
          endByteOffset: fresh.size,
          includeToolCalls: true,
          continuationState: lane.continuationState,
        });
        if (!this.laneOwned(state, ending)) return;
        const newOffset = slice.nextByteOffset;
        const prefixHeld =
          newOffset >= lane.offset &&
          anchorsEqual(
            await this.tryHashAnchors(state.filePath, fresh, lane.offset, true),
            lane.anchors,
          );
        if (!this.laneOwned(state, ending)) return;
        const proofAnchors = prefixHeld
          ? await this.tryHashAnchors(state.filePath, fresh, newOffset, true)
          : undefined;
        if (!this.laneOwned(state, ending)) return;
        if (proofAnchors) {
          changed = this.advanceLaneWithSlice(lane, slice, proofAnchors, fresh);
          advanced = true;
        }
      }
    }

    if (!advanced) {
      const reseeded = await this.buildLaneFromSummary(state, adapter, ending);
      if (!this.laneOwned(state, ending)) return;
      if (!reseeded) return; // adapter yielded no seed — keep prior lane state
      changed = true; // an unsafe change / rescan invalidates the client's view
    }

    this.markStatConsumed(state, stat);
    this.applyLaneToState(state);

    // The final stop pass (ending) refreshes the reported metrics only; it never publishes a live
    // transcript update. A live pass publishes on any merged change.
    if (changed && !ending) {
      // Only a pass that actually publishes re-arms the cooldown for a reader's costly full parse;
      // a no-op / non-publishing pass never starts a cooldown from this rule.
      if (readerPaidCostlyFullParse) state.costlyLanePass = true;
      await this.events.publish('session.transcript.updated', {
        kind: 'full-refetch-required',
        sessionId: state.sessionId,
        transcriptPath: state.filePath,
        sourceChangeKind: 'unknown-full-parse',
      });
    }
  }

  /**
   * Best-effort final lane refresh for an ending file+delta session with no cache entry. Runs one
   * ending-mode lane pass (append proof + slice parse + fold/merge, else a metrics-only full
   * rescan) so the ended metrics count an append made inside the cancelled debounce or the
   * cooldown. Ownership is fenced by endingWatchers — cleanupResources already removed the watchers
   * entry — and the pass publishes no update and creates no cache entry. Returns the refreshed lane
   * metrics, or `fallback` (the last known metrics) when the file is gone or ownership was lost.
   */
  private async finalizeLaneMetrics(
    state: WatcherState,
    adapter: SessionReaderAdapter,
    fallback: MetricsSnapshot,
  ): Promise<MetricsSnapshot> {
    /** The file's stat while this ending state still owns the session; undefined otherwise. */
    const statIfOwned = async (): Promise<fs.Stats | undefined> => {
      try {
        const stat = await fsPromises.stat(state.filePath);
        return this.laneOwned(state, true) ? stat : undefined;
      } catch {
        return undefined;
      }
    };

    // Probe the file BEFORE awaiting any in-flight pass. A deleted transcript (the file.deleted stop
    // arrives from inside the poll's own refresh pass) short-circuits here, so we never await the
    // very pass that called us — a self-deadlock — and skip a refresh that cannot succeed anyway.
    let stat = await statIfOwned();
    if (!stat) return fallback;

    // Wait for a concurrent pass so two never run on the same state at once: cleanupResources has
    // already dropped the watchers entry, so that pass has lost ownership and unwinds without
    // publishing. Then re-stat, since it may have observed further growth while it unwound.
    const inflight = state.activeRefresh;
    if (inflight) {
      // runRefresh isolates its own errors; nothing to recover here.
      await inflight.catch(() => undefined);
      stat = await statIfOwned();
      if (!stat) return fallback;
    }

    await this.runFileLane(state, stat, adapter, false, { ending: true });
    return this.laneOwned(state, true) ? state.lastMetrics : fallback;
  }

  /** Set the seed-time body-path state (start path; no event). File+delta refresh the lane too. */
  private applyBodyResultToState(
    state: WatcherState,
    adapter: SessionReaderAdapter,
    result: GetOrParseResult,
    stat: fs.Stats | null,
  ): void {
    state.lastMessageCount = result.session.metrics.messageCount;
    state.lastChunkCount = buildChunks(result.session.messages).length;
    state.lastSourceVersion = result.sourceVersion;
    state.lastMetrics = this.toMetricsSnapshot(result.session.metrics);
    state.lastSummaryMetrics = result.session.metrics;
    state.inLane = false;
    if (stat && this.isLaneEligible(adapter)) this.refreshLaneFromResult(state, result, stat);
  }

  /**
   * Publish a body-path result (a session with a cache entry): the existing delta /
   * full-refetch semantics, plus keeping the lane state current for a later eviction.
   */
  private async publishBodyResult(
    state: WatcherState,
    stat: fs.Stats,
    adapter: SessionReaderAdapter,
    result: GetOrParseResult,
    isReplacement: boolean,
  ): Promise<void> {
    const { sessionId } = state;
    const { session, sourceChangeKind, sourceVersion, boundaryFold } = result;
    const changedCacheHit =
      sourceChangeKind === 'cache-hit' && sourceVersion !== state.lastSourceVersion;

    const newMessageCount = session.metrics.messageCount - state.lastMessageCount;
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

    this.markStatConsumed(state, stat);
    state.lastSourceVersion = sourceVersion;
    state.lastMessageCount = session.metrics.messageCount;
    state.lastChunkCount = chunks.length;
    state.lastMetrics = this.toMetricsSnapshot(session.metrics);
    state.lastSummaryMetrics = session.metrics;
    if (this.isLaneEligible(adapter)) this.refreshLaneFromResult(state, result, stat);

    if (isReplacement || changedCacheHit || requiresCanonicalRefetch(sourceChangeKind)) {
      await this.events.publish('session.transcript.updated', {
        kind: 'full-refetch-required',
        sessionId,
        transcriptPath: state.filePath,
        sourceChangeKind,
      });
      return;
    }

    const isInPlaceTailFold = boundaryFold && newMessageCount === 0 && !isFullRefresh;

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
