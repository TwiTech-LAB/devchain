import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { createLogger } from '../../../common/logging/logger';
import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedToolResult,
  UnifiedMetrics,
  PhaseTokenBreakdown,
} from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateMessageTokens } from '../adapters/utils/estimate-content-tokens';
import { calculateCopilotMessageCost } from '../readers/copilot-model-pricing';

const logger = createLogger('CopilotJsonlParser');

/** Maximum allowed line length in bytes (10 MB) */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Raw Copilot events.jsonl types (defensive — all fields optional)
// ---------------------------------------------------------------------------
// Each line: { type, data, id, timestamp, parentId }. `data` is type-specific.

interface RawCopilotEvent {
  type?: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
}

/** toolRequests entry on an assistant.message */
interface RawToolRequest {
  toolCallId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  type?: string;
  intentionSummary?: string;
}

/** session.shutdown.data.modelMetrics[model] */
interface RawModelMetric {
  requests?: { count?: number; cost?: number };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

interface RawShutdownData {
  modelMetrics?: Record<string, RawModelMetric>;
  currentModel?: string;
  currentTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
  tokenDetails?: {
    input?: { tokenCount?: number };
    cache_read?: { tokenCount?: number };
    cache_write?: { tokenCount?: number };
    output?: { tokenCount?: number };
  };
}

/** Return the value when it is a finite number, else undefined. */
function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Fallback {@link PricingServiceInterface} for standalone parser use (e.g. unit tests) where no
 * pricing service is injected. Returns $0 / 200k window — same fail-loud posture as
 * `calculateCopilotMessageCost` on an unknown model. Real adapter use always injects a real service.
 */
const stubPricing: PricingServiceInterface = {
  calculateMessageCost: () => 0,
  getContextWindowSize: () => 200_000,
};

// ---------------------------------------------------------------------------
// Parse result / options
// ---------------------------------------------------------------------------

export interface CopilotParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  bytesRead: number;
  sessionId?: string;
  warnings?: string[];
}

export interface CopilotParseOptions {
  maxMessages?: number;
  byteOffset?: number;
  includeToolCalls?: boolean;
  pricingService?: PricingServiceInterface;
}

// ---------------------------------------------------------------------------
// Internal accumulator for coalescing assistant turns
// ---------------------------------------------------------------------------
// Copilot emits one assistant.message per API call. A tool-using turn emits:
// assistant.message(toolRequests) -> tool.execution_complete -> assistant.message(final text),
// all sharing the same `interactionId` and wrapped by assistant.turn_start/end (turnId increments
// per round). These coalesce into ONE conversational assistant message (cross-provider invariant:
// a tool turn = 1 user + 1 assistant). A new user.message (new interactionId) flushes the buffer.

