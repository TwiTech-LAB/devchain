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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../../../common/logging/logger';
import { NotFoundError } from '../../../common/errors/error-types';
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
import {
  asContextLimit,
  assertOpencodeColumns,
  assertOpencodeTables,
  capToolOutput,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  OPENCODE_PROVIDER_NAME,
  parseOpencodeJson,
  parseSessionModelId,
  resolveContextWindowTokens,
  resolveCostUsd,
  withOpencodeDb,
  type OpencodeCandidateQuery,
  type OpencodeConnectionOptions,
  type OpencodeFreshness,
  type OpencodeModelRef,
  type OpencodeSessionCandidate,
  type OpencodeSessionRead,
  type OpencodeSummaryRead,
  type OpencodeTranscriptReader,
} from './opencode-sqlite.db';

type DatabaseInstance = Database.Database;

const logger = createLogger('OpencodeSqliteV1Reader');

/** OpenCode 1's cached copy of the models.dev catalog, relative to the home dir. */
const MODELS_CATALOG_FILE = path.join('.cache', 'opencode', 'models.json');

export interface OpencodeReaderOptions extends OpencodeConnectionOptions {
  /** Overrides `~/.cache/opencode/models.json` (the model catalog). */
  modelsCatalogPath?: string;
  maxToolOutputChars?: number;
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
  cost?: number;
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
// Model catalog (context window)
// ---------------------------------------------------------------------------

/** Context limits of one parsed catalog file, valid while its mtime and size are unchanged. */
const catalogCache = new Map<
  string,
  { mtimeMs: number; size: number; limits: Map<string, number> }
>();

const catalogKey = (ref: OpencodeModelRef) => `${ref.providerId}\u0000${ref.modelId}`;

/**
 * Context window of `ref` from the models.dev catalog file (`{ <providerID>: { models:
 * { <modelID>: { limit: { context } } } } }`), or null when the file, the model or the limit is
 * missing. The file is OpenCode-internal storage, so any drift degrades to null.
 */
function lookupCatalogContextWindow(catalogPath: string, ref: OpencodeModelRef): number | null {
  try {
    const stat = fs.statSync(catalogPath);
    let entry = catalogCache.get(catalogPath);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        limits: parseCatalogLimits(fs.readFileSync(catalogPath, 'utf8')),
      };
      catalogCache.set(catalogPath, entry);
    }
    return entry.limits.get(catalogKey(ref)) ?? null;
  } catch (error) {
    logger.debug(
      { error: String((error as Error)?.message ?? error) },
      'OpenCode model catalog unavailable — using the fallback window',
    );
    return null;
  }
}

