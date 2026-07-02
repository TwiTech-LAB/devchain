/**
 * Antigravity (`agy`) session-reader adapter.
 *
 * Bridges the pure {@link AntigravityTranscriptReader} to the provider-agnostic
 * {@link SessionReaderAdapter} contract. `agy` is a DB-backed source
 * (`sourceKind = 'db'`, `incrementalMode = 'snapshot'`): the persisted
 * `transcript_path` is the per-conversation `conversations/<convId>.db` (real
 * file → passes the validator, gives the WAL fast-wake hint), while messages are
 * read from the sibling `transcript_full.jsonl` resolved from the conversation
 * id (= `providerSessionId`).
 *
 * Discovery is scan-based (no hook transcriptPath; agy hooks are backlog): the
 * conversation id for a workspace is read from `history.jsonl` (append log of
 * `workspace → conversationId`) with a `cache/last_conversations.json` fallback,
 * window-matched to the launch time — the codex/opencode discovery semantics.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
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
import type { UnifiedSession, UnifiedMessage } from '../dtos/unified-session.types';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';
import { ValidationError } from '../../../common/errors/error-types';
import { AntigravityTranscriptReader } from '../readers/antigravity-transcript.reader';
import { AntigravityMetricsReader } from '../readers/antigravity-metrics.reader';
import { mapAgyModelToPricing } from '../readers/antigravity-model-pricing';

/** Root (relative to home) of the agy data dir; must match PROVIDER_ROOTS. */
const AGY_ROOT = '.gemini/antigravity-cli';
/** Per-conversation SQLite stores live here (`conversations/<convId>.db`). */
const CONVERSATIONS_DIR = 'conversations';
/** Append log mapping `workspace → conversationId` (newest last). */
const HISTORY_FILE = 'history.jsonl';
/** Map of `workspace → most-recent conversationId`. */
const LAST_CONVERSATIONS_FILE = 'cache/last_conversations.json';
/** Launch-window for discovery: match conversations created within ±2min of launch. */
const DISCOVERY_WINDOW_MS = 120_000;

interface RawHistoryEntry {
  workspace?: string;
  conversationId?: string;
  timestamp?: number;
}

