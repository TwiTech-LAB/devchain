import { readFile } from 'node:fs/promises';
import { createLogger } from '../../../common/logging/logger';
import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedToolResult,
  UnifiedMetrics,
  PhaseTokenBreakdown,
} from '../dtos/unified-session.types';
import type { TokenUsage } from '../dtos/unified-message.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateMessageTokens } from '../adapters/utils/estimate-content-tokens';
import { calculateDevinMessageCost, resolveDevinPricingKey } from '../readers/devin-model-pricing';

const logger = createLogger('DevinAtifParser');

// ---------------------------------------------------------------------------
// Raw ATIF-v1.7 types (defensive — all fields optional)
// ---------------------------------------------------------------------------
// The export is a single JSON document that Devin rewrites after each turn
// (temp file + rename, so a reader sees a whole document). The parser never
// throws: a malformed export gives an empty result.

interface AtifStep {
  step_id?: number;
  timestamp?: string;
  source?: string;
  message?: string;
  model_name?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    tool_call_id?: string;
    function_name?: string;
    arguments?: Record<string, unknown>;
  }>;
  observation?: {
    results?: Array<{
      source_call_id?: string;
      content?: unknown;
      is_error?: boolean;
      isError?: boolean;
    }>;
  };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    extra?: {
      cache_creation_input_tokens?: number;
    };
  };
  extra?: {
    generation_model?: string;
    telemetry?: { operation?: string };
  };
}

interface AtifExport {
  schema_version?: string;
  session_id?: string;
  agent?: { model_name?: string };
  steps?: AtifStep[];
}

/** System message prefix that marks a compaction/continuation point. */
const COMPACTION_MARKER = 'You are continuing work from a previous conversation thread';

/** Return the value when it is a finite number, else undefined. */
function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Fallback {@link PricingServiceInterface} for standalone parser use (unit tests
 * with no service injected). Returns $0 / 200k — same fail-loud posture as
 * `calculateDevinMessageCost` on an unknown model.
 */
const stubPricing: PricingServiceInterface = {
  calculateMessageCost: () => 0,
  getCatalogContextWindowSize: () => null,
  getContextWindowSize: () => 200_000,
};

// ---------------------------------------------------------------------------
// Parse result / options
// ---------------------------------------------------------------------------

export interface DevinParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  bytesRead: number;
  sessionId?: string;
  warnings?: string[];
}

export interface DevinParseOptions {
  maxMessages?: number;
  includeToolCalls?: boolean;
  pricingService?: PricingServiceInterface;
  /** Metrics-only scan: preserve current-turn state without retaining all messages. */
  retainMessages?: boolean;
}

/**
 * Extract the provider session id from raw ATIF content — used by the adapter
 * to stamp `providerSessionId` on a discovered file. Tolerates malformed JSON
 * through a text scan for the top-level `"session_id"`.
 */
export function extractAtifSessionId(content: string): string | undefined {
  try {
    const doc = JSON.parse(content) as AtifExport;
    if (typeof doc.session_id === 'string' && doc.session_id) return doc.session_id;
  } catch {
    // Malformed export — fall through to the text scan.
  }
  return scanAtifSessionId(content);
}

/** Text scan for a `"session_id"` string value, with no JSON parse. */
function scanAtifSessionId(content: string): string | undefined {
  const match = /"session_id"\s*:\s*"([^"\\]*)"/.exec(content);
  return match?.[1] ?? undefined;
}

