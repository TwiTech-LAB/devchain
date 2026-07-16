/**
 * OpenCode read-only SQLite reader + unified normalizer.
 *
 * OpenCode (1.15.x) stores every session in a single SQLite container at
 * `~/.local/share/opencode/opencode.db` (WAL mode) using a relational
 * `session → message → part` layout where the message/part payloads are JSON
 * blobs in a `data` column. This module opens that container read-only and, given
 * a `ses_…` id, reconstructs a provider-agnostic {@link UnifiedSession}.
 *
 * It is intentionally PURE (no NestJS wiring): the session-reader adapter
 * (separate sub-epic) injects it and bridges it to {@link SessionReaderAdapter}.
 *
 * Schema reference (verified against opencode 1.15.x):
 * - `session(id, title, model, agent, parent_id, time_created, time_updated, …)`
 * - `message(id, session_id, time_created, time_updated, data)` — `data.role`
 *   (`user|assistant`), `data.modelID`/`providerID`, `data.tokens`, `data.parentID`.
 * - `part(id, message_id, session_id, time_created, time_updated, data)` — `data.type`
 *   ∈ `text | reasoning | tool | step-finish | step-start | compaction | patch | agent`.
 * Indexes used: `message(session_id, time_created, id)`, `part(session_id)`,
 * `part(message_id, id)`.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../../../common/logging/logger';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type {
  UnifiedSession,
  UnifiedMessage,
  UnifiedMetrics,
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedToolResult,
  TokenUsage,
  PhaseTokenBreakdown,
  UnifiedMessageRole,
} from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateVisibleFromMessages } from '../adapters/utils/estimate-content-tokens';

type DatabaseInstance = Database.Database;

const logger = createLogger('OpencodeSqliteReader');

const PROVIDER_NAME = 'opencode';

/** Default cap on a single tool output (chars) to bound memory/wire size. */
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100_000;
/** SQLite busy-wait before SQLITE_BUSY (ms). */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
/** Retries when the container is briefly locked by a concurrent writer. */
const DEFAULT_OPEN_RETRIES = 3;
const OPEN_RETRY_DELAY_MS = 50;
/** Default context window when pricing can't resolve one for the model. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/**
 * Cheap freshness inputs for the staleness/version layer (no full parse).
 * `count` = number of parts in the session; `maxUpdated` = max `time_updated`
 * across the session's session/message/part rows (catches in-place part edits).
 */
export interface OpencodeFreshness {
  count: number;
  maxUpdated: number;
}

/** Full read result: the normalized session plus size/freshness side-channels. */
export interface OpencodeSessionRead {
  session: UnifiedSession;
  /** Session-specific size = sum of this session's part-blob byte sizes (UTF-8). */
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

export interface OpencodeReaderOptions {
  maxToolOutputChars?: number;
  busyTimeoutMs?: number;
  openRetries?: number;
}

// ---------------------------------------------------------------------------
// Raw row / JSON shapes (defensive — every field optional)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  title: string | null;
  model: string | null;
  agent: string | null;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  time_updated: number;
  data: string;
}

interface RawMessageData {
  role?: string;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  tokens?: RawTokens;
  time?: { created?: number; completed?: number };
  // `finish` is OpenCode's per-step turn-boundary signal: 'tool-calls' means the
  // model is continuing (another assistant step follows); 'stop' (or ''/'other'/
  // null) marks a turn boundary. Mapped to `stopReason` below so the shared
  // coalescer (`coalesceAssistantTurns`) collapses step-rows into one turn.
  finish?: string;
}

interface RawTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface RawToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

