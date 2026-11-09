import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  SessionReaderAdapter,
  SessionDiscoveryContext,
  SessionFileInfo,
  SessionSourceRef,
  ParseOptions,
  IncrementalResult,
  AdapterSummaryResult,
} from './session-reader-adapter.interface';
import { EXACT_SUMMARY_FIELDS } from './session-reader-adapter.interface';
import type { TokenUsage } from '../dtos/unified-message.types';
import type { UnifiedSession } from '../dtos/unified-session.types';
import { parseDevinAtif, extractAtifSessionId } from '../parsers/devin-atif.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';
import { mapDevinModelToPricing } from '../readers/devin-model-pricing';
import {
  DEVIN_TRANSCRIPTS_ROOT,
  devinTranscriptPath,
} from '../../../common/devin-transcript-paths';

/**
 * Devin's transcript is DevChain-OWNED: the launch passes
 * `--export ~/.devchain/provider-transcripts/devin/<sessions.id>.json` and the
 * CLI rewrites the whole ATIF conversation there after every turn (restores
 * included). The devchain `sessions.id` therefore names the file — zero-scan
 * derivation like Copilot — while the PROVIDER session id (a name like
 * `functional-share`, what `devin --resume` takes) lives in the export's
 * top-level `session_id`.
 */
@Injectable()
export class DevinSessionReaderAdapter implements SessionReaderAdapter, OnModuleInit {
  readonly providerName = 'devin';
  // SNAPSHOT (not delta): ATIF is a whole-document rewrite, not an append log —
  // `parseIncremental` re-reads the file and the cache REPLACES, the same
  // posture Copilot takes for cumulative-report formats.
  readonly incrementalMode = 'snapshot' as const;
  readonly sourceKind = 'file' as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(DevinSessionReaderAdapter.name);
  private readonly homeDir: string;
  /** Export root: every Devin session's file, named by devchain session id. */
  private readonly exportRoot: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.exportRoot = path.join(this.homeDir, DEVIN_TRANSCRIPTS_ROOT);
    this.allowedRoots = [this.exportRoot];
  }

  /**
   * `devin --export` fails when the parent folder is missing, and launch
   * argument building must stay free of filesystem effects — so the folder
   * exists from app start. It is never deleted: it holds the exports.
   */
  async onModuleInit(): Promise<void> {
    const root = this.exportRoot;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.logger.warn({ error, root }, 'Failed to create the Devin export folder');
    }
  }

  /**
   * Deterministic discovery: derive the export path directly from
   * `context.sessionId` (the file is named by devchain's sessions.id). An
   * already-persisted `transcriptPath` is honored first. Returns [] when the
   * file does not exist yet — the retry loop keeps re-discovering until devin
   * flushes its first export. `providerSessionId` is read from the file's
   * top-level `session_id` (what `devin --resume` consumes on restore).
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    if (context.transcriptPath) {
      const info = await this.statWithSessionId(context.transcriptPath);
      if (info) return [info];
      this.logger.warn(
        { transcriptPath: context.transcriptPath },
        'Persisted transcriptPath not found on disk — falling back to sessionId derivation',
      );
    }

    if (!context.sessionId) {
      this.logger.debug(
        { projectRoot: context.projectRoot },
        'No sessionId to derive a Devin export path from',
      );
      return [];
    }

    const info = await this.statWithSessionId(devinTranscriptPath(this.homeDir, context.sessionId));
    return info ? [info] : [];
  }

  async parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult> {
    const result = await parseDevinAtif(filePath, {
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
   * Snapshot incremental parse: always re-read the WHOLE file. The export is
   * rewritten as a whole document and can SHRINK (compaction drops earlier
   * steps), so a byteOffset size check would miss real changes. The caller's
   * cache REPLACES, not appends.
   */
  async parseIncremental(filePath: string, options: ParseOptions): Promise<IncrementalResult> {
    return this.parseSessionFile(filePath, { includeToolCalls: options.includeToolCalls });
  }

  /**
   * Watch root for the file watcher. The export root covers every devin
   * session (files are named by devchain session id, not by project).
   */
  getWatchPaths(_projectRoot: string): string[] {
    return [this.exportRoot];
  }

  calculateCost(entries: unknown[], model: string): number {
    let totalCost = 0;
    const pricingKey = mapDevinModelToPricing(model) ?? model;
    for (const entry of entries) {
      const msg = entry as { usage?: TokenUsage };
      if (msg.usage) {
        totalCost += this.pricingService.calculateMessageCost(
          pricingKey,
          msg.usage.input,
          msg.usage.output,
          msg.usage.cacheRead,
          msg.usage.cacheCreation,
        );
      }
    }
    return totalCost;
  }

  async parseFullSession(filePath: string): Promise<UnifiedSession> {
    const result = await parseDevinAtif(filePath, {
      pricingService: this.pricingService,
    });

    // Prefer the provider session id from the export; fall back to the file
    // basename (the devchain sessions.id the path was bound to).
    const id = result.sessionId ?? path.basename(filePath, '.json');

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

  async getSummary(sourceRef: SessionSourceRef): Promise<AdapterSummaryResult> {
    const result = await parseDevinAtif(sourceRef.filePath, {
      pricingService: this.pricingService,
      retainMessages: false,
    });
    return {
      metrics: result.metrics,
      warnings: result.warnings,
      exactFields: EXACT_SUMMARY_FIELDS,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Stat a candidate and, when it exists, read the provider session_id from it. */
  private async statWithSessionId(filePath: string): Promise<SessionFileInfo | null> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      return {
        filePath,
        providerName: this.providerName,
        providerSessionId: content ? extractAtifSessionId(content) : undefined,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }
}