interface AssistantBuffer {
  timestamp: Date;
  model: string;
  content: UnifiedContentBlock[];
  toolCalls: UnifiedToolCall[];
  toolResults: UnifiedToolResult[];
  /** Sum of per-call outputTokens across coalesced assistant.messages (the only per-turn metric). */
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseCopilotJsonl(
  filePath: string,
  options?: CopilotParseOptions,
): Promise<CopilotParseResult> {
  const byteOffset = options?.byteOffset ?? 0;
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const pricing = options?.pricingService;

  const messages: UnifiedMessage[] = [];
  let messageIndex = 0;

  // Session metadata
  let sessionId: string | undefined;

  // Model tracking
  let primaryModel = '';
  const modelsSet = new Set<string>();
  // Authoritative per-model usage accumulated across ALL session.shutdown events. A resumed
  // events.jsonl contains one shutdown per `--resume`/`-p` run, each reporting ONLY that run's
  // API usage (non-cumulative — S3). Each run is a separately-billed session, so cache_write in
  // run N and cache_read in run N+1 are distinct billing events; summing per-model across runs
  // yields true billed totals + true cost (final-wins undercounts ~50% per resume). See P1-5.
  // Keyed by model id so cost can be priced PER MODEL (mixed-model sessions have different rates).
  const authUsageByModel = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
  >();
  // Copilot native cost (AI Credits) = Σ modelMetrics[*].requests.cost across shutdowns.
  let nativeCredits = 0;
  let seenShutdown = false;
  // Context-window breakdown from the LAST shutdown (a session-state snapshot, not additive).
  let lastContextTokens = 0;
  let lastContextBreakdown:
    | { system: number; conversation: number; toolDefinitions: number }
    | undefined;

  // Live (mid-session) per-turn output accumulation — used only while no shutdown has arrived.
  let liveOutputTokens = 0;

  // Timestamp tracking
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  // Visible context estimate
  let visibleContextTokens = 0;

  // Assistant coalescing buffer
  let assistantBuffer: AssistantBuffer | null = null;

  // Warning accumulation
  let oversizedLineCount = 0;

  // Byte tracking
  let bytesRead = byteOffset;

  const stream = fs.createReadStream(filePath, {
    start: byteOffset,
    encoding: 'utf8',
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  function trackTimestamp(ts: Date): void {
    if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
  }

  function flushAssistantBuffer(): void {
    if (!assistantBuffer) return;
    const buf = assistantBuffer;
    assistantBuffer = null;
    // An empty buffer (no text, no tools, no results) carries no user-facing content — skip it
    // rather than emit a phantom assistant turn (keeps messageCount === conversational turns).
    if (buf.content.length === 0 && buf.toolCalls.length === 0 && buf.toolResults.length === 0) {
      return;
    }
    const msg: UnifiedMessage = {
      id: `copilot-asst-${messageIndex++}`,
      parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
      role: 'assistant',
      timestamp: buf.timestamp,
      content: buf.content,
      model: buf.model || undefined,
      toolCalls: buf.toolCalls,
      toolResults: buf.toolResults,
      // Per-turn only outputTokens is known (input/cache/reasoning arrive at session.shutdown).
      usage: { input: 0, output: buf.outputTokens, cacheRead: 0, cacheCreation: 0 },
      isMeta: false,
      isSidechain: false,
      // Pre-coalesced in-parser; mark complete so the central coalesce pass treats a following
      // assistant (always a new interaction) as a new turn, never a continuation.
      stopReason: 'end_turn',
    };
    messages.push(msg);
    visibleContextTokens += estimateMessageTokens(msg.content);
  }

  function ensureAssistantBuffer(ts: Date, model: string): AssistantBuffer {
    if (!assistantBuffer) {
      assistantBuffer = {
        timestamp: ts,
        model,
        content: [],
        toolCalls: [],
        toolResults: [],
        outputTokens: 0,
      };
    } else if (model) {
      assistantBuffer.model = model;
    }
    return assistantBuffer;
  }

  /**
   * Fold a tool result onto the open assistant buffer (preferred), the last flushed assistant
   * message, or — if neither exists — a fallback user-role message. Defined as a closure (like
   * flush/ensure) so the shared `assistantBuffer` narrows correctly under TS control-flow analysis.
   */
  function attachToolResult(
    block: UnifiedContentBlock,
    resultEntry: UnifiedToolResult,
    ts: Date,
  ): void {
    if (assistantBuffer) {
      assistantBuffer.content.push(block);
      assistantBuffer.toolResults.push(resultEntry);
      return;
    }
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (last && last.role === 'assistant') {
      last.content.push(block);
      last.toolResults.push(resultEntry);
      return;
    }
    const msg: UnifiedMessage = {
      id: `copilot-toolresult-${messageIndex++}`,
      parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
      role: 'user',
      timestamp: ts,
      content: [block],
      toolCalls: [],
      toolResults: [resultEntry],
      isMeta: true,
      isSidechain: false,
    };
    messages.push(msg);
  }

  try {
    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
      bytesRead += lineBytes;

      if (!line.trim()) continue;

      if (lineBytes > MAX_LINE_BYTES) {
        logger.warn(
          { filePath, lineBytes, byteOffset: bytesRead - lineBytes, snippet: line.slice(0, 200) },
          'Skipping oversized JSONL line (>10MB)',
        );
        oversizedLineCount++;
        continue;
      }

      let entry: RawCopilotEvent;
      try {
        entry = JSON.parse(line) as RawCopilotEvent;
      } catch {
        logger.warn({ filePath }, 'Skipping malformed JSONL line');
        continue;
      }

      if (!entry.type) continue;
      const data = entry.data ?? {};
      const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
      trackTimestamp(ts);

      switch (entry.type) {
        // --- Session lifecycle -------------------------------------------------
        case 'session.start': {
          const sid = data.sessionId;
          if (typeof sid === 'string') sessionId = sid;
          break;
        }

        case 'session.resume': {
          // Continuation of a prior session (copilot --resume). The events that follow belong to
          // the same conversation; no message-boundary action — the next user.message flushes.
          break;
        }

        case 'session.model_change': {
          const newModel = data.newModel;
          // `newModel` is frequently the selector "auto"; only a concrete id updates tracking.
          if (typeof newModel === 'string' && newModel !== 'auto') {
            primaryModel = newModel;
            modelsSet.add(newModel);
          }
          break;
        }

        case 'session.info': {
          // Informational (e.g. notice/banner); not a conversational message.
          break;
        }

        case 'session.shutdown': {
          // Authoritative per-model token + cost accounting. A resumed file has one shutdown per
          // `--resume`/`-p` run; accumulate per-model usage across ALL of them (sum = billed
          // totals — see authUsageByModel note). Cost is priced PER MODEL at aggregation time.
          flushAssistantBuffer();
          seenShutdown = true;
          const shutdown = data as unknown as RawShutdownData;
          const mm = shutdown.modelMetrics ?? {};
          for (const model of Object.keys(mm)) {
            modelsSet.add(model);
            const u = mm[model]?.usage ?? {};
            const prev = authUsageByModel.get(model) ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
            };
            // usage.outputTokens INCLUDES reasoning (TUI "↓ N (M reasoning)" — S3 confirmed
            // gpt-5-mini output=79 incl reasoning=64); reasoning is a sub-component, NOT additive.
            prev.input += u.inputTokens ?? 0;
            prev.output += u.outputTokens ?? 0;
            prev.cacheRead += u.cacheReadTokens ?? 0;
            prev.cacheWrite += u.cacheWriteTokens ?? 0;
            prev.reasoning += u.reasoningTokens ?? 0;
            authUsageByModel.set(model, prev);
            nativeCredits += mm[model]?.requests?.cost ?? 0;
          }
          if (typeof shutdown.currentModel === 'string' && shutdown.currentModel !== 'auto') {
            primaryModel = shutdown.currentModel;
            modelsSet.add(shutdown.currentModel);
          }
          // Context-window snapshot (last shutdown wins — it is a state snapshot, not additive).
          if (typeof shutdown.currentTokens === 'number')
            lastContextTokens = shutdown.currentTokens;
          const sys = numOr(shutdown.systemTokens);
          const conv = numOr(shutdown.conversationTokens);
          const tools = numOr(shutdown.toolDefinitionsTokens);
          if (sys !== undefined || conv !== undefined || tools !== undefined) {
            lastContextBreakdown = {
              system: sys ?? 0,
              conversation: conv ?? 0,
              toolDefinitions: tools ?? 0,
            };
          }
          break;
        }

        // --- Roles -------------------------------------------------------------
        case 'system.message': {
          // The static system prompt (re-sent before each non-interactive run). Skipped from the
          // message stream — consistent with Claude (`system` entries) and Codex (developer/system
          // role), so messageCount tracks conversational turns, not prompt re-emissions.
          break;
        }

        case 'user.message': {
          // A new user prompt starts a fresh interaction → flush any open assistant turn.
          flushAssistantBuffer();
          const content = typeof data.content === 'string' ? data.content : '';
          if (!content) break;
          const msg: UnifiedMessage = {
            id: `copilot-user-${messageIndex++}`,
            parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
            role: 'user',
            timestamp: ts,
            content: [{ type: 'text', text: content }],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          };
          messages.push(msg);
          visibleContextTokens += estimateMessageTokens(msg.content);
          break;
        }

        // --- Assistant turn ----------------------------------------------------
        case 'assistant.turn_start': {
          // Round boundary within an interaction (turnId increments per tool round). The buffer
          // stays open across rounds so the whole interaction coalesces into one assistant turn.
          break;
        }

        case 'assistant.message': {
          const model = typeof data.model === 'string' ? data.model : '';
          if (model) {
            primaryModel = model;
            modelsSet.add(model);
          }
          const buf = ensureAssistantBuffer(ts, model);

          // Reasoning summary (plaintext) — emitted as a thinking block before the answer text.
          const reasoningText = data.reasoningText;
          if (typeof reasoningText === 'string' && reasoningText) {
            buf.content.push({ type: 'thinking', thinking: reasoningText });
          }

          // Answer text.
          const text = data.content;
          if (typeof text === 'string' && text) {
            buf.content.push({ type: 'text', text });
          }

          // Tool calls requested by the model.
          if (includeToolCalls && Array.isArray(data.toolRequests)) {
            for (const tr of data.toolRequests as RawToolRequest[]) {
              const callId = tr.toolCallId;
              const name = tr.name;
              if (!callId || !name) continue;
              const input = tr.arguments ?? {};
              buf.content.push({ type: 'tool_call', toolCallId: callId, toolName: name, input });
              buf.toolCalls.push({
                id: callId,
                name,
                input,
                isTask: name === 'Task',
              });
            }
          }

          // Per-turn only outputTokens is available mid-session.
          const out = typeof data.outputTokens === 'number' ? data.outputTokens : 0;
          buf.outputTokens += out;
          liveOutputTokens += out;
          break;
        }

        case 'assistant.turn_end': {
          // End of a round; do NOT flush — the interaction may continue with another round
          // (the assistant.message that resumes after a tool result). Flushing happens at the
          // next user.message / session.shutdown / EOF.
          break;
        }

        // --- Tools -------------------------------------------------------------
        case 'tool.execution_start': {
          // Redundant: the call is already captured from assistant.message.toolRequests. Skipping
          // avoids duplicating the tool_call block. (Parsed defensively if ever needed.)
          break;
        }

        case 'tool.execution_complete': {
          if (!includeToolCalls) break;
          const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
          if (!callId) break;
          const result = (data.result as { content?: unknown } | undefined) ?? {};
          const rawContent = result.content;
          const resultContent: string | unknown[] =
            typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');
          const isError = data.success === false;
          // Fold the result onto the open assistant buffer (the turn is still accumulating). If the
          // buffer was already flushed (edge case), attach to the last assistant message; otherwise
          // preserve the data on a fallback user message so it still renders.
          const block: UnifiedContentBlock = {
            type: 'tool_result',
            toolCallId: callId,
            content: resultContent,
            isError,
          };
          const resultEntry: UnifiedToolResult = {
            toolCallId: callId,
            content: resultContent,
            isError,
          };
          attachToolResult(block, resultEntry, ts);
          break;
        }

        case 'hook.start':
        case 'hook.end': {
          // Hook lifecycle metadata (e.g. postToolUse). Not conversational content.
          break;
        }

        default:
          logger.debug({ type: entry.type }, 'Skipping unknown Copilot event type');
          break;
      }

      if (maxMessages && messages.length >= maxMessages) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Flush any assistant turn still open at EOF.
  flushAssistantBuffer();

  // --- Metrics -------------------------------------------------------------
  // AUTHORITATIVE (≥1 session.shutdown seen): SUM per-model usage across ALL shutdowns (each
  // `--resume`/`-p` run is a separately-billed session — summing gives true billed totals + true
  // cost; final-wins undercounts ~50% per resume). Cost is priced PER MODEL (mixed-model sessions
  // have different rates) via calculateCopilotMessageCost (P1-6 map → exact pricing.json key).
  // LIVE (no shutdown yet): only per-turn outputTokens are known → output-only non-zero
  // lower-bound cost + an explicit "partial" warning; input/cache are 0-with-warning (UnifiedMetrics
  // cannot express "unknown"). On shutdown arrival the adapter (snapshot mode) REPLACES the live
  // partials with these authoritative totals. reasoningTokens ⊂ outputTokens (NOT additive — S3).
  const warnings: string[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let totalContextTokens = 0;
  let contextBreakdown: UnifiedMetrics['contextBreakdown'];
  let nativeCost: number | undefined;

  if (seenShutdown) {
    for (const [model, u] of authUsageByModel) {
      inputTokens += u.input;
      outputTokens += u.output;
      cacheReadTokens += u.cacheRead;
      cacheCreationTokens += u.cacheWrite;
      // Price PER MODEL — never collapse mixed models into a single pricing call.
      costUsd += calculateCopilotMessageCost(
        model,
        {
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadTokens: u.cacheRead,
          cacheCreationTokens: u.cacheWrite,
        },
        // PricingService is required for real adapter use; the standalone-parser fallback (no
        // pricing) just yields $0 here, same fail-loud posture as calculateCopilotMessageCost.
        pricing ?? stubPricing,
      );
    }
    totalContextTokens = lastContextTokens;
    contextBreakdown = lastContextBreakdown;
    nativeCost = nativeCredits;
  } else {
    // Partial / live: output-only lower bound. Never a misleading $0 when there is output.
    outputTokens = liveOutputTokens;
    costUsd =
      liveOutputTokens > 0 && primaryModel
        ? calculateCopilotMessageCost(
            primaryModel,
            {
              inputTokens: 0,
              outputTokens: liveOutputTokens,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
            pricing ?? stubPricing,
          )
        : 0;
    warnings.push(
      'Partial metrics — session.shutdown not yet observed; input/cache/reasoning/cost pending (showing per-turn outputTokens + output-only lower-bound cost).',
    );
  }

  const durationMs =
    firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

  const isOngoing = !seenShutdown;

  const contextWindowTokens =
    pricing && primaryModel ? pricing.getContextWindowSize(primaryModel) : 200_000;

  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  // Copilot does not expose per-phase compaction data; single-phase contribution placeholder.
  const phases: PhaseTokenBreakdown[] = [
    {
      phaseNumber: 1,
      contribution: inputTokens + cacheReadTokens,
      peakTokens: inputTokens + cacheReadTokens,
    },
  ];
  const totalContextConsumption = phases.reduce((sum, p) => sum + p.contribution, 0);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  const metrics: UnifiedMetrics = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    totalContextConsumption,
    compactionCount: 0,
    phaseBreakdowns: phases,
    visibleContextTokens,
    totalContextTokens,
    contextWindowTokens,
    contextBreakdown,
    costUsd,
    nativeCost,
    primaryModel,
    modelsUsed,
    durationMs,
    messageCount: messages.length,
    isOngoing,
  };

  if (oversizedLineCount > 0) {
    warnings.push(
      `Skipped ${oversizedLineCount} oversized line${oversizedLineCount > 1 ? 's' : ''} (>10MB each)`,
    );
  }

  return {
    messages,
    metrics,
    bytesRead,
    sessionId,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