/** The value when it is a non-empty string, else undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

// ---------------------------------------------------------------------------
// Internal accumulator for coalescing the tool loop
// ---------------------------------------------------------------------------
// A conversational turn in ATIF = 1 user step + N agent steps (each agent step
// is one model call; a tool-calling step carries `tool_calls` + `observation`).
// Consecutive agent steps coalesce into ONE assistant message (cross-provider
// invariant: a tool turn = 1 user + 1 assistant); a new user step flushes.

interface AssistantBuffer {
  timestamp: Date;
  model: string;
  content: UnifiedContentBlock[];
  toolCalls: UnifiedToolCall[];
  toolResults: UnifiedToolResult[];
  usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseDevinAtif(
  filePath: string,
  options?: DevinParseOptions,
): Promise<DevinParseResult> {
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const pricing = options?.pricingService;
  const retainMessages = options?.retainMessages ?? true;

  const messages: UnifiedMessage[] = [];
  let messageIndex = 0;
  let messageCount = 0;
  let lastMessage: UnifiedMessage | null = null;
  let truncatedByMax = false;

  // Session metadata
  let sessionId: string | undefined;

  // Model tracking
  let primaryModel = '';
  const modelsSet = new Set<string>();

  // Token aggregation across ALL agent steps (per-step metrics are authoritative
  // — every step reports its own API usage, so summing yields billed totals).
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  /** Context occupied by the LAST agent step's API call (latest-state snapshot). */
  let totalContextTokens = 0;
  // Each step's `prompt_tokens` already carries the full context sent to the
  // model, so context use is the last step's value — summing steps overcounts.
  let lastPromptTokens = 0;
  /** Estimated tokens of the message content only (no system prompt or tool definitions). */
  let visibleContextTokens = 0;

  // Timestamp tracking
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  // Compaction markers embedded as system steps in the export.
  let compactionCount = 0;

  // Turn state: which conversational step closed the file.
  let lastConversationalSource: 'user' | 'agent' | null = null;

  // Byte tracking
  let bytesRead = 0;

  // Assistant coalescing buffer
  let assistantBuffer: AssistantBuffer | null = null;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
    bytesRead = Buffer.byteLength(raw, 'utf8');
  } catch (error) {
    logger.warn({ filePath, error }, 'Devin ATIF export unreadable');
    return {
      messages: [],
      metrics: emptyMetrics(),
      bytesRead: 0,
      warnings: ['Devin transcript is not readable yet (export pending or removed)'],
    };
  }

  let doc: AtifExport;
  try {
    doc = JSON.parse(raw) as AtifExport;
  } catch {
    // A malformed export (Devin writes through temp file + rename, so not a
    // half-written one). Never throw: report an empty result; the watcher reads
    // the file again on its next change.
    logger.debug({ filePath }, 'Devin ATIF export is partial/malformed — empty result this pass');
    return {
      messages: [],
      metrics: emptyMetrics(),
      bytesRead,
      // JSON.parse(raw) just failed, so only the text scan can find the id.
      sessionId: scanAtifSessionId(raw),
      warnings: ['Devin transcript is mid-rewrite or malformed — metrics deferred to next pass'],
    };
  }

  function trackTimestamp(ts: Date): void {
    if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
  }

  function pushMessage(message: UnifiedMessage): void {
    visibleContextTokens += estimateMessageTokens(message.content);
    if (maxMessages !== undefined && messageCount >= maxMessages) {
      truncatedByMax = true;
      return;
    }
    messageCount++;
    lastMessage = message;
    if (retainMessages) messages.push(message);
  }

  function flushAssistantBuffer(): void {
    if (!assistantBuffer) return;
    const buf = assistantBuffer;
    assistantBuffer = null;
    if (buf.content.length === 0 && buf.toolCalls.length === 0 && buf.toolResults.length === 0) {
      return;
    }
    const msg: UnifiedMessage = {
      id: `devin-asst-${messageIndex++}`,
      parentId: (lastMessage as UnifiedMessage | null)?.id ?? null,
      role: 'assistant',
      timestamp: buf.timestamp,
      content: buf.content,
      model: buf.model || undefined,
      toolCalls: buf.toolCalls,
      toolResults: buf.toolResults,
      usage: buf.usage,
      isMeta: false,
      isSidechain: false,
      // Pre-coalesced in-parser; a following assistant step is always a new turn.
      stopReason: 'end_turn',
    };
    pushMessage(msg);
  }

  function ensureAssistantBuffer(ts: Date, model: string): AssistantBuffer {
    if (!assistantBuffer) {
      assistantBuffer = {
        timestamp: ts,
        model,
        content: [],
        toolCalls: [],
        toolResults: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      };
    } else if (model) {
      assistantBuffer.model = model;
    }
    return assistantBuffer;
  }

  if (typeof doc.session_id === 'string' && doc.session_id) sessionId = doc.session_id;
  // The header `agent.model_name` is a DISPLAY LABEL (e.g. "SWE-2 Flash Max"),
  // not a model uid — it is only a fallback for `primaryModel` when no agent
  // step reports a model, and is never counted in `modelsUsed` (which lists the
  // uids actually used by model calls).
  const headerModel = doc.agent?.model_name;
  if (typeof headerModel === 'string' && headerModel) {
    primaryModel = headerModel;
  }

  for (const step of doc.steps ?? []) {
    const source = step.source;
    if (source !== 'system' && source !== 'user' && source !== 'agent') continue;

    const ts = step.timestamp ? new Date(step.timestamp) : new Date();
    trackTimestamp(ts);

    if (source === 'system') {
      // Static system prompts are skipped from the message stream — EXCEPT the
      // continuation marker, which counts toward compactions.
      if (typeof step.message === 'string' && step.message.startsWith(COMPACTION_MARKER)) {
        compactionCount++;
      }
      continue;
    }

    if (source === 'user') {
      lastConversationalSource = 'user';
      flushAssistantBuffer();
      const content = typeof step.message === 'string' ? step.message : '';
      if (!content) continue;
      const msg: UnifiedMessage = {
        id: `devin-user-${messageIndex++}`,
        parentId: (lastMessage as UnifiedMessage | null)?.id ?? null,
        role: 'user',
        timestamp: ts,
        content: [{ type: 'text', text: content }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      };
      pushMessage(msg);
      continue;
    }

    // source === 'agent' — one model call.
    lastConversationalSource = 'agent';
    const model =
      nonEmptyString(step.model_name) ?? nonEmptyString(step.extra?.generation_model) ?? '';
    if (model) {
      primaryModel = model;
      modelsSet.add(model);
    }
    const buf = ensureAssistantBuffer(ts, model);

    if (typeof step.reasoning_content === 'string' && step.reasoning_content) {
      buf.content.push({ type: 'thinking', thinking: step.reasoning_content });
    }
    if (typeof step.message === 'string' && step.message) {
      buf.content.push({ type: 'text', text: step.message });
    }

    if (includeToolCalls && Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const callId = tc.tool_call_id;
        const name = tc.function_name;
        if (!callId || !name) continue;
        const input = tc.arguments ?? {};
        buf.content.push({ type: 'tool_call', toolCallId: callId, toolName: name, input });
        buf.toolCalls.push({ id: callId, name, input, isTask: name === 'Task' });
      }
    }

    // Tool results ride on the SAME agent step (`observation.results`), matched
    // back to their call by `source_call_id`.
    if (includeToolCalls && Array.isArray(step.observation?.results)) {
      for (const res of step.observation!.results!) {
        const callId = typeof res.source_call_id === 'string' ? res.source_call_id : '';
        if (!callId) continue;
        const rawContent = res.content;
        const resultContent: string | unknown[] =
          typeof rawContent === 'string' || Array.isArray(rawContent)
            ? rawContent
            : JSON.stringify(rawContent ?? '');
        const isError = res.is_error === true || res.isError === true;
        buf.content.push({
          type: 'tool_result',
          toolCallId: callId,
          content: resultContent,
          isError,
        });
        buf.toolResults.push({ toolCallId: callId, content: resultContent, isError });
      }
    }

    // Per-step usage. `prompt_tokens` INCLUDES cached + cache-creation tokens,
    // so the fresh-input share is the remainder (never negative).
    const metrics = step.metrics;
    if (metrics) {
      const prompt = numOr(metrics.prompt_tokens) ?? 0;
      const cacheRead = numOr(metrics.cached_tokens) ?? 0;
      const cacheCreation = numOr(metrics.extra?.cache_creation_input_tokens) ?? 0;
      const input = Math.max(0, prompt - cacheRead - cacheCreation);
      const output = numOr(metrics.completion_tokens) ?? 0;
      buf.usage.input += input;
      buf.usage.output += output;
      buf.usage.cacheRead += cacheRead;
      buf.usage.cacheCreation += cacheCreation;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheCreationTokens += cacheCreation;
      costUsd += calculateDevinMessageCost(
        model || null,
        {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
        },
        pricing ?? stubPricing,
      );
      // Latest-state context snapshot from the LAST agent step's API call.
      totalContextTokens = prompt + output;
      lastPromptTokens = prompt;
    }
  }

  flushAssistantBuffer();

  const durationMs =
    firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

  // No shutdown marker exists in ATIF — the conversation is "ongoing" while the
  // provider is expected to answer, i.e. the last conversational step is a user
  // prompt (or nothing conversational was written yet).
  const isOngoing = lastConversationalSource !== 'agent';

  const contextWindowTokens =
    pricing && primaryModel
      ? pricing.getContextWindowSize(resolveDevinPricingKey(primaryModel, pricing) ?? primaryModel)
      : 200_000;

  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  // Devin reports no per-phase context data; single-phase placeholder.
  const phases: PhaseTokenBreakdown[] = [
    { phaseNumber: 1, contribution: lastPromptTokens, peakTokens: lastPromptTokens },
  ];
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  const metricsResult: UnifiedMetrics = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    totalContextConsumption: lastPromptTokens,
    compactionCount,
    phaseBreakdowns: phases,
    visibleContextTokens,
    totalContextTokens,
    contextWindowTokens,
    costUsd,
    primaryModel,
    modelsUsed,
    durationMs,
    messageCount,
    isOngoing,
  };

  const warnings: string[] = [];
  if (truncatedByMax) {
    warnings.push(`Message list truncated at ${maxMessages} messages`);
  }

  return {
    messages,
    metrics: metricsResult,
    bytesRead,
    sessionId,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function emptyMetrics(): UnifiedMetrics {
  return {
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
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: '',
    durationMs: 0,
    messageCount: 0,
    isOngoing: true,
  };
}