/** Only the context limits are kept; the full catalog is several MB. */
function parseCatalogLimits(json: string): Map<string, number> {
  const limits = new Map<string, number>();
  const catalog = JSON.parse(json) as Record<string, { models?: Record<string, unknown> }>;
  for (const [providerId, provider] of Object.entries(catalog ?? {})) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      const context = asContextLimit((model as { limit?: { context?: unknown } })?.limit?.context);
      if (context != null) limits.set(catalogKey({ providerId, modelId }), context);
    }
  }
  return limits;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class OpencodeSqliteV1Reader implements OpencodeTranscriptReader {
  private readonly maxToolOutputChars: number;
  private readonly connection: OpencodeConnectionOptions;
  private readonly modelsCatalogPath: string;

  constructor(
    private readonly pricing?: PricingServiceInterface,
    options?: OpencodeReaderOptions,
  ) {
    this.maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    this.connection = { busyTimeoutMs: options?.busyTimeoutMs, openRetries: options?.openRetries };
    this.modelsCatalogPath =
      options?.modelsCatalogPath ?? path.join(os.homedir(), MODELS_CATALOG_FILE);
  }

  /**
   * Reconstruct a {@link UnifiedSession} for `providerSessionId` from the
   * OpenCode container at `dbPath`, plus its session-specific size and freshness.
   *
   * @throws NotFoundError when the session id is absent from the container.
   * @throws ValidationError when the DB schema has drifted from the expected layout.
   */
  readSession(dbPath: string, providerSessionId: string): OpencodeSessionRead {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertV1Schema(db);

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

      return normalizeOpencodeV1Session(dbPath, sessionRow, messageRows, partRows, {
        pricing: this.pricing,
        maxToolOutputChars: this.maxToolOutputChars,
        catalogContextWindow: (ref) => lookupCatalogContextWindow(this.modelsCatalogPath, ref),
      });
    });
  }

  /** Aggregate summary metrics in SQLite without constructing message or part graphs. */
  readSummary(dbPath: string, providerSessionId: string): OpencodeSummaryRead {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertV1Schema(db);
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

      // The newest message with a non-zero total: one still streaming has none, and the bar must not drop to 0.
      const contextRow = db
        .prepare(
          `SELECT inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens FROM (
             SELECT time_created, id,
               COALESCE(json_extract(data, '$.tokens.input'), 0) AS inputTokens,
               COALESCE(json_extract(data, '$.tokens.output'), 0)
                 + COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS outputTokens,
               COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cacheReadTokens,
               COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cacheCreationTokens
             FROM message
             WHERE session_id = ? AND json_valid(data)
               AND json_extract(data, '$.role') = 'assistant'
               AND json_type(data, '$.tokens') = 'object')
           WHERE inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens > 0
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

      const lastModel = db
        .prepare(
          `SELECT json_extract(data, '$.providerID') AS providerId,
                  json_extract(data, '$.modelID') AS modelId
           FROM message
           WHERE session_id = ? AND json_valid(data)
             AND json_extract(data, '$.role') = 'assistant'
             AND json_type(data, '$.providerID') = 'text'
             AND json_type(data, '$.modelID') = 'text'
           ORDER BY time_created DESC, id DESC LIMIT 1`,
        )
        .get(providerSessionId) as OpencodeModelRef | undefined;

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
      const costUsd = resolveCostUsd({
        pricing: this.pricing,
        primaryModel,
        tokens: {
          input: tokenRow.inputTokens,
          output: tokenRow.outputTokens,
          cacheRead: tokenRow.cacheReadTokens,
          cacheWrite: tokenRow.cacheCreationTokens,
        },
        recordedCostUsd: () => {
          // Summed in JS, in message order, so the total is bit-identical to the full read's.
          const rows = db
            .prepare(
              `SELECT json_extract(data, '$.cost') AS cost FROM message
               WHERE session_id = ? AND json_valid(data)
                 AND json_extract(data, '$.role') = 'assistant'
                 AND json_type(data, '$.cost') IN ('integer', 'real')
               ORDER BY time_created, id`,
            )
            .all(providerSessionId) as { cost: number }[];
          return rows.reduce((sum, row) => sum + row.cost, 0);
        },
      });
      const contextWindowTokens = resolveContextWindowTokens(
        lastModel ? lookupCatalogContextWindow(this.modelsCatalogPath, lastModel) : null,
        primaryModel,
        this.pricing,
      );
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
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertV1Schema(db);
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
    params: OpencodeCandidateQuery,
  ): OpencodeSessionCandidate[] {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertV1Schema(db);
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
}

/**
 * Schema-shape guard: fail with a clear error (no crash) if the relational
 * layout has drifted from opencode 1.15.x.
 */
function assertV1Schema(db: DatabaseInstance): void {
  assertOpencodeTables(db, ['session', 'message', 'part']);
  assertOpencodeColumns(db, 'session', ['id', 'time_updated']);
  assertOpencodeColumns(db, 'message', ['id', 'session_id', 'data']);
  assertOpencodeColumns(db, 'part', ['id', 'message_id', 'session_id', 'data']);
}

// ---------------------------------------------------------------------------
// Pure normalizer (unit-testable without a live connection)
// ---------------------------------------------------------------------------

interface NormalizeOptions {
  pricing?: PricingServiceInterface;
  maxToolOutputChars?: number;
  /** Catalog window of the last assistant model; omitted when no catalog is reachable. */
  catalogContextWindow?: (ref: OpencodeModelRef) => number | null;
}

/**
 * Pure mapping of raw `session/message/part` rows → {@link OpencodeSessionRead}.
 * Exported so the relational→unified mapping can be unit-tested independently of
 * the SQLite connection.
 */
export function normalizeOpencodeV1Session(
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
  let lastModel: OpencodeModelRef | undefined;
  let recordedCostUsd = 0;

  for (const messageRow of messageRows) {
    if (messageRow.time_updated > maxUpdated) maxUpdated = messageRow.time_updated;

    const data = parseOpencodeJson<RawMessageData>(messageRow.data) ?? {};
    const role: UnifiedMessageRole = data.role === 'assistant' ? 'assistant' : 'user';

    if (data.modelID) {
      modelsSet.add(data.modelID);
      if (!primaryModel) primaryModel = data.modelID;
    }
    if (role === 'assistant') {
      if (data.modelID && data.providerID) {
        lastModel = { providerId: data.providerID, modelId: data.modelID };
      }
      if (typeof data.cost === 'number' && Number.isFinite(data.cost)) recordedCostUsd += data.cost;
    }

    const content: UnifiedContentBlock[] = [];
    const toolCalls: UnifiedToolCall[] = [];
    const toolResults: UnifiedToolResult[] = [];
    let isCompactSummary = false;

    for (const part of partsByMessage.get(messageRow.id) ?? []) {
      const p = parseOpencodeJson<RawPartData>(part.data);
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
      const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
      if (total > 0) lastAssistantContextTokens = total;
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
  const costUsd = resolveCostUsd({
    pricing,
    primaryModel,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheCreation,
    },
    recordedCostUsd: () => recordedCostUsd,
  });
  const visibleContextTokens = estimateVisibleFromMessages(messages);
  const contextWindowTokens = resolveContextWindowTokens(
    lastModel ? (options?.catalogContextWindow?.(lastModel) ?? null) : null,
    primaryModel,
    pricing,
  );

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
    providerName: OPENCODE_PROVIDER_NAME,
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
