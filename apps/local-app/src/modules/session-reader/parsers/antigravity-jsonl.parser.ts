/**
 * Antigravity (`agy`) transcript parser.
 *
 * `agy` writes a per-`step_index` append log at
 * `brain/<convId>/.system_generated/logs/transcript_full.jsonl`. Each line is one
 * JSON step with the structured keys `step_index, source, type, status,
 * created_at` plus an optional `content` / `thinking` / `tool_calls`.
 *
 * This parser maps those steps into the provider-agnostic unified model
 * (messages + content blocks). Token usage is NOT present in the JSONL — it is
 * protobuf-only in `conversations/<convId>.db` and decoded by a separate task
 * (P1-4); every token field here is therefore 0.
 *
 * Step → unified mapping:
 * - `USER_INPUT`        → `user` message (the `<USER_REQUEST>` body).
 * - `PLANNER_RESPONSE`  → `assistant` message (thinking + text + `tool_call`s).
 *                         A planner that issues tool calls is a turn
 *                         *continuation* (`stopReason: 'tool_use'`); a planner
 *                         with no tool calls closes the turn (`'end_turn'`).
 * - `RUN_COMMAND` / `VIEW_FILE` / `GREP_SEARCH` / `GENERIC` → the rendered
 *                         output of a tool. Folded back onto the matching
 *                         pending `tool_call` as a `tool_result` (FIFO by step
 *                         order). With no pending call (informational `GENERIC`,
 *                         e.g. a permission grant) it degrades to a `system`
 *                         meta message.
 * - `CHECKPOINT`        → `system` compaction-summary message (`isCompactSummary`).
 * - `CONVERSATION_HISTORY` → empty marker, skipped.
 * - other (`EPHEMERAL_MESSAGE`, unknown) → `system` meta message when it carries
 *                         content, otherwise skipped (graceful by default).
 */

import * as fs from 'node:fs/promises';
import { createLogger } from '../../../common/logging/logger';
import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedMetrics,
  PhaseTokenBreakdown,
} from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateVisibleFromMessages } from '../adapters/utils/estimate-content-tokens';

const logger = createLogger('AntigravityJsonlParser');

/** agy is a Gemini-family CLI; default context window mirrors the gemini reader. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
/** Cap a single tool output (chars) to bound memory / wire size. */
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100_000;

/** Step types whose `content` is the rendered output of a preceding tool call. */
const TOOL_RESULT_TYPES = new Set(['RUN_COMMAND', 'VIEW_FILE', 'GREP_SEARCH', 'GENERIC']);

// ---------------------------------------------------------------------------
// Raw step shapes (defensive — every field optional)
// ---------------------------------------------------------------------------

interface RawToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface RawStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: RawToolCall[];
}

// ---------------------------------------------------------------------------
// Public result / options
// ---------------------------------------------------------------------------

export interface AntigravityParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  /** Byte size of the JSONL transcript that was read. */
  bytesRead: number;
  warnings?: string[];
}

