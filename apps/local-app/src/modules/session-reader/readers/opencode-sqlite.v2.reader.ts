/**
 * OpenCode 2 read-only SQLite reader + unified normalizer.
 *
 * OpenCode 2 stores sessions in the same `~/.local/share/opencode/opencode.db`
 * container as v1, but in its own tables:
 * - `session_v2(id, directory, project_id, title, model, agent, cost, tokens_*, time_created, time_updated, …)`
 *   — `tokens_*` are cumulative per session (title generation included); `model` is JSON `{ id, providerID }`.
 * - `session_message(id, session_id, type, seq, time_created, time_updated, data)` — one row per
 *   message, ordered by `seq`. `data` is a JSON blob whose shape depends on `type`:
 *   `user | synthetic | system | skill` carry `text`; `shell` carries `command` + `output.output`;
 *   `compaction` carries `status`; `assistant` carries `content[]` (text | reasoning | tool),
 *   `model`, `finish` and `tokens`; `idle` and the `*-switched` rows carry no transcript content.
 *
 * The model's context window comes from OpenCode's own catalog in `kv` (key
 * `models-dev:catalog`, value `{ updatedAt, digest, body }` with `body` a JSON string of
 * `{ <providerID>: { models: { <modelID>: { limit: { context } } } } }`).
 *
 * One assistant row is one model step: a step that calls tools ends with
 * `finish: 'tool-calls'` and the next step is a new row. A row that is still
 * streaming has no `tokens`. A tool block's `state.status` is
 * `streaming | running | completed | error`; only the last two carry a result.
 */

import type Database from 'better-sqlite3';
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

const logger = createLogger('OpencodeSqliteV2Reader');

const CATALOG_KV_KEY = 'models-dev:catalog';

export interface OpencodeV2ReaderOptions extends OpencodeConnectionOptions {
  maxToolOutputChars?: number;
}

// ---------------------------------------------------------------------------
// Raw row / JSON shapes (defensive — every JSON field optional)
// ---------------------------------------------------------------------------

