/**
 * Antigravity (`agy`) token-metrics reader.
 *
 * agy token usage is PROTOBUF-ONLY (no SQLite column, no JSON cell — confirmed by
 * spike P1-1a): each generation writes a `gen_metadata.data` blob in
 * `conversations/<convId>.db` holding a Usage submessage. This reader opens that
 * container read-only and decodes authoritative per-generation token usage,
 * summing across generations for the session total.
 *
 * Verified field map (decoded against live conversations + a controlled
 * known-token run — see the task evidence):
 * - wrapper = protobuf field `1`; Usage = `1.4` (mirrored at `1.17.2`).
 * - `1.4.2` = prompt/input tokens (scales with the prompt; the dominant cost).
 * - `1.4.3` = TOTAL output tokens, and the identity `1.4.3 = 1.4.9 (thoughts) +
 *   1.4.10 (candidates)` holds on every Gemini row; it collapses to `1.4.10`
 *   when thoughts are absent (e.g. GPT-OSS). Billing counts thoughts as output,
 *   so `1.4.3` is the authoritative output number.
 * - `1.19` = model id (e.g. `gemini-3-flash-a`); `1.21` = display name.
 * - `1.4.1` (model-constant 1132 gemini / 342 gpt-oss, does NOT grow with the
 *   conversation) is a candidate cached-prefix count; its cache semantics are
 *   unverified against agy `/usage`, so Phase 1 does NOT bill it (cacheRead = 0).
 *   Reporting it as full-price input (it is included in `1.4.2`, which Gemini's
 *   promptTokenCount subsumes) is the conservative direction — never falsely free.
 *
 * FAIL LOUD (hard requirement): absent `.db`, internal `cascade_id` ≠ the JSONL
 * `providerSessionId`, missing generation metadata, or an undecodable blob
 * (version-drift tripwire) all push a `warnings[]` entry — NEVER a silent
 * token=0/cost=0.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../../../common/logging/logger';
import {
  decodeMessage,
  getMessage,
  getVarint,
  getString,
  ProtobufDecodeError,
} from './protobuf-wire';

const logger = createLogger('AntigravityMetricsReader');

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_RETRIES = 3;
const OPEN_RETRY_DELAY_MS = 50;

// Protobuf field numbers within `gen_metadata.data`.
const WRAPPER_FIELD = 1;
const USAGE_FIELD = 4; // 1.4
const USAGE_INPUT = 2; // 1.4.2 prompt/input tokens
const USAGE_OUTPUT_TOTAL = 3; // 1.4.3 candidates + thoughts
const MODEL_ID_FIELD = 19; // 1.19
const DISPLAY_NAME_FIELD = 21; // 1.21

/** Decoded per-session token totals (cache fields are 0 in Phase 1 — see above). */
export interface AgyTokenMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Number of generations (gen_metadata rows) successfully decoded. */
  generationCount: number;
  /** Last generation's prompt+output — the current-context snapshot. */
  lastContextTokens: number;
  modelId?: string;
  displayName?: string;
  /** Fail-loud signals; non-empty means metrics are absent or suspect. */
  warnings: string[];
}

interface GenRow {
  idx: number;
  data: Buffer;
}

export interface AntigravityMetricsReaderOptions {
  busyTimeoutMs?: number;
  openRetries?: number;
}

export class AntigravityMetricsReader {
  private readonly busyTimeoutMs: number;
  private readonly openRetries: number;

  constructor(options?: AntigravityMetricsReaderOptions) {
    this.busyTimeoutMs = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.openRetries = options?.openRetries ?? DEFAULT_OPEN_RETRIES;
  }

