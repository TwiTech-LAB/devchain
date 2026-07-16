/**
 * Session Reader Adapter Interface
 *
 * Defines the contract for provider-specific session file reading logic.
 * Each supported provider (claude, codex, opencode, agy, copilot) implements this interface
 * to encapsulate session discovery, parsing, and cost calculation.
 */

import * as fs from 'node:fs/promises';
import type { UnifiedSession, UnifiedMetrics } from '../dtos/unified-session.types';

/**
 * A resolved reference to the source of a session's transcript data.
 *
 * Generalizes the source layer from "a transcript file path" to a source-ref
 * so non-file adapters (e.g. a single shared SQLite DB holding many sessions)
 * can locate the correct session via `providerSessionId`.
 *
 * NOTE: `kind` (source-type routing — does the size/watcher logic treat this as a
 * file on disk or a DB-backed source) is DISTINCT from `getFreshnessToken()`
 * (staleness detection). Do not conflate them.
 */
export interface SessionSourceRef {
  /**
   * Absolute path to the source container on disk. For file sources this is the
   * transcript file; for DB sources this is the `.db` container path (still a
   * real file, so it passes the path validator).
   */
  filePath: string;
  /**
   * Provider-specific session identifier. Required for DB sources to locate the
   * session inside a shared container; absent/ignored for one-file-per-session
   * adapters.
   */
  providerSessionId?: string;
  /** Provider name that owns this source (lowercased). */
  providerName: string;
  /** Source type: a single transcript file, or a row/range inside a DB container. */
  kind: 'file' | 'db';
}

/**
 * Default freshness token for file-backed sources: `{ mtimeMs, size, dev, ino }`.
 *
 * Used by `SessionCacheService` when an adapter does not implement
 * `getFreshnessToken()`. The token is treated as opaque by the cache (compared
 * via deep equality), so the exact shape only matters to whoever produces it.
 */
