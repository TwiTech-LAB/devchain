/**
 * Version-neutral pieces of the OpenCode SQLite readers: the read-only
 * connection, the result shapes both readers return, and the layout probe the
 * adapter uses to route a session to the reader for the table that holds it.
 *
 * One `opencode.db` can hold the OpenCode 1 layout (`session / message / part`),
 * the OpenCode 2 layout (`session_v2 / session_message`) or both: OpenCode 2
 * copies v1 sessions into its tables when it first opens a v1 DB, and OpenCode 1
 * keeps writing to the legacy tables if it runs on that DB again.
 */

import Database from 'better-sqlite3';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';

type DatabaseInstance = Database.Database;

const logger = createLogger('OpencodeSqlite');

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

export const OPENCODE_PROVIDER_NAME = 'opencode';

/** Default cap on a single tool output (chars) to bound memory/wire size. */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100_000;

/** A model as OpenCode records it: the provider id is part of the catalog key. */
export interface OpencodeModelRef {
  providerId: string;
  modelId: string;
}

/** `catalogWindow` is OpenCode's own limit; without it the pricing window, then the default, applies. */
export function resolveContextWindowTokens(
  catalogWindow: number | null,
  primaryModel: string,
  pricing?: PricingServiceInterface,
): number {
  return (
    catalogWindow ||
    (primaryModel && pricing?.getContextWindowSize(primaryModel)) ||
    DEFAULT_CONTEXT_WINDOW_TOKENS
  );
}

/**
 * pricing.json drives the cost when it knows the model. For a model it lacks, the cost OpenCode
 * recorded on its assistant messages is used instead, so no "No pricing data" warning is raised.
 */
export function resolveCostUsd(args: {
  pricing?: PricingServiceInterface;
  primaryModel: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  recordedCostUsd: () => number;
}): number {
  const { pricing, primaryModel, tokens } = args;
  if (!pricing || !primaryModel) return 0;
  if (pricing.hasPricing?.(primaryModel) === false) return args.recordedCostUsd();
  return pricing.calculateMessageCost(
    primaryModel,
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
  );
}

/** A catalog `limit.context` is usable only as a positive finite number. */
export function asContextLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_RETRIES = 3;
const OPEN_RETRY_DELAY_MS = 50;

/**
 * Cheap freshness inputs for the staleness/version layer (no full parse).
 * `maxUpdated` must move whenever any row of the session changes in place.
 */
export interface OpencodeFreshness {
  count: number;
  maxUpdated: number;
}

export interface OpencodeSessionRead {
  session: UnifiedSession;
  /** Session-specific size = sum of this session's payload byte sizes (UTF-8). */
  sizeBytes: number;
  freshness: OpencodeFreshness;
}

export interface OpencodeSummaryRead {
  metrics: UnifiedMetrics;
}

/** A discovery candidate: a session created in a directory around a launch time. */
export interface OpencodeSessionCandidate {
  providerSessionId: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
}

export interface OpencodeCandidateQuery {
  directory: string;
  startedAtMs: number;
  windowMs: number;
}

/** The contract both layout readers implement; the adapter only talks to this. */
export interface OpencodeTranscriptReader {
  readSession(dbPath: string, providerSessionId: string): OpencodeSessionRead;
  readSummary(dbPath: string, providerSessionId: string): OpencodeSummaryRead;
  getFreshness(dbPath: string, providerSessionId: string): OpencodeFreshness;
  findSessionCandidates(dbPath: string, params: OpencodeCandidateQuery): OpencodeSessionCandidate[];
}

export interface OpencodeConnectionOptions {
  busyTimeoutMs?: number;
  openRetries?: number;
}

/**
 * Open the container read-only (`fileMustExist`, NOT `immutable` — immutable
 * ignores the WAL and would serve stale data), run `fn`, and always close.
 * Retries briefly on a transient lock from a concurrent writer.
 */
export function withOpencodeDb<T>(
  dbPath: string,
  options: OpencodeConnectionOptions,
  fn: (db: DatabaseInstance) => T,
): T {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const openRetries = options.openRetries ?? DEFAULT_OPEN_RETRIES;
  let lastError: unknown;
  for (let attempt = 0; attempt <= openRetries; attempt++) {
    let db: DatabaseInstance | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      return fn(db);
    } catch (error) {
      lastError = error;
      if (!isTransientLock(error) || attempt === openRetries) {
        throw wrapOpenError(error, dbPath);
      }
      busyWait(OPEN_RETRY_DELAY_MS * (attempt + 1));
    } finally {
      db?.close();
    }
  }
  throw wrapOpenError(lastError, dbPath);
}

