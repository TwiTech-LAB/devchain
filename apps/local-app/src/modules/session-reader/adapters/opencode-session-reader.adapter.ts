/**
 * OpenCode session-reader adapter.
 *
 * Bridges the pure OpenCode SQLite readers to the provider-agnostic
 * {@link SessionReaderAdapter} contract. Unlike the file adapters, OpenCode is a
 * DB-backed source: a single SQLite container holds every session, so the
 * adapter declares `sourceKind = 'db'` and resolves the target session via
 * `SessionSourceRef.providerSessionId` (the `ses_…` id) threaded through the
 * cache (Task 1). Snapshot incremental mode (gemini pattern): each refresh
 * re-reads the full session and the cache replaces the message array.
 *
 * Routing is data-driven, not version-driven: the table that holds the session
 * picks the reader (`session` → v1, `session_v2` → v2), so a transcript stays
 * readable after the host switches OpenCode versions.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  SessionReaderAdapter,
  SessionDiscoveryContext,
  SessionFileInfo,
  SessionSourceRef,
  ParseOptions,
  IncrementalResult,
} from './session-reader-adapter.interface';
import { EXACT_SUMMARY_FIELDS } from './session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMessage } from '../dtos/unified-session.types';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';
import { ValidationError } from '../../../common/errors/error-types';
import { OpencodeSqliteV1Reader } from '../readers/opencode-sqlite.v1.reader';
import { OpencodeSqliteV2Reader } from '../readers/opencode-sqlite.v2.reader';
import {
  inspectOpencodeDb,
  type OpencodeLayout,
  type OpencodeSessionCandidate,
  type OpencodeTranscriptReader,
} from '../readers/opencode-sqlite.db';

/** Root (relative to home) of the OpenCode data dir; must match PROVIDER_ROOTS. */
const OPENCODE_ROOT = '.local/share/opencode';
/** The single SQLite container filename inside the root. */
const OPENCODE_DB_FILE = 'opencode.db';
/** Launch-window for discovery: match sessions created within ±2min of launch. */
const DISCOVERY_WINDOW_MS = 120_000;
const APPROXIMATE_SUMMARY_FIELDS = [
  'visibleContextTokens',
  'totalContextConsumption',
  'phaseBreakdowns',
] as const;