export async function defaultFileFreshnessToken(
  sourceRef: SessionSourceRef,
): Promise<{ mtimeMs: number; size: number; dev: number; ino: number }> {
  const stat = await fs.stat(sourceRef.filePath);
  return {
    mtimeMs: stat.mtime.getTime(),
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * Context provided to the adapter for discovering session files
 */
export interface SessionDiscoveryContext {
  /** Absolute path to the project root */
  projectRoot: string;
  /** Optional transcript path persisted from hooks metadata */
  transcriptPath?: string;
  /** Optional provider-specific session identifier (e.g., Claude session ID) */
  providerSessionId?: string;
  /**
   * When the devchain session was launched. DB-backed adapters use this to
   * window-match the provider session created around launch time. Ignored by
   * one-file-per-session adapters.
   */
  sessionStartedAt?: Date;
  /** The devchain session id being discovered (diagnostics / disambiguation). */
  sessionId?: string;
}

/**
 * Information about a discovered session file
 */
export interface SessionFileInfo {
  /** Absolute path to the session file */
  filePath: string;
  /** Provider name that owns this file */
  providerName: string;
  /** Provider-specific session identifier extracted from the file */
  providerSessionId?: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modification timestamp (ISO 8601 UTC) */
  lastModified: string;
}

/**
 * Options for parsing a session file
 */
export interface ParseOptions {
  /** Maximum number of messages to return (undefined = all) */
  maxMessages?: number;
  /** Byte offset to start reading from (for pagination) */
  byteOffset?: number;
  /** Whether to include tool call/result messages */
  includeToolCalls?: boolean;
}

/**
 * Result of incremental parsing
 */
export interface IncrementalResult {
  /** Whether there are more messages beyond this batch */
  hasMore: boolean;
  /** Byte offset for the next read (pass back to ParseOptions.byteOffset) */
  nextByteOffset: number;
  /** Number of messages returned in this batch */
  messageCount: number;
  /** Raw parsed entries (adapter-specific, normalized by the service layer) */
  entries: unknown[];
  /** Metrics computed from the parsed entries (used by cache for incremental merge) */
  metrics?: UnifiedMetrics;
  /** Degradation warnings from the incremental parse (merged by cache service) */
  warnings?: string[];
}

/**
 * Provider-agnostic metadata extracted from a candidate transcript file's content.
 *
 * Populated by adapters that implement the optional
 * {@link SessionReaderAdapter.extractCandidateMetadata} method. The discovery
 * pipeline uses these fields for candidate matching (provider session id,
 * workspace path, timestamp) without any provider-specific knowledge. Each field
 * is optional — the adapter surfaces only what its native format carries.
 */
export interface TranscriptCandidateMetadata {
  /** Provider-specific session identifier parsed from the file content. */
  providerSessionId?: string;
  /** Absolute workspace path the session was launched from. */
  workspacePath?: string;
  /** Session start timestamp as encoded in the file (ISO 8601 or provider-native). */
  timestamp?: string;
}

export interface AdapterSummaryResult {
  /** Complete wire-compatible metrics; fields named in approximateFields are best-effort. */
  metrics: UnifiedMetrics;
  /** Parser degradation warnings, when the lightweight read could not be fully exact. */
  warnings?: string[];
  /** Fields guaranteed to match parseFullSession for the same source revision. */
  exactFields: readonly (keyof UnifiedMetrics)[];
  /** Fields that may lag or use a documented proxy until the next full parse. */
  approximateFields?: readonly (keyof UnifiedMetrics)[];
}

export const EXACT_SUMMARY_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'totalTokens',
  'totalContextConsumption',
  'compactionCount',
  'phaseBreakdowns',
  'visibleContextTokens',
  'totalContextTokens',
  'contextWindowTokens',
  'contextBreakdown',
  'costUsd',
  'nativeCost',
  'primaryModel',
  'modelsUsed',
  'durationMs',
  'messageCount',
  'isOngoing',
] as const satisfies readonly (keyof UnifiedMetrics)[];

/**
 * Provider-agnostic adapter interface for reading session files.
 *
 * Each provider (claude, codex, opencode, agy, copilot) implements this to encapsulate
 * discovery, parsing, cost calculation, and watch-path resolution.
 */
export interface SessionReaderAdapter {
  /** Provider name (e.g., 'claude', 'codex', 'agy') */
  readonly providerName: string;

  /**
   * How parseIncremental results should be merged by the cache service.
   *
   * - `delta`: parseIncremental returns only new entries since last offset.
   * - `snapshot`: parseIncremental returns a full session snapshot.
   */
  readonly incrementalMode: 'delta' | 'snapshot';

  /**
   * Source type this adapter reads from. Drives `SessionSourceRef.kind`
   * (size_bytes / watcher routing). Defaults to `'file'` when omitted, so
   * existing file adapters need no change.
   */
  readonly sourceKind?: 'file' | 'db';

  /** Allowed root directories for session file access (security boundary) */
  readonly allowedRoots: string[];

  /**
   * Discover session files for the given context
   *
   * @param context - Discovery context with project root and optional hints
   * @returns Array of discovered session file info
   */
  discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]>;

  /**
   * Parse an entire session file and return raw entries
   *
   * @param filePath - Absolute path to the session file
   * @param options - Parse options (max messages, include tool calls, etc.)
   * @returns Incremental result with parsed entries
   */
  parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult>;

  /**
   * Parse a session file incrementally from a byte offset
   *
   * @param filePath - Absolute path to the session file
   * @param options - Parse options with byteOffset for incremental reads
   * @param sourceRef - Resolved source reference (carries `providerSessionId`
   *   for DB-backed adapters). Optional for backward compatibility: file
   *   adapters that key solely on `filePath` may ignore it.
   * @returns Incremental result with new entries since the offset
   */
  parseIncremental(
    filePath: string,
    options: ParseOptions,
    sourceRef?: SessionSourceRef,
  ): Promise<IncrementalResult>;

  /**
   * Get filesystem paths to watch for changes (new sessions, file updates)
   *
   * @param projectRoot - Absolute path to the project root
   * @returns Array of absolute paths or glob patterns to watch
   */
  getWatchPaths(projectRoot: string): string[];

  /**
   * Calculate cost for the given entries
   *
   * @param entries - Raw parsed entries from parseSessionFile or parseIncremental
   * @param model - Model identifier for pricing lookup
   * @returns Total cost in USD
   */
  calculateCost(entries: unknown[], model: string): number;

  /**
   * Parse a full session file into a UnifiedSession.
   *
   * @param filePath - Absolute path to the session file
   * @param sourceRef - Resolved source reference (carries `providerSessionId`
   *   for DB-backed adapters). Optional for backward compatibility: file
   *   adapters that key solely on `filePath` may ignore it.
   * @returns Fully parsed session with messages, metrics, and metadata
   */
  parseFullSession(filePath: string, sourceRef?: SessionSourceRef): Promise<UnifiedSession>;

  /**
   * Read complete summary metrics without constructing a UnifiedSession message graph.
   *
   * Optional capability: absence, a `null` result, or an exception means the source is
   * unavailable for a lightweight read and callers must fall back to parseFullSession.
   * Implementations must declare any non-parity fields in `approximateFields`; every other
   * metric is required to match a full parse at the same source revision.
   */
  getSummary?(sourceRef: SessionSourceRef): Promise<AdapterSummaryResult | null>;

  /**
   * Compute an opaque freshness token for the source. The cache compares tokens
   * by deep equality to decide whether cached data is stale — the token is never
   * introspected, so its shape is adapter-defined (file: `{ mtimeMs, size, dev, ino }`,
   * DB: e.g. `{ count, maxUpdated }`).
   *
   * Optional: when omitted, the cache falls back to {@link defaultFileFreshnessToken}.
   *
   * @param sourceRef - Resolved source reference
   */
  getFreshnessToken?(sourceRef: SessionSourceRef): Promise<unknown>;

  /**
   * Extract candidate-discovery metadata from raw transcript content (file head).
   *
   * Optional: when implemented, the transcript discovery pipeline uses the
   * returned metadata to match candidates by provider session id, workspace
   * path, and timestamp — with zero provider-specific knowledge in the pipeline.
   * When omitted, the pipeline skips metadata-based matching for this provider.
   *
   * @param content - Raw file content (typically the first few KB)
   * @returns Extracted metadata, or `undefined` when no metadata is present
   *   (malformed content, missing session header, etc.)
   */
  extractCandidateMetadata?(content: string): TranscriptCandidateMetadata | undefined;

  /**
   * Extract a timestamp from raw transcript content for candidate matching.
   *
   * Optional: when omitted, the discovery pipeline falls back to its generic
   * default extractor (a regex matching any `"timestamp": "..."` JSON field).
   * Override only when the provider's timestamp encoding differs from that
   * generic format.
   *
   * @param content - Raw file content
   * @returns Parsed timestamp, or `null` when none is found
   */
  extractContentTimestamp?(content: string): Date | null;
}