export interface AntigravityParseOptions {
  maxMessages?: number;
  includeToolCalls?: boolean;
  maxToolOutputChars?: number;
  /** Reserved for cost calculation once P1-4 supplies token usage. */
  pricingService?: PricingServiceInterface;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseAntigravityJsonl(
  filePath: string,
  options?: AntigravityParseOptions,
): Promise<AntigravityParseResult> {
  let fileContent: string;
  let bytesRead: number;
  try {
    const stat = await fs.stat(filePath);
    bytesRead = stat.size;
    fileContent = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    logger.warn({ filePath, error }, 'Failed to read agy transcript_full.jsonl');
    return emptyResult(0, ['Transcript file could not be read — session data unavailable']);
  }

  return parseAntigravitySteps(splitJsonlLines(fileContent), bytesRead, options);
}

/**
 * Pure step-array → unified mapping (no filesystem access). Exported so the
 * mapping can be unit-tested without writing a temp file.
 */
export function parseAntigravitySteps(
  rawLines: string[],
  bytesRead: number,
  options?: AntigravityParseOptions,
): AntigravityParseResult {
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const maxToolOutputChars = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;

  const messages: UnifiedMessage[] = [];
  const warnings: string[] = [];
  // FIFO of tool calls awaiting their result step (results follow calls in
  // step order). Each entry points back at the assistant message that issued it.
  const pendingToolCalls: Array<{ messageIndex: number; toolCallId: string }> = [];

  let msgSeq = 0;
  let compactionCount = 0;
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  const nextId = (): string => `agy-msg-${msgSeq++}`;
  const parentOf = (): string | null =>
    messages.length > 0 ? messages[messages.length - 1].id : null;
  const trackTimestamp = (ts: Date): void => {
    if (Number.isNaN(ts.getTime())) return;
    if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
  };

  for (const line of rawLines) {
    if (maxMessages && messages.length >= maxMessages) break;

    const step = safeParse<RawStep>(line);
    if (!step || !step.type) continue;

    const ts = step.created_at ? new Date(step.created_at) : new Date(0);
    trackTimestamp(ts);

    switch (step.type) {
      case 'USER_INPUT': {
        const text = extractUserRequest(step.content);
        if (!text) break;
        messages.push({
          id: nextId(),
          parentId: parentOf(),
          role: 'user',
          timestamp: ts,
          content: [{ type: 'text', text }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
        });
        break;
      }

      case 'PLANNER_RESPONSE': {
        const content: UnifiedContentBlock[] = [];
        const toolCalls: UnifiedToolCall[] = [];

        const thinking = step.thinking?.trim();
        if (thinking) content.push({ type: 'thinking', thinking });

        const text = step.content?.trim();
        if (text) content.push({ type: 'text', text });

        const rawToolCalls =
          includeToolCalls && Array.isArray(step.tool_calls) ? step.tool_calls : [];
        rawToolCalls.forEach((tc, i) => {
          if (!tc?.name) return;
          const toolCallId = `agy-tc-${step.step_index ?? msgSeq}-${i}`;
          const input = (tc.args ?? {}) as Record<string, unknown>;
          content.push({ type: 'tool_call', toolCallId, toolName: tc.name, input });
          toolCalls.push({ id: toolCallId, name: tc.name, input, isTask: false });
        });

        // Nothing renderable (e.g. an empty planner heartbeat) — drop it.
        if (content.length === 0) break;

        const messageIndex = messages.length;
        messages.push({
          id: nextId(),
          parentId: parentOf(),
          role: 'assistant',
          timestamp: ts,
          content,
          toolCalls,
          toolResults: [],
          isMeta: false,
          isSidechain: false,
          // A planner that calls tools keeps the turn open so the shared
          // coalescer folds the follow-up planner steps into one assistant turn;
          // a planner with no tool calls closes the turn (boundary).
          stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        });
        for (const call of toolCalls) {
          pendingToolCalls.push({ messageIndex, toolCallId: call.id });
        }
        break;
      }

      case 'CHECKPOINT': {
        const text = step.content?.trim();
        compactionCount++;
        messages.push({
          id: nextId(),
          parentId: parentOf(),
          role: 'system',
          timestamp: ts,
          content: [{ type: 'text', text: text || '[Conversation compacted]' }],
          toolCalls: [],
          toolResults: [],
          isMeta: true,
          isSidechain: false,
          isCompactSummary: true,
        });
        break;
      }

      case 'CONVERSATION_HISTORY':
        // Empty per-turn marker — no renderable content.
        break;

      default: {
        if (TOOL_RESULT_TYPES.has(step.type)) {
          foldToolResult(
            step,
            messages,
            pendingToolCalls,
            maxToolOutputChars,
            nextId,
            parentOf,
            ts,
          );
          break;
        }
        // Unknown / ephemeral step: preserve any content as a system meta note.
        const text = step.content?.trim();
        if (text) {
          messages.push({
            id: nextId(),
            parentId: parentOf(),
            role: 'system',
            timestamp: ts,
            content: [{ type: 'text', text }],
            toolCalls: [],
            toolResults: [],
            isMeta: true,
            isSidechain: false,
          });
        } else {
          logger.debug({ type: step.type }, 'Skipping agy step with no renderable content');
        }
        break;
      }
    }
  }

  const durationMs =
    firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;
  const visibleContextTokens = estimateVisibleFromMessages(messages);
  const phaseBreakdowns: PhaseTokenBreakdown[] = [
    { phaseNumber: 1, contribution: visibleContextTokens, peakTokens: visibleContextTokens },
  ];

  // Token totals stay 0 here: agy token usage is protobuf-only in the `.db` and
  // is decoded/merged by a separate metrics task (P1-4).
  const metrics: UnifiedMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalContextConsumption: visibleContextTokens,
    compactionCount,
    phaseBreakdowns,
    visibleContextTokens,
    totalContextTokens: 0,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    costUsd: 0,
    primaryModel: '',
    durationMs,
    messageCount: messages.length,
    isOngoing: false,
  };

  return {
    messages,
    metrics,
    bytesRead,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fold a tool-result step onto the matching pending tool call (FIFO). With no
 * pending call the step is informational (e.g. a `GENERIC` permission grant) and
 * degrades to a standalone `system` meta message.
 */
function foldToolResult(
  step: RawStep,
  messages: UnifiedMessage[],
  pendingToolCalls: Array<{ messageIndex: number; toolCallId: string }>,
  maxToolOutputChars: number,
  nextId: () => string,
  parentOf: () => string | null,
  ts: Date,
): void {
  const isError = step.status === 'ERROR' || step.status === 'FAILED';
  const {
    content: outContent,
    isTruncated,
    fullLength,
  } = capOutput(step.content ?? '', maxToolOutputChars);

  const pending = pendingToolCalls.shift();
  if (pending) {
    const owner = messages[pending.messageIndex];
    const block: UnifiedContentBlock = {
      type: 'tool_result',
      toolCallId: pending.toolCallId,
      content: outContent,
      isError,
      ...(isTruncated ? { isTruncated, fullLength } : {}),
    };
    owner.content.push(block);
    owner.toolResults.push({
      toolCallId: pending.toolCallId,
      content: outContent,
      isError,
      ...(isTruncated ? { isTruncated, fullLength } : {}),
    });
    return;
  }

  // No tool call to attach to — surface as a system note so nothing is lost.
  const text = outContent.trim();
  if (!text) return;
  messages.push({
    id: nextId(),
    parentId: parentOf(),
    role: 'system',
    timestamp: ts,
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolResults: [],
    isMeta: true,
    isSidechain: false,
  });
}

/** Extract the `<USER_REQUEST>` body from a wrapped user input; else the raw text. */
function extractUserRequest(content: string | undefined): string {
  if (!content) return '';
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return content.trim();
}

function capOutput(
  raw: string,
  maxChars: number,
): { content: string; isTruncated: boolean; fullLength?: number } {
  if (raw.length > maxChars) {
    return { content: raw.slice(0, maxChars), isTruncated: true, fullLength: raw.length };
  }
  return { content: raw, isTruncated: false };
}

function splitJsonlLines(fileContent: string): string[] {
  return fileContent.split('\n').filter((l) => l.trim().length > 0);
}

function safeParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    logger.debug('Failed to parse agy transcript line — skipping');
    return null;
  }
}

function emptyResult(bytesRead: number, warnings?: string[]): AntigravityParseResult {
  return {
    messages: [],
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalContextConsumption: 0,
      compactionCount: 0,
      phaseBreakdowns: [],
      visibleContextTokens: 0,
      totalContextTokens: 0,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      costUsd: 0,
      primaryModel: '',
      durationMs: 0,
      messageCount: 0,
      isOngoing: false,
    },
    bytesRead,
    warnings,
  };
}