  /**
   * Decode token usage for `providerSessionId` from the agy `.db` at `dbPath`.
   * Never throws for the known failure modes — returns zeroed totals with a
   * populated `warnings[]` so callers fail LOUD (visible warning) instead of
   * silently reporting a free session.
   */
  decode(dbPath: string, providerSessionId: string): AgyTokenMetrics {
    const result = emptyMetrics();
    try {
      this.withDb(dbPath, (db) => {
        if (!this.hasTable(db, 'gen_metadata') || !this.hasTable(db, 'trajectory_meta')) {
          result.warnings.push(
            'agy metrics: DB schema drift — gen_metadata/trajectory_meta missing (token usage unavailable)',
          );
          return;
        }

        // FAIL LOUD: the container's internal conversation id must match the
        // JSONL-derived providerSessionId, else this `.db` is the wrong session.
        const cascade = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get() as
          | { cascade_id?: string }
          | undefined;
        if (cascade?.cascade_id && cascade.cascade_id !== providerSessionId) {
          result.warnings.push(
            `agy metrics: .db conversation id mismatch (cascade_id=${cascade.cascade_id} ≠ providerSessionId=${providerSessionId}) — token usage NOT trusted`,
          );
          return;
        }

        const rows = db
          .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx')
          .all() as GenRow[];
        if (rows.length === 0) {
          result.warnings.push(
            'agy metrics: no generation metadata rows — token usage unavailable',
          );
          return;
        }

        let decodedRows = 0;
        for (const row of rows) {
          try {
            const usage = this.decodeRowUsage(row.data, result);
            if (!usage) continue;
            result.inputTokens += usage.input;
            result.outputTokens += usage.output;
            result.lastContextTokens = usage.input + usage.output;
            if (usage.modelId) result.modelId = usage.modelId;
            if (usage.displayName) result.displayName = usage.displayName;
            decodedRows++;
          } catch (error) {
            if (error instanceof ProtobufDecodeError) {
              result.warnings.push(
                `agy metrics: undecodable protobuf at gen_metadata[${row.idx}] (possible version drift): ${error.message}`,
              );
              continue;
            }
            throw error;
          }
        }
        result.generationCount = decodedRows;
        if (decodedRows === 0 && result.warnings.length === 0) {
          result.warnings.push(
            'agy metrics: no Usage submessage found in any generation — token usage unavailable',
          );
        }
      });
    } catch (error) {
      result.warnings.push(
        `agy metrics: cannot read .db (${String((error as Error)?.message ?? error)})`,
      );
      logger.debug({ dbPath, error }, 'agy metrics decode failed');
    }
    return result;
  }

  /** Decode the Usage submessage of one `gen_metadata.data` blob. */
  private decodeRowUsage(
    data: Buffer,
    _result: AgyTokenMetrics,
  ): { input: number; output: number; modelId?: string; displayName?: string } | null {
    const top = decodeMessage(data);
    const wrapper = getMessage(top, WRAPPER_FIELD);
    if (!wrapper) return null;
    const usage = getMessage(wrapper, USAGE_FIELD);
    if (!usage) return null;
    return {
      input: getVarint(usage, USAGE_INPUT) ?? 0,
      output: getVarint(usage, USAGE_OUTPUT_TOTAL) ?? 0,
      modelId: getString(wrapper, MODEL_ID_FIELD),
      displayName: getString(wrapper, DISPLAY_NAME_FIELD),
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle (read-only, honors WAL — mirrors OpencodeSqliteReader)
  // -------------------------------------------------------------------------

  private withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.openRetries; attempt++) {
      let db: Database.Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
        return fn(db);
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string } | null)?.code;
        const transient = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
        if (!transient || attempt === this.openRetries) throw error;
        this.sleep(OPEN_RETRY_DELAY_MS * (attempt + 1));
      } finally {
        db?.close();
      }
    }
    throw lastError;
  }

  private hasTable(db: Database.Database, name: string): boolean {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    return row !== undefined;
  }

  /** Busy-wait (better-sqlite3 is synchronous; retries must be too). */
  private sleep(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin briefly */
    }
  }
}

function emptyMetrics(): AgyTokenMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    generationCount: 0,
    lastContextTokens: 0,
    warnings: [],
  };
}