interface SessionV2Row {
  id: string;
  model: string | null;
  time_created: number;
  time_updated: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

interface SessionMessageRow {
  id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

interface RawTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface RawToolState {
  status?: string;
  input?: unknown;
  content?: unknown;
  error?: unknown;
}

interface RawContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  state?: RawToolState;
}

interface RawMessageData {
  text?: unknown;
  content?: unknown;
  model?: { id?: unknown; providerID?: unknown };
  tokens?: unknown;
  cost?: unknown;
  finish?: string;
  command?: unknown;
  output?: { output?: unknown };
  metadata?: { background?: unknown };
  status?: unknown;
}

const SESSION_COLUMNS = `id, model, time_created, time_updated, tokens_input, tokens_output,
  tokens_reasoning, tokens_cache_read, tokens_cache_write`;

/** Row types whose `data.text` is rendered, with the role and meta flag they render as. */
const TEXT_MESSAGE_TYPES: Record<string, { role: UnifiedMessageRole; isMeta: boolean }> = {
  user: { role: 'user', isMeta: false },
  synthetic: { role: 'user', isMeta: true },
  skill: { role: 'user', isMeta: true },
  system: { role: 'system', isMeta: true },
};

/**
 * Whitespace set SQLite's `trim(x, chars)` strips below. The blank check in the
 * normalizer uses the same set so `readSummary().messageCount` matches the full read.
 */
const SQL_WHITESPACE = `char(9, 10, 11, 12, 13, 32)`;
const BLANK_RE = /^[\t\n\v\f\r ]*$/;

function sqlNonBlankText(json: string, path: string): string {
  return `(json_type(${json}, '${path}') = 'text'
    AND length(trim(json_extract(${json}, '${path}'), ${SQL_WHITESPACE})) > 0)`;
}

/** SQL twin of the normalizer's "this row renders content" rule. */
const RENDERED_ROW_PREDICATE = `json_valid(m.data) AND (
  (m.type IN (${Object.keys(TEXT_MESSAGE_TYPES)
    .map((t) => `'${t}'`)
    .join(', ')}) AND ${sqlNonBlankText('m.data', '$.text')})
  OR (m.type = 'shell'
    AND COALESCE(json_type(m.data, '$.metadata.background'), '') <> 'true')
  OR (m.type = 'compaction' AND json_extract(m.data, '$.status') = 'completed')
  OR (m.type = 'assistant' AND json_type(m.data, '$.content') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(m.data, '$.content') c
    WHERE c.type = 'object' AND (
      (json_extract(c.value, '$.type') IN ('text', 'reasoning')
        AND ${sqlNonBlankText('c.value', '$.text')})
      OR json_extract(c.value, '$.type') = 'tool')))
)`;

// ---------------------------------------------------------------------------
// Model catalog (context window)
// ---------------------------------------------------------------------------

/** Keyed by (db, provider, model); valid while `kv.time_updated` of the catalog row is unchanged. */
const catalogWindowCache = new Map<string, { updatedAt: number; window: number | null }>();

/**
 * Context window of `ref` from the catalog OpenCode keeps in the same DB, or null when the
 * catalog, the model or the limit is missing. The catalog is OpenCode-internal storage, so any
 * drift degrades to null instead of throwing.
 */
function lookupCatalogContextWindow(
  db: Database.Database,
  dbPath: string,
  ref: OpencodeModelRef,
): number | null {
  // A quoted JSON-path label has no escape for these; skip rather than build a wrong path.
  const unsafe = /["\\\u0000-\u001f]/;
  if (unsafe.test(ref.providerId) || unsafe.test(ref.modelId)) return null;
  try {
    const stamp = db
      .prepare(`SELECT time_updated AS updatedAt FROM kv WHERE key = ?`)
      .get(CATALOG_KV_KEY) as { updatedAt: number } | undefined;
    if (!stamp) return null;

    const cacheKey = `${dbPath}\u0000${ref.providerId}\u0000${ref.modelId}`;
    const hit = catalogWindowCache.get(cacheKey);
    if (hit && hit.updatedAt === stamp.updatedAt) return hit.window;

    const row = db
      .prepare(
        `SELECT json_extract(json_extract(value, '$.body'), ?) AS window FROM kv WHERE key = ?`,
      )
      .get(`$."${ref.providerId}".models."${ref.modelId}".limit.context`, CATALOG_KV_KEY) as
      | { window: unknown }
      | undefined;
    const window = asContextLimit(row?.window);
    catalogWindowCache.set(cacheKey, { updatedAt: stamp.updatedAt, window });
    return window;
  } catch (error) {
    logger.debug(
      { error: String((error as Error)?.message ?? error) },
      'OpenCode model catalog unavailable — using the fallback window',
    );
    return null;
  }
}

/** A finite number from a JSON field, else null. */
function recordedCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class OpencodeSqliteV2Reader implements OpencodeTranscriptReader {
  private readonly maxToolOutputChars: number;
  private readonly connection: OpencodeConnectionOptions;

  constructor(
    private readonly pricing?: PricingServiceInterface,
    options?: OpencodeV2ReaderOptions,
  ) {
    this.maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    this.connection = { busyTimeoutMs: options?.busyTimeoutMs, openRetries: options?.openRetries };
  }

  /**
   * @throws NotFoundError when `session_v2` has no row for the id.
   * @throws ValidationError when the v2 tables are missing or have drifted.
   */
  readSession(dbPath: string, providerSessionId: string): OpencodeSessionRead {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertSchema(db);
      const sessionRow = db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id = ?`)
        .get(providerSessionId) as SessionV2Row | undefined;
      if (!sessionRow) throw new NotFoundError('OpenCode session', providerSessionId);

      const messageRows = db
        .prepare(
          `SELECT id, type, seq, time_created, time_updated, data
           FROM session_message WHERE session_id = ? ORDER BY seq`,
        )
        .all(providerSessionId) as SessionMessageRow[];

      return normalizeOpencodeV2Session(dbPath, sessionRow, messageRows, {
        pricing: this.pricing,
        maxToolOutputChars: this.maxToolOutputChars,
        catalogContextWindow: (ref) => lookupCatalogContextWindow(db, dbPath, ref),
      });
    });
  }

  /** Summary metrics in SQL; the exact fields match {@link readSession}. */
  readSummary(dbPath: string, providerSessionId: string): OpencodeSummaryRead {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertSchema(db);
      const sessionRow = db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id = ?`)
        .get(providerSessionId) as SessionV2Row | undefined;
      if (!sessionRow) throw new NotFoundError('OpenCode session', providerSessionId);

      const shape = db
        .prepare(
          `SELECT COUNT(*) AS messageCount, MIN(seq) AS firstSeq, MAX(seq) AS lastSeq
           FROM session_message m WHERE m.session_id = ? AND ${RENDERED_ROW_PREDICATE}`,
        )
        .get(providerSessionId) as {
        messageCount: number;
        firstSeq: number | null;
        lastSeq: number | null;
      };
      const edgeTimes = db
        .prepare(
          `SELECT seq, time_created AS timeCreated FROM session_message
           WHERE session_id = ? AND seq IN (?, ?)`,
        )
        .all(providerSessionId, shape.firstSeq, shape.lastSeq) as {
        seq: number;
        timeCreated: number;
      }[];
      const timeAt = (seq: number | null) => edgeTimes.find((r) => r.seq === seq)?.timeCreated;

      const { compactionCount } = db
        .prepare(
          `SELECT COUNT(*) AS compactionCount FROM session_message
           WHERE session_id = ? AND type = 'compaction' AND json_valid(data)
             AND json_extract(data, '$.status') = 'completed'`,
        )
        .get(providerSessionId) as { compactionCount: number };

      const modelRows = db
        .prepare(
          `SELECT json_extract(data, '$.model.id') AS model FROM session_message
           WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
             AND json_type(data, '$.model.id') = 'text'
           ORDER BY seq`,
        )
        .all(providerSessionId) as { model: string }[];
      const models = [...new Set(modelRows.map((row) => row.model).filter(Boolean))];

      // The newest row with a non-zero total: a row still streaming has none, and the bar must not drop to 0.
      const contextRow = db
        .prepare(
          `SELECT total FROM (
             SELECT seq,
               COALESCE(json_extract(data, '$.tokens.input'), 0)
                 + COALESCE(json_extract(data, '$.tokens.output'), 0)
                 + COALESCE(json_extract(data, '$.tokens.reasoning'), 0)
                 + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
                 + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS total
             FROM session_message
             WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
               AND json_type(data, '$.tokens') = 'object')
           WHERE total > 0
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(providerSessionId) as { total: number } | undefined;

      const lastModel = db
        .prepare(
          `SELECT json_extract(data, '$.model.providerID') AS providerId,
                  json_extract(data, '$.model.id') AS modelId
           FROM session_message
           WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
             AND json_type(data, '$.model.providerID') = 'text'
             AND json_type(data, '$.model.id') = 'text'
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(providerSessionId) as OpencodeModelRef | undefined;

      const firstTime = timeAt(shape.firstSeq);
      const lastTime = timeAt(shape.lastSeq);
      return {
        metrics: buildMetrics({
          sessionRow,
          pricing: this.pricing,
          primaryModel: models[0] ?? parseSessionModelId(sessionRow.model),
          models,
          compactionCount,
          totalContextTokens: contextRow?.total ?? 0,
          contextWindowCatalog: lastModel
            ? lookupCatalogContextWindow(db, dbPath, lastModel)
            : null,
          recordedCostUsd: () => {
            // Summed in JS, in row order, so the total is bit-identical to the full read's.
            const rows = db
              .prepare(
                `SELECT json_extract(data, '$.cost') AS cost FROM session_message
                 WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
                   AND json_type(data, '$.cost') IN ('integer', 'real')
                 ORDER BY seq`,
              )
              .all(providerSessionId) as { cost: number }[];
            return rows.reduce((sum, row) => sum + row.cost, 0);
          },
          visibleContextTokens: 0,
          messageCount: shape.messageCount,
          spanMs:
            shape.messageCount >= 2 && firstTime != null && lastTime != null
              ? lastTime - firstTime
              : null,
        }),
      };
    });
  }

