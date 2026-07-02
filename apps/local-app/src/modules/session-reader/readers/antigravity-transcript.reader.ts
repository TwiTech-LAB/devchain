/**
 * Antigravity (`agy`) transcript reader.
 *
 * `agy` is a hybrid DB-backed source: the persisted `transcript_path` is the
 * per-conversation `conversations/<convId>.db` (so the path validator and the
 * WAL-watcher work like OpenCode), but the *messages* live in a sibling JSONL at
 * `brain/<convId>/.system_generated/logs/transcript_full.jsonl`, resolved here by
 * convention from the conversation id.
 *
 * This reader is intentionally PURE (no NestJS wiring): the adapter injects it
 * and bridges it to the {@link SessionReaderAdapter} contract. It owns path
 * resolution, the JSONL parse (delegated to {@link parseAntigravityJsonl}), and
 * the freshness probe.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { UnifiedSession } from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { parseAntigravityJsonl } from '../parsers/antigravity-jsonl.parser';

const PROVIDER_NAME = 'agy';

/** Per-file stat slice used by the freshness token. Missing files report zeros. */
export interface AntigravityFileStat {
  mtimeMs: number;
  size: number;
}

/**
 * Opaque DB freshness token for an agy conversation.
 *
 * `maxUpdated` is the numeric the cache keys its DB `sourceVersion` on
 * (`SessionCacheService.dbSourceVersion`). Taking `max(jsonl, db)` mtime means
 * the transcript cursor advances on a same-size JSONL rewrite AND on a db-only
 * token update — neither of which moves a byte-size-based version.
 */
export interface AntigravityFreshness {
  maxUpdated: number;
  jsonl: AntigravityFileStat;
  db: AntigravityFileStat;
}

/** Full read result: the normalized session plus size / freshness side-channels. */
export interface AntigravitySessionRead {
  session: UnifiedSession;
  /** Session size = byte size of the JSONL transcript (where messages live). */
  sizeBytes: number;
  freshness: AntigravityFreshness;
}

export class AntigravityTranscriptReader {
  constructor(private readonly pricing?: PricingServiceInterface) {}

  /**
   * Resolve the messages JSONL for a conversation from its `.db` path. The agy
   * root is the grandparent of `conversations/<convId>.db`; the transcript lives
   * under `brain/<convId>/.system_generated/logs/`.
   */
  resolveJsonlPath(dbPath: string, convId: string): string {
    const agyRoot = path.dirname(path.dirname(dbPath));
    return path.join(
      agyRoot,
      'brain',
      convId,
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );
  }

  /** Parse the full session for `convId`, plus its size and freshness token. */
  async readSession(dbPath: string, convId: string): Promise<AntigravitySessionRead> {
    const jsonlPath = this.resolveJsonlPath(dbPath, convId);
    const parsed = await parseAntigravityJsonl(jsonlPath, { pricingService: this.pricing });

    const session: UnifiedSession = {
      id: convId,
      providerName: PROVIDER_NAME,
      // Persist the `.db` as the canonical path (DB-source semantics → WAL fast-wake).
      filePath: dbPath,
      messages: parsed.messages,
      metrics: parsed.metrics,
      isOngoing: parsed.metrics.isOngoing,
      warnings: parsed.warnings,
    };

    const freshness = await this.getFreshness(dbPath, convId);
    return { session, sizeBytes: parsed.bytesRead, freshness };
  }

  /**
   * Cheap freshness probe (no full parse) for the cache/watcher staleness layer.
   * Combines the JSONL mtime/size (messages) and the `.db` mtime/size (tokens).
   */
  async getFreshness(dbPath: string, convId: string): Promise<AntigravityFreshness> {
    const jsonlPath = this.resolveJsonlPath(dbPath, convId);
    const [jsonl, db] = await Promise.all([this.statSafe(jsonlPath), this.statSafe(dbPath)]);
    return { maxUpdated: Math.max(jsonl.mtimeMs, db.mtimeMs), jsonl, db };
  }

  /** Stat a file, reporting zeros when it does not exist yet (graceful). */
  private async statSafe(filePath: string): Promise<AntigravityFileStat> {
    try {
      const stat = await fs.stat(filePath);
      return { mtimeMs: stat.mtime.getTime(), size: stat.size };
    } catch {
      return { mtimeMs: 0, size: 0 };
    }
  }
}
