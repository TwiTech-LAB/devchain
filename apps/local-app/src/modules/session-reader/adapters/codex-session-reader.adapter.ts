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
import type { UnifiedSession } from '../dtos/unified-session.types';
import { parseCodexJsonl } from '../parsers/codex-jsonl.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';

const CODEX_ROOT = '.codex/sessions/';

@Injectable()
export class CodexSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'codex';
  readonly incrementalMode = 'delta' as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(CodexSessionReaderAdapter.name);
  private readonly homeDir: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.allowedRoots = [path.join(this.homeDir, CODEX_ROOT)];
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
      return {
        hasMore: false,
        nextByteOffset: byteOffset,
        messageCount: 0,
        entries: [],
      };
    }

    const result = await parseCodexJsonl(filePath, {
      maxMessages: options.maxMessages,
      byteOffset,
      includeToolCalls: options.includeToolCalls ?? true,
      pricingService: this.pricingService,
    });

    const hasMore = result.bytesRead < fileSize;

    return {
      hasMore,
      nextByteOffset: result.bytesRead,
      messageCount: result.messages.length,
      entries: result.messages,
      metrics: result.metrics,
      warnings: result.warnings,
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

    // Use session ID from file or extract from filename
    const id = result.sessionId ?? this.extractSessionId(filePath);

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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract session ID from Codex rollout filename.
   * Format: rollout-YYYY-MM-DDThh-mm-ss-<UUID>.jsonl
   */
  private extractSessionId(filePath: string): string {
    const baseName = path.basename(filePath, '.jsonl');
    // Try to extract UUID portion after the timestamp
    const match = baseName.match(
      /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i,
    );
    return match?.[1] ?? baseName;
  }

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
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this.scanDateDirectories(fullPath, results, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const info = await this.statFile(fullPath);
          if (info) {
            info.providerSessionId = this.extractSessionId(fullPath);
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