  /** `count` = message rows; `maxUpdated` covers in-place edits of any row of the session. */
  getFreshness(dbPath: string, providerSessionId: string): OpencodeFreshness {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertSchema(db);
      const row = db
        .prepare(
          `SELECT
             (SELECT count(*) FROM session_message WHERE session_id = @sid) AS count,
             max(
               COALESCE((SELECT max(time_updated) FROM session_message WHERE session_id = @sid), 0),
               COALESCE((SELECT time_updated FROM session_v2 WHERE id = @sid), 0)
             ) AS maxUpdated`,
        )
        .get({ sid: providerSessionId }) as OpencodeFreshness | undefined;
      return { count: row?.count ?? 0, maxUpdated: row?.maxUpdated ?? 0 };
    });
  }

  /** Same match as the v1 reader, over `session_v2`. */
  findSessionCandidates(
    dbPath: string,
    params: OpencodeCandidateQuery,
  ): OpencodeSessionCandidate[] {
    return withOpencodeDb(dbPath, this.connection, (db) => {
      assertSchema(db);
      return db
        .prepare(
          `SELECT s.id AS providerSessionId, s.directory AS directory,
                  s.time_created AS timeCreated, s.time_updated AS timeUpdated
           FROM session_v2 s
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
    });
  }
}

function assertSchema(db: Database.Database): void {
  assertOpencodeTables(db, ['session_v2', 'session_message']);
  assertOpencodeColumns(db, 'session_v2', [
    'id',
    'directory',
    'project_id',
    'model',
    'time_created',
    'time_updated',
    'tokens_input',
    'tokens_output',
    'tokens_reasoning',
    'tokens_cache_read',
    'tokens_cache_write',
  ]);
  assertOpencodeColumns(db, 'session_message', [
    'id',
    'session_id',
    'type',
    'seq',
    'time_created',
    'time_updated',
    'data',
  ]);
}

// ---------------------------------------------------------------------------
// Pure normalizer
// ---------------------------------------------------------------------------

interface NormalizeOptions {
  pricing?: PricingServiceInterface;
  maxToolOutputChars?: number;
  /** Catalog window of the last assistant model; omitted when no catalog is reachable. */
  catalogContextWindow?: (ref: OpencodeModelRef) => number | null;
}

function normalizeOpencodeV2Session(
  dbPath: string,
  sessionRow: SessionV2Row,
  messageRows: SessionMessageRow[],
  options?: NormalizeOptions,
): OpencodeSessionRead {
  const maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;

  const messages: UnifiedMessage[] = [];
  const modelsSet = new Set<string>();
  let sizeBytes = 0;
  let maxUpdated = sessionRow.time_updated ?? 0;
  let compactionCount = 0;
  let lastAssistantContextTokens = 0;
  let lastModel: OpencodeModelRef | undefined;
  let recordedCostUsd = 0;

  for (const row of messageRows) {
    sizeBytes += Buffer.byteLength(row.data, 'utf8');
    if (row.time_updated > maxUpdated) maxUpdated = row.time_updated;

    const data = asRecord(parseOpencodeJson(row.data)) as RawMessageData;
    const base = {
      id: row.id,
      parentId: null,
      timestamp: new Date(row.time_created),
      toolCalls: [] as UnifiedToolCall[],
      toolResults: [] as UnifiedToolResult[],
      isSidechain: false,
    };

    const textType = TEXT_MESSAGE_TYPES[row.type];
    if (textType) {
      if (typeof data.text !== 'string' || BLANK_RE.test(data.text)) continue;
      messages.push({
        ...base,
        role: textType.role,
        isMeta: textType.isMeta,
        content: [{ type: 'text', text: data.text.trim() }],
      });
      continue;
    }

    switch (row.type) {
      case 'assistant': {
        const modelId = typeof data.model?.id === 'string' ? data.model.id : '';
        if (modelId) modelsSet.add(modelId);
        if (modelId && typeof data.model?.providerID === 'string') {
          lastModel = { providerId: data.model.providerID, modelId };
        }
        recordedCostUsd += recordedCost(data.cost) ?? 0;

        let usage: TokenUsage | undefined;
        if (isRecord(data.tokens)) {
          const tokens = data.tokens as RawTokens;
          usage = {
            input: tokens.input ?? 0,
            output: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
            cacheRead: tokens.cache?.read ?? 0,
            cacheCreation: tokens.cache?.write ?? 0,
          };
          const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
          if (total > 0) lastAssistantContextTokens = total;
        }

        const message: UnifiedMessage = {
          ...base,
          role: 'assistant',
          isMeta: false,
          content: [],
          usage,
          model: modelId || undefined,
          // 'tool-calls' keeps the turn open for the shared coalescer; any other value is a boundary.
          stopReason: data.finish === 'tool-calls' ? 'tool_use' : 'end_turn',
        };
        const blocks = Array.isArray(data.content) ? data.content : [];
        for (const block of blocks) {
          mapAssistantBlock(block, message, maxToolOutputChars);
        }
        if (message.content.length > 0) messages.push(message);
        break;
      }
      case 'shell': {
        if (data.metadata?.background === true) break;
        const command = typeof data.command === 'string' ? data.command : '';
        const output = capToolOutput(data.output?.output, maxToolOutputChars).content;
        messages.push({
          ...base,
          role: 'user',
          isMeta: false,
          content: [{ type: 'text', text: output ? `$ ${command}\n${output}` : `$ ${command}` }],
        });
        break;
      }
      case 'compaction': {
        if (data.status !== 'completed') break;
        compactionCount++;
        messages.push({
          ...base,
          role: 'user',
          isMeta: false,
          isCompactSummary: true,
          content: [{ type: 'text', text: '[Conversation compacted]' }],
        });
        break;
      }
      // idle, agent/model/location-switched and future types carry no transcript content.
      default:
        break;
    }
  }

  const visibleContextTokens = estimateVisibleFromMessages(messages);
  const metrics = buildMetrics({
    sessionRow,
    pricing: options?.pricing,
    primaryModel: modelsSet.values().next().value ?? parseSessionModelId(sessionRow.model),
    models: Array.from(modelsSet),
    compactionCount,
    totalContextTokens: lastAssistantContextTokens,
    contextWindowCatalog: lastModel ? (options?.catalogContextWindow?.(lastModel) ?? null) : null,
    recordedCostUsd: () => recordedCostUsd,
    visibleContextTokens,
    messageCount: messages.length,
    spanMs:
      messages.length >= 2
        ? messages[messages.length - 1].timestamp.getTime() - messages[0].timestamp.getTime()
        : null,
  });

  const session: UnifiedSession = {
    id: sessionRow.id,
    providerName: OPENCODE_PROVIDER_NAME,
    filePath: dbPath,
    messages,
    metrics,
    isOngoing: false,
  };
  return { session, sizeBytes, freshness: { count: messageRows.length, maxUpdated } };
}

/** Metrics shared by the full read and the SQL summary, so the exact fields cannot drift. */
function buildMetrics(args: {
  sessionRow: SessionV2Row;
  pricing?: PricingServiceInterface;
  primaryModel: string;
  models: string[];
  compactionCount: number;
  totalContextTokens: number;
  /** OpenCode's catalog window for the last assistant model, null when it has none. */
  contextWindowCatalog: number | null;
  /** OpenCode's own cost for the session; read only when pricing.json lacks the model. */
  recordedCostUsd: () => number;
  visibleContextTokens: number;
  messageCount: number;
  /** First-to-last rendered message span; null falls back to the session row times. */
  spanMs: number | null;
}): UnifiedMetrics {
  const { sessionRow: s, pricing, primaryModel } = args;
  const inputTokens = s.tokens_input ?? 0;
  const outputTokens = (s.tokens_output ?? 0) + (s.tokens_reasoning ?? 0);
  const cacheReadTokens = s.tokens_cache_read ?? 0;
  const cacheCreationTokens = s.tokens_cache_write ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    totalContextConsumption: args.visibleContextTokens,
    compactionCount: args.compactionCount,
    phaseBreakdowns: [
      {
        phaseNumber: 1,
        contribution: args.visibleContextTokens,
        peakTokens: args.visibleContextTokens,
      },
    ],
    visibleContextTokens: args.visibleContextTokens,
    totalContextTokens: args.totalContextTokens,
    contextWindowTokens: resolveContextWindowTokens(
      args.contextWindowCatalog,
      primaryModel,
      pricing,
    ),
    costUsd: resolveCostUsd({
      pricing,
      primaryModel,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheCreationTokens,
      },
      recordedCostUsd: args.recordedCostUsd,
    }),
    primaryModel,
    modelsUsed: args.models.length > 1 ? args.models : undefined,
    durationMs: args.spanMs ?? Math.max(0, (s.time_updated ?? 0) - (s.time_created ?? 0)),
    messageCount: args.messageCount,
    isOngoing: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapAssistantBlock(
  raw: unknown,
  message: UnifiedMessage,
  maxToolOutputChars: number,
): void {
  if (!isRecord(raw)) return;
  const block = raw as RawContentBlock;
  const text =
    typeof block.text === 'string' && !BLANK_RE.test(block.text) ? block.text.trim() : '';

  switch (block.type) {
    case 'text':
      if (text) message.content.push({ type: 'text', text });
      return;
    case 'reasoning':
      if (text) message.content.push({ type: 'thinking', thinking: text });
      return;
    case 'tool': {
      const toolCallId = typeof block.id === 'string' ? block.id : '';
      const toolName = typeof block.name === 'string' ? block.name : 'unknown';
      const state = asRecord(block.state) as RawToolState;
      // A streaming call's input is still a partial JSON string.
      const input = asRecord(state.input);
      message.content.push({ type: 'tool_call', toolCallId, toolName, input });
      message.toolCalls.push({ id: toolCallId, name: toolName, input, isTask: false });

      if (state.status !== 'completed' && state.status !== 'error') return;
      const isError = state.status === 'error';
      const raw = isError ? errorText(state.error) : toolContentText(state.content);
      const { content, isTruncated, fullLength } = capToolOutput(raw, maxToolOutputChars);
      const truncation = isTruncated ? { isTruncated, fullLength } : {};
      const result: UnifiedContentBlock = {
        type: 'tool_result',
        toolCallId,
        content,
        isError,
        ...truncation,
      };
      message.content.push(result);
      message.toolResults.push({ toolCallId, content, isError, ...truncation });
      return;
    }
    default:
      return;
  }
}

/** Tool output is a list of content parts; text parts are joined, other parts become a placeholder. */
function toolContentText(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content
    .map((part) => {
      const p = asRecord(part);
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      return `[${typeof p.type === 'string' ? p.type : 'content'}]`;
    })
    .join('\n');
}

/** A tool error is a structured `{ type, message, … }` object. */
function errorText(error: unknown): unknown {
  const e = asRecord(error);
  return typeof e.message === 'string' ? e.message : error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
