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
import { parseGeminiJson } from '../parsers/gemini-json.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';

const GEMINI_ROOT = '.gemini/tmp/';

@Injectable()
export class GeminiSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'gemini';
  readonly incrementalMode = 'snapshot' as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(GeminiSessionReaderAdapter.name);
  private readonly homeDir: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.allowedRoots = [path.join(this.homeDir, GEMINI_ROOT)];
  }

  /**
   * Discover Gemini session files.
   * Primary: use transcriptPath from context.
   * Fallback: scan project slug directories for session files.
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

    // Fallback: scan project directories under ~/.gemini/tmp/
    const geminiRoot = path.join(this.homeDir, GEMINI_ROOT);
    await this.scanProjectDirectories(geminiRoot, results);

    // Sort by last modified (most recent first)
    results.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

    return results;
  }

  /**
   * Parse an entire session file.
   */
  async parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult> {
    const result = await parseGeminiJson(filePath, {
      maxMessages: options?.maxMessages,
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
   * Parse a session file incrementally.
   * Since Gemini uses single JSON files (not JSONL), incremental parsing
   * re-reads the entire file when the size changes.
   */
  async parseIncremental(filePath: string, options: ParseOptions): Promise<IncrementalResult> {
    const fileSize = await this.getFileSize(filePath);
    const byteOffset = options.byteOffset ?? 0;

    // If file hasn't changed, nothing new to report
    if (byteOffset >= fileSize) {
      return {
        hasMore: false,
        nextByteOffset: byteOffset,
        messageCount: 0,
        entries: [],
      };
    }

    // Re-parse entire file (JSON format requires full read)
    const result = await parseGeminiJson(filePath, {
      maxMessages: options.maxMessages,
      includeToolCalls: options.includeToolCalls ?? true,
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
   * Get filesystem paths to watch for session changes.
   */
  getWatchPaths(_projectRoot: string): string[] {
    return [path.join(this.homeDir, GEMINI_ROOT)];
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
    const result = await parseGeminiJson(filePath, {
      pricingService: this.pricingService,
    });

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
   * Extract session ID from Gemini session filename.
   * Format: session-<ISO_timestamp>-<session_id_prefix>.json
   */
  private extractSessionId(filePath: string): string {
    const baseName = path.basename(filePath, '.json');
    // Try to extract the session ID prefix after the timestamp
    const match = baseName.match(/^session-\d{4}-\d{2}-\d{2}T[\d-]+-(.+)$/);
    return match?.[1] ?? baseName;
  }

  /**
   * Scan project directories under ~/.gemini/tmp/ for session files.
   * Structure: ~/.gemini/tmp/<project-slug>/chats/session-*.json
   */
  private async scanProjectDirectories(
    geminiRoot: string,
    results: SessionFileInfo[],
  ): Promise<void> {
    try {
      const entries = await fs.readdir(geminiRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const chatsDir = path.join(geminiRoot, entry.name, 'chats');
        await this.scanChatsDirectory(chatsDir, results);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ error, geminiRoot }, 'Failed to scan Gemini project directories');
      }
    }
  }

  /**
   * Scan a chats directory for session JSON files.
   */
  private async scanChatsDirectory(chatsDir: string, results: SessionFileInfo[]): Promise<void> {
    try {
      const entries = await fs.readdir(chatsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.json')) continue;

        const fullPath = path.join(chatsDir, entry.name);
        const info = await this.statFile(fullPath);
        if (info) {
          info.providerSessionId = this.extractSessionId(fullPath);
          results.push(info);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ error, chatsDir }, 'Failed to scan Gemini chats directory');
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