export function assertOpencodeColumns(
  db: DatabaseInstance,
  table: string,
  required: readonly string[],
): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const col of required) {
    if (!cols.has(col)) {
      throw new ValidationError('OpenCode DB schema drift: missing column', {
        category: 'opencode-schema',
        table,
        missingColumn: col,
      });
    }
  }
}

export function assertOpencodeTables(db: DatabaseInstance, required: readonly string[]): void {
  const present = existingTables(db, required);
  for (const table of required) {
    if (!present.has(table)) {
      throw new ValidationError('OpenCode DB schema drift: missing table', {
        category: 'opencode-schema',
        missingTable: table,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Layout probe (routing input)
// ---------------------------------------------------------------------------

export type OpencodeLayout = 'v1' | 'v2';

/** Session table of each layout; its presence marks the layout as present. */
const SESSION_TABLE: Record<OpencodeLayout, string> = { v1: 'session', v2: 'session_v2' };

export interface OpencodeDbInspection {
  layouts: ReadonlySet<OpencodeLayout>;
  /**
   * Layout whose session table holds the requested id, or null. When both do,
   * the one with the newer `time_updated` wins and a tie goes to v2.
   */
  holder: OpencodeLayout | null;
}

export function inspectOpencodeDb(
  dbPath: string,
  providerSessionId?: string,
  options: OpencodeConnectionOptions = {},
): OpencodeDbInspection {
  return withOpencodeDb(dbPath, options, (db) => {
    const tables = existingTables(db, Object.values(SESSION_TABLE));
    const layouts = new Set<OpencodeLayout>(
      (Object.keys(SESSION_TABLE) as OpencodeLayout[]).filter((l) => tables.has(SESSION_TABLE[l])),
    );
    if (!providerSessionId) return { layouts, holder: null };

    const updatedAt = (layout: OpencodeLayout): number | null => {
      if (!layouts.has(layout)) return null;
      const row = db
        .prepare(`SELECT time_updated AS t FROM ${SESSION_TABLE[layout]} WHERE id = ?`)
        .get(providerSessionId) as { t: number } | undefined;
      return row ? (row.t ?? 0) : null;
    };
    const v1 = updatedAt('v1');
    const v2 = updatedAt('v2');
    let holder: OpencodeLayout | null = null;
    if (v2 != null && (v1 == null || v2 >= v1)) holder = 'v2';
    else if (v1 != null) holder = 'v1';
    return { layouts, holder };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function existingTables(db: DatabaseInstance, names: readonly string[]): Set<string> {
  const placeholders = names.map(() => '?').join(', ');
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
        )
        .all(...names) as { name: string }[]
    ).map((r) => r.name),
  );
}

function isTransientLock(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function wrapOpenError(error: unknown, dbPath: string): Error {
  if (error instanceof NotFoundError || error instanceof ValidationError) {
    return error;
  }
  return new ValidationError('Failed to open OpenCode SQLite container', {
    category: 'opencode-db',
    dbPath,
    error: String((error as { message?: string } | null)?.message ?? error),
  });
}

/** better-sqlite3 is synchronous, so the retry wait must be too. */
function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin briefly */
  }
}

// ---------------------------------------------------------------------------
// Blob helpers shared by both readers
// ---------------------------------------------------------------------------

/**
 * Normalize a tool output to a string and cap it to bound memory/wire size.
 * Non-string outputs are JSON-stringified (best effort).
 */
export function capToolOutput(
  rawOutput: unknown,
  maxChars: number,
): { content: string; isTruncated: boolean; fullLength?: number } {
  let text: string;
  if (typeof rawOutput === 'string') {
    text = rawOutput;
  } else if (rawOutput == null) {
    text = '';
  } else {
    try {
      text = JSON.stringify(rawOutput);
    } catch {
      text = String(rawOutput);
    }
  }
  if (text.length > maxChars) {
    return { content: text.slice(0, maxChars), isTruncated: true, fullLength: text.length };
  }
  return { content: text, isTruncated: false };
}

/**
 * The session `model` column holds JSON `{ id, providerID, variant? }`; fall back to the raw
 * value when it is not JSON (defensive against schema/value drift).
 */
export function parseSessionModelId(raw: string | null): string {
  if (!raw) return '';
  const parsed = parseOpencodeJson<{ id?: unknown }>(raw);
  return parsed && typeof parsed.id === 'string' ? parsed.id : raw;
}

export function parseOpencodeJson<T = unknown>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    logger.debug('Failed to parse OpenCode JSON blob — skipping');
    return null;
  }
}