interface RawPartData {
  type?: string;
  // text / reasoning
  text?: string;
  // tool
  callID?: string;
  tool?: string;
  state?: RawToolState;
  // step-finish
  tokens?: RawTokens;
  // patch
  files?: string[];
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class OpencodeSqliteReader {
  private readonly maxToolOutputChars: number;
  private readonly busyTimeoutMs: number;
  private readonly openRetries: number;

  constructor(
    private readonly pricing?: PricingServiceInterface,
    options?: OpencodeReaderOptions,
  ) {
    this.maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    this.busyTimeoutMs = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.openRetries = options?.openRetries ?? DEFAULT_OPEN_RETRIES;
  }

  /**
   * Reconstruct a {@link UnifiedSession} for `providerSessionId` from the
   * OpenCode container at `dbPath`, plus its session-specific size and freshness.
   *
   * @throws NotFoundError when the session id is absent from the container.
   * @throws ValidationError when the DB schema has drifted from the expected layout.
   */
  readSession(dbPath: string, providerSessionId: string): OpencodeSessionRead {
    return this.withDb(dbPath, (db) => {
      this.assertSchema(db);

      const sessionRow = db
        .prepare(
          `SELECT id, title, model, agent, parent_id, time_created, time_updated
           FROM session WHERE id = ?`,
        )
        .get(providerSessionId) as SessionRow | undefined;

      if (!sessionRow) {
        throw new NotFoundError('OpenCode session', providerSessionId);
      }

      const messageRows = db
        .prepare(
          `SELECT id, time_created, time_updated, data
           FROM message WHERE session_id = ? ORDER BY time_created, id`,
        )
        .all(providerSessionId) as MessageRow[];

      // `part(session_id)` index filters; ORDER BY id keeps intra-message order
      // (OpenCode part ids are monotonic). Grouping below preserves it per message.
      const partRows = db
        .prepare(
          `SELECT id, message_id, time_updated, data
           FROM part WHERE session_id = ? ORDER BY id`,
        )
        .all(providerSessionId) as PartRow[];

      return normalizeOpencodeSession(dbPath, sessionRow, messageRows, partRows, {
        pricing: this.pricing,
        maxToolOutputChars: this.maxToolOutputChars,
      });
    });
  }

  /** Aggregate summary metrics in SQLite without constructing message or part graphs. */
  readSummary(dbPath: string, providerSessionId: string): OpencodeSummaryRead {
    return this.withDb(dbPath, (db) => {
      this.assertSchema(db);
      const sessionRow = db
        .prepare(
          `SELECT id, model, time_created, time_updated
           FROM session WHERE id = ?`,
        )
        .get(providerSessionId) as
        | Pick<SessionRow, 'id' | 'model' | 'time_created' | 'time_updated'>
        | undefined;
      if (!sessionRow) throw new NotFoundError('OpenCode session', providerSessionId);

      const tokenRow = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'step-finish'
               THEN COALESCE(json_extract(data, '$.tokens.input'), 0) ELSE 0 END), 0) AS inputTokens,
             COALESCE(SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'step-finish'
               THEN COALESCE(json_extract(data, '$.tokens.output'), 0)
                  + COALESCE(json_extract(data, '$.tokens.reasoning'), 0) ELSE 0 END), 0) AS outputTokens,
             COALESCE(SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'step-finish'
               THEN COALESCE(json_extract(data, '$.tokens.cache.read'), 0) ELSE 0 END), 0) AS cacheReadTokens,
             COALESCE(SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'step-finish'
               THEN COALESCE(json_extract(data, '$.tokens.cache.write'), 0) ELSE 0 END), 0) AS cacheCreationTokens,
             COALESCE(SUM(CASE WHEN json_valid(data) AND json_extract(data, '$.type') = 'compaction'
               THEN 1 ELSE 0 END), 0) AS compactionCount
           FROM part WHERE session_id = ?`,
        )
        .get(providerSessionId) as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        compactionCount: number;
      };

      const contentPredicate = `EXISTS (
        SELECT 1 FROM part p WHERE p.message_id = m.id AND json_valid(p.data) AND (
          (json_extract(p.data, '$.type') IN ('text', 'reasoning')
            AND length(trim(COALESCE(json_extract(p.data, '$.text'), ''))) > 0)
          OR json_extract(p.data, '$.type') IN ('tool', 'compaction')
          OR (json_extract(p.data, '$.type') = 'patch'
            AND COALESCE(json_array_length(json_extract(p.data, '$.files')), 0) > 0)
        )
      )`;
      const shapeRow = db
        .prepare(
          `SELECT COUNT(*) AS messageCount,
                  MIN(time_created) AS firstTimestamp,
                  MAX(time_created) AS lastTimestamp
           FROM message m WHERE session_id = ? AND ${contentPredicate}`,
        )
        .get(providerSessionId) as {
        messageCount: number;
        firstTimestamp: number | null;
        lastTimestamp: number | null;
      };
      const modelRows = db
        .prepare(
          `SELECT json_extract(data, '$.modelID') AS model
           FROM message
           WHERE session_id = ? AND json_valid(data)
             AND json_type(data, '$.modelID') = 'text'
           ORDER BY time_created, id`,
        )
        .all(providerSessionId) as { model: string }[];
      const models = [...new Set(modelRows.map((row) => row.model).filter(Boolean))];
      const primaryModel = models[0] ?? parseSessionModelId(sessionRow.model);

      const contextRow = db
        .prepare(
          `SELECT
             COALESCE(json_extract(data, '$.tokens.input'), 0) AS inputTokens,
             COALESCE(json_extract(data, '$.tokens.output'), 0)
               + COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS outputTokens,
             COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cacheReadTokens,
             COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cacheCreationTokens
           FROM message
           WHERE session_id = ? AND json_valid(data)
             AND json_extract(data, '$.role') = 'assistant'
             AND json_type(data, '$.tokens') = 'object'
           ORDER BY time_created DESC, id DESC LIMIT 1`,
        )
        .get(providerSessionId) as
        | {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
          }
        | undefined;

      const totalTokens =
        tokenRow.inputTokens +
        tokenRow.outputTokens +
        tokenRow.cacheReadTokens +
        tokenRow.cacheCreationTokens;
      const totalContextTokens = contextRow
        ? contextRow.inputTokens +
          contextRow.outputTokens +
          contextRow.cacheReadTokens +
          contextRow.cacheCreationTokens
        : 0;
      const costUsd =
        this.pricing && primaryModel
          ? this.pricing.calculateMessageCost(
              primaryModel,
              tokenRow.inputTokens,
              tokenRow.outputTokens,
              tokenRow.cacheReadTokens,
              tokenRow.cacheCreationTokens,
            )
          : 0;
      const contextWindowTokens =
        (primaryModel && this.pricing?.getContextWindowSize(primaryModel)) ||
        DEFAULT_CONTEXT_WINDOW_TOKENS;
      const durationMs =
        shapeRow.firstTimestamp != null && shapeRow.lastTimestamp != null
          ? shapeRow.lastTimestamp - shapeRow.firstTimestamp
          : Math.max(0, sessionRow.time_updated - sessionRow.time_created);

      return {
        metrics: {
          inputTokens: tokenRow.inputTokens,
          outputTokens: tokenRow.outputTokens,
          cacheReadTokens: tokenRow.cacheReadTokens,
          cacheCreationTokens: tokenRow.cacheCreationTokens,
          totalTokens,
          totalContextConsumption: 0,
          compactionCount: tokenRow.compactionCount,
          phaseBreakdowns: [{ phaseNumber: 1, contribution: 0, peakTokens: 0 }],
          visibleContextTokens: 0,
          totalContextTokens,
          contextWindowTokens,
          costUsd,
          primaryModel,
          modelsUsed: models.length > 1 ? models : undefined,
          durationMs,
          messageCount: shapeRow.messageCount,
          isOngoing: false,
        },
      };
    });
  }

  /**
   * Cheap freshness probe (no full parse) — for the cache/watcher staleness layer.
   */
  getFreshness(dbPath: string, providerSessionId: string): OpencodeFreshness {
    return this.withDb(dbPath, (db) => {
      this.assertSchema(db);
      const row = db
        .prepare(
          `SELECT
             (SELECT count(*) FROM part WHERE session_id = @sid) AS count,
             max(
               COALESCE((SELECT max(time_updated) FROM part WHERE session_id = @sid), 0),
               COALESCE((SELECT max(time_updated) FROM message WHERE session_id = @sid), 0),
               COALESCE((SELECT time_updated FROM session WHERE id = @sid), 0)
             ) AS maxUpdated`,
        )
        .get({ sid: providerSessionId }) as { count: number; maxUpdated: number } | undefined;

      return { count: row?.count ?? 0, maxUpdated: row?.maxUpdated ?? 0 };
    });
  }

  /**
   * Discovery query: sessions created within `windowMs` of `startedAtMs` whose
   * working directory (or owning project's worktree) matches `directory`,
   * ranked by closeness to the launch time. Structured SQL — no JSONL scanning.
   */
  findSessionCandidates(
    dbPath: string,
    params: { directory: string; startedAtMs: number; windowMs: number },
  ): OpencodeSessionCandidate[] {
    return this.withDb(dbPath, (db) => {
      this.assertSchema(db);
      const rows = db
        .prepare(
          `SELECT s.id AS providerSessionId, s.directory AS directory,
                  s.time_created AS timeCreated, s.time_updated AS timeUpdated
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id
           WHERE (s.directory = @dir OR p.worktree = @dir)
             AND abs(s.time_created - @startedAt) <= @window
           ORDER BY abs(s.time_created - @startedAt) ASC`,
        )
        .all({
          dir: params.directory,
          startedAt: params.startedAtMs,
          window: params.windowMs,
        }) as OpencodeSessionCandidate[];
      return rows;
    });
  }

  // -------------------------------------------------------------------------
  // Private: connection lifecycle + schema guard
  // -------------------------------------------------------------------------

  /**
   * Open the container read-only (`fileMustExist`, NOT `immutable` — immutable
   * ignores the WAL and would serve stale data), run `fn`, and always close.
   * Retries briefly on a transient lock from a concurrent writer.
   */
  private withDb<T>(dbPath: string, fn: (db: DatabaseInstance) => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.openRetries; attempt++) {
      let db: DatabaseInstance | undefined;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
        return fn(db);
      } catch (error) {
        lastError = error;
        if (!this.isTransientLock(error) || attempt === this.openRetries) {
          throw this.wrapOpenError(error, dbPath);
        }
        this.sleep(OPEN_RETRY_DELAY_MS * (attempt + 1));
      } finally {
        db?.close();
      }
    }
    // Unreachable (loop either returns or throws), but satisfies the type checker.
    throw this.wrapOpenError(lastError, dbPath);
  }

  private isTransientLock(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
  }

  private wrapOpenError(error: unknown, dbPath: string): Error {
    if (error instanceof NotFoundError || error instanceof ValidationError) {
      return error;
    }
    return new ValidationError('Failed to open OpenCode SQLite container', {
      category: 'opencode-db',
      dbPath,
      error: String((error as { message?: string } | null)?.message ?? error),
    });
  }

  /** Busy-wait sleep (better-sqlite3 is synchronous; retries must be too). */
  private sleep(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin briefly */
    }
  }

  /**
   * Schema-shape guard: fail with a clear error (no crash) if the relational
   * layout has drifted from opencode 1.15.x.
   */
  private assertSchema(db: DatabaseInstance): void {
    const tables = new Set(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('session', 'message', 'part')`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    for (const required of ['session', 'message', 'part']) {
      if (!tables.has(required)) {
        throw new ValidationError('OpenCode DB schema drift: missing table', {
          category: 'opencode-schema',
          missingTable: required,
        });
      }
    }
    this.assertColumns(db, 'session', ['id', 'time_updated']);
    this.assertColumns(db, 'message', ['id', 'session_id', 'data']);
    this.assertColumns(db, 'part', ['id', 'message_id', 'session_id', 'data']);
  }

  private assertColumns(db: DatabaseInstance, table: string, required: string[]): void {
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
}

