/**
 * Session Reader Adapter Interface
 *
 * Defines the contract for provider-specific session file reading logic.
 * Each supported provider (claude, codex, gemini) implements this interface
 * to encapsulate session discovery, parsing, and cost calculation.
 */

import type { UnifiedSession, UnifiedMetrics } from '../dtos/unified-session.types';

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
 * Provider-agnostic adapter interface for reading session files.
 *
 * Each provider (claude, codex, gemini) implements this to encapsulate
 * discovery, parsing, cost calculation, and watch-path resolution.
 */
export interface SessionReaderAdapter {
  /** Provider name (e.g., 'claude', 'codex', 'gemini') */
  readonly providerName: string;

  /**
   * How parseIncremental results should be merged by the cache service.
   *
   * - `delta`: parseIncremental returns only new entries since last offset.
   * - `snapshot`: parseIncremental returns a full session snapshot.
   */
  readonly incrementalMode: 'delta' | 'snapshot';

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
   * @returns Incremental result with new entries since the offset
   */
  parseIncremental(filePath: string, options: ParseOptions): Promise<IncrementalResult>;

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
   * @returns Fully parsed session with messages, metrics, and metadata
   */
  parseFullSession(filePath: string): Promise<UnifiedSession>;
}
