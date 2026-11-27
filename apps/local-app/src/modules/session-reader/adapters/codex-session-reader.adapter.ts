import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type {
  SessionReaderAdapter,
  SessionDiscoveryContext,
  SessionFileInfo,
  ParseOptions,
  IncrementalResult,
  TranscriptCandidateMetadata,
} from './session-reader-adapter.interface';
import { EXACT_SUMMARY_FIELDS } from './session-reader-adapter.interface';
import type { UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { TranscriptTurnState } from '../../events/signals/session-turn-signals';
import { parseCodexJsonl, type TokenSnapshot } from '../parsers/codex-jsonl.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';
import { PROVIDER_TRANSCRIPT_SOURCE_KINDS } from '../services/transcript-path-validator.service';
import { isSyncthingMarker } from '../../../common/constants/syncthing-markers';

const CODEX_ROOT = '.codex/sessions/';
const PROVIDER_SESSION_ID_HEAD_BYTES = 8 * 1024;
const THREAD_ID = '[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}';
const threadIdPattern = new RegExp(`^${THREAD_ID}$`, 'i');
const rolloutPattern = new RegExp(`rollout-\\d{4}-\\d{2}-\\d{2}T[\\d-]+-(${THREAD_ID})$`, 'i');

type CodexSessionMeta = {
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  history_base?: { thread_id?: unknown } | null;
};

function parseCodexMetaLine(line: string): CodexSessionMeta | undefined {
  try {
    const entry = JSON.parse(line) as { type?: unknown; payload?: CodexSessionMeta } | null;
    if (entry?.type === 'session_meta') return entry.payload;
  } catch {
    return undefined;
  }
}

export function codexRolloutSessionId(filePath: string): string | null {
  return rolloutPattern.exec(path.basename(filePath, '.jsonl'))?.[1] ?? null;
}

export interface CodexRolloutHeader {
  providerSessionId?: string;
  workspacePath?: string;
  /** Null when the rollout declares a history base without a valid thread ID. */
  historyBaseId?: string | null;
}

export async function readCodexRolloutHeader(
  stream: Readable,
): Promise<CodexRolloutHeader | undefined> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const meta = parseCodexMetaLine(line);
    if (!meta) return undefined;
    const base = meta.history_base;
    return {
      providerSessionId: typeof meta.id === 'string' ? meta.id.toLowerCase() : undefined,
      workspacePath: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      historyBaseId:
        base == null
          ? undefined
          : typeof base.thread_id === 'string' && threadIdPattern.test(base.thread_id)
            ? base.thread_id.toLowerCase()
            : null,
    };
  }
}

export interface CodexFileMetadata {
  providerSessionId: string | null;
  metaTimestamp: string | null;
  metaCwd: string | null;
}

/**
 * Parse the first newline-terminated JSONL event of a Codex rollout and map its
 * `session_meta` payload to the provider-agnostic
 * {@link TranscriptCandidateMetadata} shape. Returns an empty object when the
 * content is partial, malformed, or not a `session_meta` event.
 */
function parseCodexSessionMeta(content: string): TranscriptCandidateMetadata {
  const firstNewline = content.indexOf('\n');
  if (firstNewline < 0) {
    return {};
  }

  const meta = parseCodexMetaLine(content.slice(0, firstNewline));
  if (!meta) return {};
  const { id, timestamp, cwd } = meta;

  return {
    providerSessionId: typeof id === 'string' && id.trim().length > 0 ? id : undefined,
    timestamp: typeof timestamp === 'string' && timestamp.trim().length > 0 ? timestamp : undefined,
    workspacePath: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined,
  };
}

/**
 * Compatibility wrapper around {@link parseCodexSessionMeta} that preserves the
 * `CodexFileMetadata` shape (null instead of undefined) for existing consumers.
 * The transcript-persistence listener uses this until it migrates to the
 * adapter's `extractCandidateMetadata` method.
 */