// ---------------------------------------------------------------------------
// Pure normalizer (unit-testable without a live connection)
// ---------------------------------------------------------------------------

interface NormalizeOptions {
  pricing?: PricingServiceInterface;
  maxToolOutputChars?: number;
}

/**
 * Pure mapping of raw `session/message/part` rows → {@link OpencodeSessionRead}.
 * Exported so the relational→unified mapping can be unit-tested independently of
 * the SQLite connection.
 */
export function normalizeOpencodeSession(
  dbPath: string,
  sessionRow: SessionRow,
  messageRows: MessageRow[],
  partRows: PartRow[],
  options?: NormalizeOptions,
): OpencodeSessionRead {
  const maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const pricing = options?.pricing;

  // Group parts by message id, preserving id order from the query.
  const partsByMessage = new Map<string, PartRow[]>();
  let sizeBytes = 0;
  let maxUpdated = sessionRow.time_updated ?? 0;
  for (const part of partRows) {
    sizeBytes += Buffer.byteLength(part.data, 'utf8');
    if (part.time_updated > maxUpdated) maxUpdated = part.time_updated;
    const bucket = partsByMessage.get(part.message_id);
    if (bucket) bucket.push(part);
    else partsByMessage.set(part.message_id, [part]);
  }

  const messages: UnifiedMessage[] = [];
  const modelsSet = new Set<string>();
  // Prefer the clean per-message `modelID`; the `session.model` column stores a
  // JSON object (`{ id, providerID, variant? }`) and is used only as a fallback.
  let primaryModel = '';

  // Session token totals come from `step-finish` parts (authoritative per OpenCode).
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let compactionCount = 0;
  // "Current context" snapshot = the last assistant message's reported total.
  let lastAssistantContextTokens = 0;

  for (const messageRow of messageRows) {
    if (messageRow.time_updated > maxUpdated) maxUpdated = messageRow.time_updated;

    const data = safeParse<RawMessageData>(messageRow.data) ?? {};
    const role: UnifiedMessageRole = data.role === 'assistant' ? 'assistant' : 'user';

    if (data.modelID) {
      modelsSet.add(data.modelID);
      if (!primaryModel) primaryModel = data.modelID;
    }

    const content: UnifiedContentBlock[] = [];
    const toolCalls: UnifiedToolCall[] = [];
    const toolResults: UnifiedToolResult[] = [];
    let isCompactSummary = false;

    for (const part of partsByMessage.get(messageRow.id) ?? []) {
      const p = safeParse<RawPartData>(part.data);
      if (!p?.type) continue;

      switch (p.type) {
        case 'text': {
          const text = (p.text ?? '').trim();
          if (text) content.push({ type: 'text', text });
          break;
        }
        case 'reasoning': {
          const thinking = (p.text ?? '').trim();
          if (thinking) content.push({ type: 'thinking', thinking });
          break;
        }
        case 'tool': {
          mapToolPart(p, content, toolCalls, toolResults, maxToolOutputChars);
          break;
        }
        case 'step-finish': {
          if (p.tokens) {
            totalInput += p.tokens.input ?? 0;
            totalOutput += (p.tokens.output ?? 0) + (p.tokens.reasoning ?? 0);
            totalCacheRead += p.tokens.cache?.read ?? 0;
            totalCacheCreation += p.tokens.cache?.write ?? 0;
          }
          break;
        }
        case 'compaction': {
          isCompactSummary = true;
          compactionCount++;
          content.push({ type: 'text', text: '[Conversation compacted]' });
          break;
        }
        case 'patch': {
          const files = Array.isArray(p.files) ? p.files : [];
          if (files.length > 0) {
            content.push({
              type: 'text',
              text: `📝 Updated ${files.length} file(s):\n${files.map((f) => `- ${f}`).join('\n')}`,
            });
          }
          break;
        }
        // step-start (no content), agent (subagent marker), and any future types
        // are intentionally ignored — graceful by default.
        default:
          break;
      }
    }

    // Per-message usage snapshot (assistant), straight from message.data.tokens.
    let usage: TokenUsage | undefined;
    if (role === 'assistant' && data.tokens) {
      usage = {
        input: data.tokens.input ?? 0,
        output: (data.tokens.output ?? 0) + (data.tokens.reasoning ?? 0),
        cacheRead: data.tokens.cache?.read ?? 0,
        cacheCreation: data.tokens.cache?.write ?? 0,
      };
      lastAssistantContextTokens =
        usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
    }

    // Drop empty messages (e.g. pure step boundaries) — their step-finish tokens
    // were already accumulated above, so metrics stay correct.
    if (content.length === 0) continue;

    messages.push({
      id: messageRow.id,
      parentId: data.parentID ?? null,
      role,
      timestamp: new Date(messageRow.time_created),
      content,
      usage,
      model: data.modelID,
      toolCalls,
      toolResults,
      isMeta: false,
      isSidechain: false,
      isCompactSummary: isCompactSummary || undefined,
      // Emit the turn-boundary signal for the shared coalescer: a `tool-calls`
      // finish keeps the turn open (continuation); every other value ('stop',
      // '', 'other', null) is a turn boundary. Assistant rows only — user rows
      // carry no signal (undefined → boundary by the coalescer's fail-safe).
      stopReason:
        role === 'assistant' ? (data.finish === 'tool-calls' ? 'tool_use' : 'end_turn') : undefined,
    });
  }

  if (!primaryModel) primaryModel = parseSessionModelId(sessionRow.model);

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreation;
  const costUsd =
    pricing && primaryModel
      ? pricing.calculateMessageCost(
          primaryModel,
          totalInput,
          totalOutput,
          totalCacheRead,
          totalCacheCreation,
        )
      : 0;
  const visibleContextTokens = estimateVisibleFromMessages(messages);
  const contextWindowTokens =
    (primaryModel && pricing?.getContextWindowSize(primaryModel)) || DEFAULT_CONTEXT_WINDOW_TOKENS;

  const durationMs =
    messages.length >= 2
      ? messages[messages.length - 1].timestamp.getTime() - messages[0].timestamp.getTime()
      : Math.max(0, (sessionRow.time_updated ?? 0) - (sessionRow.time_created ?? 0));

  const phaseBreakdowns: PhaseTokenBreakdown[] = [
    { phaseNumber: 1, contribution: visibleContextTokens, peakTokens: visibleContextTokens },
  ];

  const metrics: UnifiedMetrics = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreation,
    totalTokens,
    totalContextConsumption: visibleContextTokens,
    compactionCount,
    phaseBreakdowns,
    visibleContextTokens,
    totalContextTokens: lastAssistantContextTokens,
    contextWindowTokens,
    costUsd,
    primaryModel,
    modelsUsed: modelsSet.size > 1 ? Array.from(modelsSet) : undefined,
    durationMs,
    messageCount: messages.length,
    isOngoing: false,
  };

  const session: UnifiedSession = {
    id: sessionRow.id,
    providerName: PROVIDER_NAME,
    filePath: dbPath,
    messages,
    metrics,
    isOngoing: false,
  };

  return { session, sizeBytes, freshness: { count: partRows.length, maxUpdated } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapToolPart(
  p: RawPartData,
  content: UnifiedContentBlock[],
  toolCalls: UnifiedToolCall[],
  toolResults: UnifiedToolResult[],
  maxToolOutputChars: number,
): void {
  const toolCallId = p.callID ?? '';
  const toolName = p.tool ?? 'unknown';
  const input = (p.state?.input ?? {}) as Record<string, unknown>;
  const isError = p.state?.status === 'error';

  content.push({ type: 'tool_call', toolCallId, toolName, input });
  toolCalls.push({ id: toolCallId, name: toolName, input, isTask: false });

  // On error the message lives in `state.error`; otherwise in `state.output`.
  const rawOutput = isError ? (p.state?.error ?? '') : p.state?.output;
  const {
    content: outContent,
    isTruncated,
    fullLength,
  } = capToolOutput(rawOutput, maxToolOutputChars);

  content.push({
    type: 'tool_result',
    toolCallId,
    content: outContent,
    isError,
    ...(isTruncated ? { isTruncated, fullLength } : {}),
  });
  toolResults.push({
    toolCallId,
    content: outContent,
    isError,
    ...(isTruncated ? { isTruncated, fullLength } : {}),
  });
}

/**
 * Normalize a tool output to a string and cap it to bound memory/wire size.
 * Non-string outputs are JSON-stringified (best effort).
 */
function capToolOutput(
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
 * Resolve a plain model id from the `session.model` column, which stores a JSON
 * object (`{ id, providerID, variant? }`) in opencode 1.15.x. Falls back to the
 * raw value if it isn't JSON (defensive against schema/value drift).
 */
function parseSessionModelId(raw: string | null): string {
  if (!raw) return '';
  const parsed = safeParse<{ id?: string }>(raw);
  if (parsed && typeof parsed.id === 'string') return parsed.id;
  return raw;
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    logger.debug('Failed to parse OpenCode JSON blob — skipping');
    return null;
  }
}
