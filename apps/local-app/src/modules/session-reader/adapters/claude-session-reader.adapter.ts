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
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';

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
      };
    }

    const result = await parseClaudeJsonl(filePath, {
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode project root path to Claude's directory naming scheme.
   * Claude replaces `/` with `-` (e.g., /home/user/repo → -home-user-repo).
   */
  private encodeProjectPath(projectRoot: string): string {
    return projectRoot.replace(/\//g, '-');
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
