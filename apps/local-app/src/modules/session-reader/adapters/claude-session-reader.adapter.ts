import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  SessionReaderAdapter,
  SessionDiscoveryContext,
  SessionFileInfo,
  ParseOptions,
  IncrementalResult,
} from './session-reader-adapter.interface';
import { EXACT_SUMMARY_FIELDS } from './session-reader-adapter.interface';
import type { UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { TranscriptTurnState } from '../../terminal/services/session-turn-signals';
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import {
  claudeTurnFromMessages,
  readClaudeContinuation,
  type ClaudeContinuationState,
} from '../parsers/claude-turn-evidence';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';
import { isSyncthingMarker } from '../../../common/constants/syncthing-markers';

const CLAUDE_ROOT = '.claude/projects/';

@Injectable()
export class ClaudeSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'claude';
  readonly incrementalMode = 'delta' as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(ClaudeSessionReaderAdapter.name);
  private readonly homeDir: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.allowedRoots = [path.join(this.homeDir, CLAUDE_ROOT)];
  }

  /**
   * Discover session JSONL files.
   * Primary: use transcriptPath from context.
   * Fallback: encode project root path → scan directory.
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    const results: SessionFileInfo[] = [];

    // Primary: use transcriptPath if available
    if (context.transcriptPath) {
      const info = await this.statFile(context.transcriptPath);
      if (info) {
        results.push(info);
        return results;
      }
      this.logger.warn(
        { transcriptPath: context.transcriptPath },
        'Persisted transcriptPath not found on disk — falling back to directory scan',
      );
    }

    // Fallback: encode project path and scan directory
    const encodedDir = this.encodeProjectPath(context.projectRoot);
    const scanDir = path.join(this.homeDir, CLAUDE_ROOT, encodedDir);

    try {
      const entries = await fs.readdir(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (isSyncthingMarker(entry.name)) continue;
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(scanDir, entry.name);
        const info = await this.statFile(filePath);
        if (info) {
          // Extract session ID from filename (UUID.jsonl)
          const baseName = path.basename(entry.name, '.jsonl');
          info.providerSessionId = baseName;
          results.push(info);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ error, scanDir }, 'Failed to scan Claude projects directory');
      }
    }

    // Sort by last modified (most recent first)
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return results;
  }

  /**
   * Parse an entire session file.
   */
  async parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult> {
    const result = await parseClaudeJsonl(filePath, {
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
      return {
        hasMore: false,
        nextByteOffset: byteOffset,
        messageCount: 0,
        entries: [],
        continuationState: options.continuationState,
      };
    }

    const result = await parseClaudeJsonl(filePath, {
      maxMessages: options.maxMessages,
      byteOffset,
      endByteOffset: options.endByteOffset,
      includeToolCalls: options.includeToolCalls ?? true,
      pricingService: this.pricingService,
      turnBaseline: readClaudeContinuation(options.continuationState)?.turn,
    });

    const hasMore = result.bytesRead < fileSize;
    const continuationState: ClaudeContinuationState = { turn: result.turn };

    return {
      hasMore,
      nextByteOffset: result.bytesRead,
      messageCount: result.messages.length,
      entries: result.messages,
      metrics: result.metrics,
      warnings: result.warnings,
      continuationState,
    };
  }

  /** The turn evidence of a full parse, so the next incremental parse resumes from it. */
  continuationFromSession(session: UnifiedSession): ClaudeContinuationState {
    return { turn: claudeTurnFromMessages(session.messages) };
  }

  turnState(_metrics: UnifiedMetrics, continuationState: unknown): TranscriptTurnState | null {
    return readClaudeContinuation(continuationState)?.turn ?? null;
  }

  /**
   * Get filesystem paths to watch for session changes.
   */
  getWatchPaths(projectRoot: string): string[] {
    const encodedDir = this.encodeProjectPath(projectRoot);
    return [path.join(this.homeDir, CLAUDE_ROOT, encodedDir)];
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
    const result = await parseClaudeJsonl(filePath, {
      pricingService: this.pricingService,
    });

    // Extract session ID from filename
    const baseName = path.basename(filePath, '.jsonl');

    return {
      id: baseName,
      providerName: this.providerName,
      filePath,
      messages: result.messages,
      metrics: result.metrics,
      isOngoing: result.metrics.isOngoing,
      warnings: result.warnings,
    };
  }

  async getSummary(sourceRef: import('./session-reader-adapter.interface').SessionSourceRef) {
    const result = await parseClaudeJsonl(sourceRef.filePath, {
      pricingService: this.pricingService,
      retainMessages: false,
    });
    return {
      metrics: result.metrics,
      warnings: result.warnings,
      exactFields: EXACT_SUMMARY_FIELDS,
      // Seed for the watcher's metrics-only lane (file+delta), including the turn evidence.
      laneSeed: {
        endOffset: result.bytesRead,
        tail: result.tail,
        firstMessageTimestamp: result.firstMessageTimestamp,
        lastMessageTimestamp: result.lastMessageTimestamp,
        visibleContextTokens: result.visibleContextTokensMerge,
        messageCount: result.metrics.messageCount,
        continuationState: { turn: result.turn } satisfies ClaudeContinuationState,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode project root path to Claude Code's directory naming scheme: every
   * character outside [a-zA-Z0-9] becomes "-", and a result over 200 characters
   * is truncated with a base-36 hash of the ORIGINAL path appended (Claude Code
   * 2.1.280). Matching Claude exactly is what makes fallback discovery and the
   * watcher look in the folder Claude actually writes.
   */
  private encodeProjectPath(projectRoot: string): string {
    const encoded = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
    if (encoded.length <= 200) return encoded;
    let hash = 0;
    for (let index = 0; index < projectRoot.length; index += 1) {
      hash = ((hash << 5) - hash + projectRoot.charCodeAt(index)) | 0;
    }
    return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
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