export function extractCodexMetadataFromContent(content: string): CodexFileMetadata {
  const meta = parseCodexSessionMeta(content);
  return {
    providerSessionId: meta.providerSessionId ?? null,
    metaTimestamp: meta.timestamp ?? null,
    metaCwd: meta.workspacePath ?? null,
  };
}

@Injectable()
export class CodexSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'codex';
  readonly sourceKind = PROVIDER_TRANSCRIPT_SOURCE_KINDS[this.providerName];
  readonly incrementalMode = 'delta' as const;
  readonly reportsContextWindow = true as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(CodexSessionReaderAdapter.name);
  private readonly homeDir: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.allowedRoots = [path.join(this.homeDir, CODEX_ROOT)];
  }

  turnState(metrics: UnifiedMetrics): TranscriptTurnState {
    return { open: metrics.isOngoing, atMs: null };
  }

  /**
   * Discover Codex session JSONL files.
   * Primary: use transcriptPath from context.
   * Fallback: scan date-organized directories for rollout files.
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    const results: SessionFileInfo[] = [];

    // Primary: use transcriptPath if available
    if (context.transcriptPath) {
      const info = await this.statFile(context.transcriptPath);
      if (info) {
        const providerSessionId =
          (await this.extractProviderSessionIdFromFile(info.filePath)) ??
          codexRolloutSessionId(info.filePath);
        if (providerSessionId) {
          info.providerSessionId = providerSessionId;
        }
        results.push(info);
        return results;
      }
      this.logger.warn(
        { transcriptPath: context.transcriptPath },
        'Persisted transcriptPath not found on disk — falling back to directory scan',
      );
    }

    // Fallback: scan date directories (YYYY/MM/DD structure)
    const sessionsRoot = path.join(this.homeDir, CODEX_ROOT);
    await this.scanDateDirectories(sessionsRoot, results);

    // Sort by last modified (most recent first)
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return results;
  }

  /**
   * Parse an entire session file.
   */
  async parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult> {
    const result = await parseCodexJsonl(filePath, {
      maxMessages: options?.maxMessages,
      byteOffset: options?.byteOffset,
      includeToolCalls: options?.includeToolCalls ?? true,
      pricingService: this.pricingService,
    });

    return {
      hasMore: false,
      nextByteOffset: result.bytesRead,
      messageCount: result.messages.length,
      entries: result.messages,
      metrics: result.metrics,
      warnings: result.warnings,
    };
  }

  /**
   * Parse a session file incrementally from a byte offset.
   */
  async parseIncremental(filePath: string, options: ParseOptions): Promise<IncrementalResult> {
    const fileSize = await this.getFileSize(filePath);
    const byteOffset = options.byteOffset ?? 0;

    if (byteOffset >= fileSize) {
      // Nothing new: preserve the carried baseline for the next append.
      return {
        hasMore: false,
        nextByteOffset: byteOffset,
        messageCount: 0,
        entries: [],
        continuationState: options.continuationState,
      };
    }

    const result = await parseCodexJsonl(filePath, {
      maxMessages: options.maxMessages,
      byteOffset,
      endByteOffset: options.endByteOffset,
      includeToolCalls: options.includeToolCalls ?? true,
      pricingService: this.pricingService,
      // Opaque token baseline from the previous parse; skips the prefix rescan when present.
      baseline: options.continuationState as TokenSnapshot | undefined,
    });

    const hasMore = result.bytesRead < fileSize;

    return {
      hasMore,
      nextByteOffset: result.bytesRead,
      messageCount: result.messages.length,
      entries: result.messages,
      metrics: result.metrics,
      warnings: result.warnings,
      continuationState: result.endTokenSnapshot,
    };
  }

  /**
   * Get filesystem paths to watch for session changes.
   */
  getWatchPaths(_projectRoot: string): string[] {
    return [path.join(this.homeDir, CODEX_ROOT)];
  }

  /**
   * Calculate cost for parsed entries using PricingService.
   */
  calculateCost(entries: unknown[], model: string): number {
    let totalCost = 0;
    for (const entry of entries) {
      const msg = entry as {
        usage?: { input: number; output: number; cacheRead: number; cacheCreation: number };
      };
      if (msg.usage) {
        totalCost += this.pricingService.calculateMessageCost(
          model,
          msg.usage.input,
          msg.usage.output,
          msg.usage.cacheRead,
          msg.usage.cacheCreation,
        );
      }
    }
    return totalCost;
  }

  /**
   * Parse a full session file into a UnifiedSession.
   */
  async parseFullSession(filePath: string): Promise<UnifiedSession> {
    const result = await parseCodexJsonl(filePath, {
      pricingService: this.pricingService,
    });

    // Use session ID from file or extract from filename. Keep basename as a final
    // display-safe fallback for malformed legacy files whose parser produced no id.
    const id =
      result.sessionId ?? codexRolloutSessionId(filePath) ?? path.basename(filePath, '.jsonl');

    return {
      id,
      providerName: this.providerName,
      filePath,
      messages: result.messages,
      metrics: result.metrics,
      isOngoing: result.metrics.isOngoing,
      warnings: result.warnings,
    };
  }

  async getSummary(sourceRef: import('./session-reader-adapter.interface').SessionSourceRef) {
    const result = await parseCodexJsonl(sourceRef.filePath, {
      pricingService: this.pricingService,
      retainMessages: false,
    });
    return {
      metrics: result.metrics,
      warnings: result.warnings,
      exactFields: EXACT_SUMMARY_FIELDS,
      // Seed for the watcher's metrics-only lane (file+delta), including the Codex token baseline.
      laneSeed: {
        endOffset: result.bytesRead,
        tail: result.tail,
        firstMessageTimestamp: result.firstMessageTimestamp,
        lastMessageTimestamp: result.lastMessageTimestamp,
        visibleContextTokens: result.visibleContextTokensMerge,
        messageCount: result.metrics.messageCount,
        continuationState: result.endTokenSnapshot,
      },
    };
  }

  /**
   * Extract candidate-discovery metadata (provider session id, workspace path,
   * timestamp) from the first line of a Codex rollout. Returns `undefined`
   * when no `session_meta` event is found.
   */
  extractCandidateMetadata(content: string): TranscriptCandidateMetadata | undefined {
    const meta = parseCodexSessionMeta(content);
    return meta.providerSessionId || meta.timestamp || meta.workspacePath ? meta : undefined;
  }

  /**
   * Extract the canonical Codex provider session id from an already-read file
   * head. Only the first newline-terminated JSONL event is considered.
   */
  private extractProviderSessionIdFromContent(content: string): string | undefined {
    return this.extractCandidateMetadata(content)?.providerSessionId;
  }

  /**
   * Read at most the first 8KB from a Codex rollout and parse the first line.
   * Returns null when the file is missing, unreadable, malformed, or the first
   * line has not been flushed yet.
   */
  async extractProviderSessionIdFromFile(filePath: string): Promise<string | null> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(PROVIDER_SESSION_ID_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead === 0) {
        return null;
      }
      return (
        this.extractProviderSessionIdFromContent(buffer.subarray(0, bytesRead).toString('utf8')) ??
        null
      );
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Recursively scan date-organized directories (YYYY/MM/DD) for rollout JSONL files.
   */
  private async scanDateDirectories(
    dirPath: string,
    results: SessionFileInfo[],
    depth = 0,
  ): Promise<void> {
    // Max depth: sessions/YYYY/MM/DD = 3 levels
    if (depth > 3) return;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (isSyncthingMarker(entry.name)) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this.scanDateDirectories(fullPath, results, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const info = await this.statFile(fullPath);
          if (info) {
            const providerSessionId =
              codexRolloutSessionId(fullPath) ??
              (await this.extractProviderSessionIdFromFile(fullPath));
            if (providerSessionId) {
              info.providerSessionId = providerSessionId;
            }
            results.push(info);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ error, dirPath }, 'Failed to scan Codex sessions directory');
      }
    }
  }

  private async statFile(filePath: string): Promise<SessionFileInfo | null> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        filePath,
        providerName: this.providerName,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }
}
