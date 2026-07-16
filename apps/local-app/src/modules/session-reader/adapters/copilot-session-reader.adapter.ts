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
import type { UnifiedSession } from '../dtos/unified-session.types';
import { parseCopilotJsonl } from '../parsers/copilot-jsonl.parser';
import { PRICING_SERVICE, type PricingServiceInterface } from '../services/pricing.interface';

/**
 * Copilot stores one append-only JSONL transcript per session at
 * `~/.copilot/session-state/<sessionId>/events.jsonl`. The session id is devchain's own
 * `sessions.id` threaded into the launch via `copilot --session-id <uuid>` (R1), so both
 * `provider_session_id` and `transcript_path` are known at launch. This makes discovery
 * deterministic (zero-scan): the path is derived directly from `context.sessionId`.
 */
const COPILOT_ROOT = '.copilot/session-state/';
const EVENTS_FILENAME = 'events.jsonl';

@Injectable()
export class CopilotSessionReaderAdapter implements SessionReaderAdapter {
  readonly providerName = 'copilot';
  // SNAPSHOT (not delta): Copilot's authoritative token/cost accounting arrives ONLY at
  // `session.shutdown` as a cumulative-for-run snapshot, and live metrics are output-only
  // partials. The cache's delta-merge is ADDITIVE, which would double-count a cumulative
  // shutdown slice on top of the prior partial slices (and double-count cost). Snapshot mode makes
  // `parseIncremental` return the full session state and the cache REPLACE — so "shutdown totals
  // replace live partials" holds cleanly (Gemini uses snapshot for the same reason: a format whose
  // authoritative metrics are not incrementally additive). Re-reads the whole file per watcher tick
  // (acceptable for Copilot's file sizes; S3 showed flush is end-loaded anyway).
  readonly incrementalMode = 'snapshot' as const;
  readonly sourceKind = 'file' as const;
  readonly allowedRoots: string[];
  private readonly logger = new Logger(CopilotSessionReaderAdapter.name);
  private readonly homeDir: string;

  constructor(@Inject(PRICING_SERVICE) private readonly pricingService: PricingServiceInterface) {
    this.homeDir = os.homedir();
    this.allowedRoots = [path.join(this.homeDir, COPILOT_ROOT)];
  }

  /**
   * Deterministic discovery: derive the events.jsonl path directly from `context.sessionId`
   * (zero-scan). Returns [] when the file does not exist yet — the caller's retry loop keeps
   * re-discovering until copilot creates it post-launch (R1). An explicit `transcriptPath`
   * (e.g. already persisted) is honored first for robustness.
   *
   * Collision risk is nil: the path is devchain's own UUID, so no content-check against the
   * `session.start` event's sessionId is needed (S2 confirmed `--session-id` binds a fresh UUID).
   */
  async discoverSessionFile(context: SessionDiscoveryContext): Promise<SessionFileInfo[]> {
    // Primary: an already-persisted transcriptPath.
    if (context.transcriptPath) {
      const info = await this.statFile(context.transcriptPath);
      if (info) {
        info.providerSessionId = context.sessionId ?? path.basename(path.dirname(info.filePath));
        return [info];
      }
      this.logger.warn(
        { transcriptPath: context.transcriptPath },
        'Persisted transcriptPath not found on disk — falling back to sessionId derivation',
      );
    }

    // Deterministic derivation from the devchain session id.
    if (!context.sessionId) {
      this.logger.debug(
        { projectRoot: context.projectRoot },
        'No sessionId to derive a Copilot transcript path from',
      );
      return [];
    }

    const filePath = this.deriveEventsPath(context.sessionId);
    const info = await this.statFile(filePath);
    if (!info) return []; // not created yet — retry loop will re-attempt
    info.providerSessionId = context.sessionId;
    return [info];
  }

  async parseSessionFile(filePath: string, options?: ParseOptions): Promise<IncrementalResult> {
    const result = await parseCopilotJsonl(filePath, {
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
   * Snapshot incremental parse: re-read the WHOLE file and return the full session state (all
   * messages + authoritative-or-partial metrics). The cache REPLACES (snapshot mode), so the
   * cumulative `session.shutdown` totals correctly replace the prior live partials instead of
   * being additively merged (which would double-count). `byteOffset` is intentionally ignored —
   * a snapshot always reflects the entire file.
   */
  async parseIncremental(filePath: string, options: ParseOptions): Promise<IncrementalResult> {
    const fileSize = await this.getFileSize(filePath);
    const byteOffset = options.byteOffset ?? 0;

    // No change since the last snapshot — nothing new to report.
    if (byteOffset >= fileSize) {
      return {
        hasMore: false,
        nextByteOffset: byteOffset,
        messageCount: 0,
        entries: [],
      };
    }

    const result = await parseCopilotJsonl(filePath, {
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
   * Watch root for the file watcher. Copilot organizes transcripts by session id (not project),
   * so `projectRoot` is irrelevant; the session-state root covers all sessions. Per-session
   * updates are watched via the discovered/persisted transcript path directly.
   */
  getWatchPaths(_projectRoot: string): string[] {
    return [path.join(this.homeDir, COPILOT_ROOT)];
  }

  /**
   * Cost for parsed entries via the PricingService (P1-6 maps Copilot model ids → pricing keys).
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

  async parseFullSession(filePath: string): Promise<UnifiedSession> {
    const result = await parseCopilotJsonl(filePath, {
      pricingService: this.pricingService,
    });

    // Prefer the session id recorded in session.start; fall back to the directory UUID.
    const id = result.sessionId ?? path.basename(path.dirname(filePath));

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
    const result = await parseCopilotJsonl(sourceRef.filePath, {
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

  /** `~/.copilot/session-state/<sessionId>/events.jsonl` */
  private deriveEventsPath(sessionId: string): string {
    return path.join(this.homeDir, COPILOT_ROOT, sessionId, EVENTS_FILENAME);
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