@Injectable()
export class AntigravitySessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'agy';
  readonly incrementalMode = 'snapshot' as const;
  readonly sourceKind = 'db' as const;
  readonly allowedRoots: string[];

  private readonly logger = new Logger(AntigravitySessionReaderAdapter.name);
  private readonly root: string;
  private readonly reader: AntigravityTranscriptReader;
  private readonly metricsReader: AntigravityMetricsReader;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.root = path.join(os.homedir(), AGY_ROOT);
    this.allowedRoots = [this.root];
    this.reader = new AntigravityTranscriptReader(this.pricingService);
    this.metricsReader = new AntigravityMetricsReader();
  }

  /**
   * Discover the agy conversation launched for this context. Resolves the
   * conversation id for the workspace from `history.jsonl` (+ a
   * `last_conversations.json` fallback), keeps only ids whose `.db` exists and
   * (when a launch time is known) fall within the discovery window, and maps each
   * to a {@link SessionFileInfo} carrying the `.db` path + `providerSessionId`.
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    const directory = path.resolve(context.projectRoot);
    const startedAtMs = context.sessionStartedAt?.getTime();

    const candidates = await this.collectCandidateConversationIds(directory);
    if (candidates.size === 0) return [];

    const ranked: Array<{ info: SessionFileInfo; sortTs: number }> = [];
    for (const [convId, historyTs] of candidates) {
      const dbPath = this.dbPathFor(convId);
      const stat = await this.statFile(dbPath);
      if (!stat) continue; // `.db` must exist to be a real session

      const refTs = historyTs ?? stat.mtimeMs;
      if (startedAtMs !== undefined && Math.abs(refTs - startedAtMs) > DISCOVERY_WINDOW_MS) {
        continue;
      }

      ranked.push({
        info: {
          filePath: dbPath,
          providerName: this.providerName,
          providerSessionId: convId,
          sizeBytes: 0, // session size is written post-read (from the JSONL)
          lastModified: new Date(stat.mtimeMs).toISOString(),
        },
        sortTs: refTs,
      });
    }

    ranked.sort((a, b) =>
      startedAtMs !== undefined
        ? Math.abs(a.sortTs - startedAtMs) - Math.abs(b.sortTs - startedAtMs)
        : b.sortTs - a.sortTs,
    );
    return ranked.map((r) => r.info);
  }

  /** Opaque DB freshness token: `{ maxUpdated, jsonl, db }` for the conversation. */
  async getFreshnessToken(sourceRef: SessionSourceRef): Promise<unknown> {
    const convId = this.requireConversationId(sourceRef.providerSessionId);
    return this.reader.getFreshness(this.resolveDbPath(sourceRef), convId);
  }

  /** Parse the full session located by `sourceRef.providerSessionId` (= convId). */
  async parseFullSession(filePath: string, sourceRef?: SessionSourceRef): Promise<UnifiedSession> {
    const convId = this.requireConversationId(sourceRef?.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef, filePath);
    const { session } = await this.reader.readSession(dbPath, convId);
    this.applyTokenMetrics(session, dbPath, convId);
    return session;
  }

  /**
   * Snapshot incremental parse: re-read the full session (the cache replaces its
   * message array). Byte-offset/delta semantics don't apply to a DB source.
   */
  async parseIncremental(
    filePath: string,
    _options: ParseOptions,
    sourceRef?: SessionSourceRef,
  ): Promise<IncrementalResult> {
    const convId = this.requireConversationId(sourceRef?.providerSessionId);
    const dbPath = this.resolveDbPath(sourceRef, filePath);
    const { session, sizeBytes } = await this.reader.readSession(dbPath, convId);
    this.applyTokenMetrics(session, dbPath, convId);
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
   * Not supported for a DB source: a bare `.db` path can't locate the JSONL
   * without the conversation id. Callers must use `parseFullSession` /
   * `parseIncremental` with a `SessionSourceRef` carrying `providerSessionId`.
   */
  async parseSessionFile(_filePath: string, _options?: ParseOptions): Promise<IncrementalResult> {
    throw new ValidationError(
      'agy is a DB-backed source: parseSessionFile requires a SessionSourceRef with providerSessionId — use parseFullSession instead',
      { providerName: this.providerName },
    );
  }

  /** Watch the conversations dir for new/updated `.db` files as a wake-up hint. */
  getWatchPaths(_projectRoot: string): string[] {
    return [path.join(this.root, CONVERSATIONS_DIR)];
  }

  /** Token-only cost over parsed entries (zeros until P1-4 supplies usage). */
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

  /**
   * Decode authoritative token usage from `conversations/<convId>.db` and fold it
   * into the session metrics (the JSONL transcript carries no token data). Cost
   * and context-window come from `PricingService` via the agy model→pricing-key
   * map; GPT-OSS 120B is the free open-weight model ($0). On any failure the
   * decode pushes `metrics.warnings[]` (absent/id-mismatched/undecodable `.db`) so
   * a session is NEVER silently reported as token=0/cost=0.
   */
  private applyTokenMetrics(session: UnifiedSession, dbPath: string, convId: string): void {
    const decoded = this.metricsReader.decode(dbPath, convId);
    const warnings = [...(session.warnings ?? []), ...decoded.warnings];

    const metrics = session.metrics;
    metrics.inputTokens = decoded.inputTokens;
    metrics.outputTokens = decoded.outputTokens;
    metrics.cacheReadTokens = decoded.cacheReadTokens;
    metrics.cacheCreationTokens = decoded.cacheCreationTokens;
    metrics.totalTokens =
      decoded.inputTokens +
      decoded.outputTokens +
      decoded.cacheReadTokens +
      decoded.cacheCreationTokens;
    metrics.totalContextTokens = decoded.lastContextTokens;

    const model = decoded.modelId ?? decoded.displayName;
    if (model) metrics.primaryModel = model;

    const mapping = mapAgyModelToPricing(decoded.displayName, decoded.modelId);
    if (mapping?.isFree) {
      metrics.costUsd = 0;
      if (mapping.freeContextWindow) metrics.contextWindowTokens = mapping.freeContextWindow;
    } else if (mapping?.pricingKey) {
      metrics.costUsd = this.pricingService.calculateMessageCost(
        mapping.pricingKey,
        decoded.inputTokens,
        decoded.outputTokens,
        decoded.cacheReadTokens,
        decoded.cacheCreationTokens,
      );
      metrics.contextWindowTokens = this.pricingService.getContextWindowSize(mapping.pricingKey);
    } else if (model) {
      // Decoded a model but no pricing mapping — loud, not a silent $0.
      warnings.push(`agy metrics: no pricing mapping for model "${model}" — cost reported as $0`);
      metrics.costUsd = 0;
    }

    if (warnings.length > 0) session.warnings = warnings;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private dbPathFor(convId: string): string {
    return path.join(this.root, CONVERSATIONS_DIR, `${convId}.db`);
  }

  /** Prefer the resolved source-ref path (= persisted `transcript_path`). */
  private resolveDbPath(sourceRef?: SessionSourceRef, filePath?: string): string {
    return sourceRef?.filePath ?? filePath ?? '';
  }

  private requireConversationId(providerSessionId?: string): string {
    if (!providerSessionId) {
      throw new ValidationError(
        'agy session read requires providerSessionId (conversation id) on the SessionSourceRef',
        { providerName: this.providerName },
      );
    }
    return providerSessionId;
  }

  /**
   * Collect conversation ids for `directory` from `history.jsonl` (each kept at
   * its newest timestamp) plus the `last_conversations.json` fallback (no
   * timestamp → ranked by `.db` mtime later).
   */
  private async collectCandidateConversationIds(
    directory: string,
  ): Promise<Map<string, number | undefined>> {
    const candidates = new Map<string, number | undefined>();

    for (const entry of await this.readHistory()) {
      if (entry.workspace !== directory) continue;
      if (typeof entry.conversationId !== 'string' || entry.conversationId.length === 0) continue;
      const ts = typeof entry.timestamp === 'number' ? entry.timestamp : undefined;
      const existing = candidates.get(entry.conversationId);
      if (existing === undefined || (ts !== undefined && ts > existing)) {
        candidates.set(entry.conversationId, ts);
      }
    }

    const fallback = await this.readLastConversation(directory);
    if (fallback && !candidates.has(fallback)) {
      candidates.set(fallback, undefined);
    }

    return candidates;
  }

  private async readHistory(): Promise<RawHistoryEntry[]> {
    try {
      const content = await fs.readFile(path.join(this.root, HISTORY_FILE), 'utf8');
      const entries: RawHistoryEntry[] = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as RawHistoryEntry);
        } catch {
          // skip malformed history line
        }
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.debug({ error }, 'Failed to read agy history.jsonl — falling back');
      }
      return [];
    }
  }

  private async readLastConversation(directory: string): Promise<string | null> {
    try {
      const content = await fs.readFile(path.join(this.root, LAST_CONVERSATIONS_FILE), 'utf8');
      const map = JSON.parse(content) as Record<string, unknown>;
      const value = map[directory];
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.debug({ error }, 'Failed to read agy last_conversations.json');
      }
      return null;
    }
  }

  private async statFile(filePath: string): Promise<{ mtimeMs: number } | null> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return { mtimeMs: stat.mtime.getTime() };
    } catch {
      return null;
    }
  }
}