@Injectable()
export class OpenCodeSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'opencode';
  readonly incrementalMode = 'snapshot' as const;
  readonly sourceKind = 'db' as const;
  readonly reportsContextWindow = true as const;
  readonly allowedRoots: string[];

  private readonly logger = new Logger(OpenCodeSessionReaderAdapter.name);
  private readonly dbPath: string;
  private readonly readers: Record<OpencodeLayout, OpencodeTranscriptReader>;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    const root = path.join(os.homedir(), OPENCODE_ROOT);
    this.allowedRoots = [root];
    this.dbPath = path.join(root, OPENCODE_DB_FILE);
    this.readers = {
      v1: new OpencodeSqliteV1Reader(this.pricingService),
      v2: new OpencodeSqliteV2Reader(this.pricingService),
    };
  }

  /**
   * Discover the OpenCode session(s) launched for this context via a structured
   * SQL match on the session `directory` / `project.worktree` within the launch
   * window, over every session layout the container holds. Returns one
   * {@link SessionFileInfo} per candidate (all share the container `dbPath`,
   * distinguished by `providerSessionId`). The persistence
   * listener applies `(path, providerSessionId)` dedupe + an ambiguity guard.
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    if (!context.sessionStartedAt) {
      this.logger.debug(
        { projectRoot: context.projectRoot, sessionId: context.sessionId },
        'OpenCode discovery needs sessionStartedAt — skipping this attempt',
      );
      return [];
    }

    const directory = path.resolve(context.projectRoot);
    const startedAtMs = context.sessionStartedAt.getTime();
    let candidates: OpencodeSessionCandidate[];
    try {
      const { layouts } = inspectOpencodeDb(this.dbPath);
      const query = { directory, startedAtMs, windowMs: DISCOVERY_WINDOW_MS };
      candidates = mergeCandidates(
        [...layouts].flatMap((layout) =>
          this.readers[layout].findSessionCandidates(this.dbPath, query),
        ),
        startedAtMs,
      );
    } catch (error) {
      // Container may not exist yet on first launch — let discovery retry.
      this.logger.debug(
        { error: String((error as Error)?.message ?? error), directory },
        'OpenCode candidate query failed — will retry',
      );
      return [];
    }

    return candidates.map((c) => ({
      filePath: this.dbPath,
      providerName: this.providerName,
      providerSessionId: c.providerSessionId,
      sizeBytes: 0, // container size is not session-specific; size is written post-read
      lastModified: new Date(c.timeUpdated).toISOString(),
    }));
  }

  /** Opaque DB freshness token: `{ count, maxUpdated }` for the session. */
  async getFreshnessToken(sourceRef: SessionSourceRef): Promise<unknown> {
    const providerSessionId = this.requireSessionId(sourceRef.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef);
    return this.readerFor(dbPath, providerSessionId).getFreshness(dbPath, providerSessionId);
  }

  /** Parse the full session located by `sourceRef.providerSessionId`. */
  async parseFullSession(filePath: string, sourceRef?: SessionSourceRef): Promise<UnifiedSession> {
    const providerSessionId = this.requireSessionId(sourceRef?.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef, filePath);
    return this.readerFor(dbPath, providerSessionId).readSession(dbPath, providerSessionId).session;
  }

  async getSummary(sourceRef: SessionSourceRef) {
    const providerSessionId = this.requireSessionId(sourceRef.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef);
    const { metrics } = this.readerFor(dbPath, providerSessionId).readSummary(
      dbPath,
      providerSessionId,
    );
    return {
      metrics,
      exactFields: EXACT_SUMMARY_FIELDS.filter(
        (field) => !APPROXIMATE_SUMMARY_FIELDS.includes(field as never),
      ),
      approximateFields: APPROXIMATE_SUMMARY_FIELDS,
    };
  }

  /**
   * Snapshot incremental parse: re-read the full session (the cache replaces its
   * message array). `byteOffset`/delta semantics don't apply to a DB source.
   */
  async parseIncremental(
    filePath: string,
    _options: ParseOptions,
    sourceRef?: SessionSourceRef,
  ): Promise<IncrementalResult> {
    const providerSessionId = this.requireSessionId(sourceRef?.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef, filePath);
    const { session, sizeBytes } = this.readerFor(dbPath, providerSessionId).readSession(
      dbPath,
      providerSessionId,
    );
    return {
      hasMore: false,
      nextByteOffset: sizeBytes,
      messageCount: session.messages.length,
      entries: session.messages,
      metrics: session.metrics,
      warnings: session.warnings,
    };
  }

  /**
   * Not supported for a DB source: a bare file path can't locate a session
   * inside the shared container. Callers must use `parseFullSession` /
   * `parseIncremental` with a `SessionSourceRef` carrying `providerSessionId`.
   */
  async parseSessionFile(_filePath: string, _options?: ParseOptions): Promise<IncrementalResult> {
    throw new ValidationError(
      'OpenCode is a DB-backed source: parseSessionFile requires a SessionSourceRef with providerSessionId — use parseFullSession instead',
      { providerName: this.providerName },
    );
  }

  /** Watch the WAL sidecar as a wake-up hint (live updates land in Task 4). */
  getWatchPaths(_projectRoot: string): string[] {
    return [`${this.dbPath}-wal`];
  }

  /** Token-only cost over parsed entries (mirrors the file adapters). */
  calculateCost(entries: unknown[], model: string): number {
    let total = 0;
    for (const entry of entries) {
      const usage = (entry as UnifiedMessage).usage;
      if (usage) {
        total += this.pricingService.calculateMessageCost(
          model,
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheCreation,
        );
      }
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * The reader for the layout that holds the session. An id that no layout holds
   * goes to the newest layout present, whose reader reports it as not found.
   */
  private readerFor(dbPath: string, providerSessionId: string): OpencodeTranscriptReader {
    const { layouts, holder } = inspectOpencodeDb(dbPath, providerSessionId);
    return this.readers[holder ?? (layouts.has('v2') ? 'v2' : 'v1')];
  }

  /** Prefer the resolved source-ref path (= persisted `transcript_path`). */
  private resolveDbPath(sourceRef?: SessionSourceRef, filePath?: string): string {
    return sourceRef?.filePath ?? filePath ?? this.dbPath;
  }

  private requireSessionId(providerSessionId?: string): string {
    if (!providerSessionId) {
      throw new ValidationError(
        'OpenCode session read requires providerSessionId (ses_…) on the SessionSourceRef',
        { providerName: this.providerName },
      );
    }
    return providerSessionId;
  }
}

/**
 * One candidate per session id, ranked by closeness to the launch time. A
 * migrated session appears in both layouts; it keeps its newest `timeUpdated`.
 */
function mergeCandidates(
  candidates: OpencodeSessionCandidate[],
  startedAtMs: number,
): OpencodeSessionCandidate[] {
  const byId = new Map<string, OpencodeSessionCandidate>();
  for (const c of candidates) {
    const seen = byId.get(c.providerSessionId);
    if (!seen || c.timeUpdated > seen.timeUpdated) byId.set(c.providerSessionId, c);
  }
  return [...byId.values()].sort(
    (a, b) => Math.abs(a.timeCreated - startedAtMs) - Math.abs(b.timeCreated - startedAtMs),
  );
}
