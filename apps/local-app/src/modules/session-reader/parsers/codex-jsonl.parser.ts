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
  TokenUsage,
} from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateMessageTokens } from '../adapters/utils/estimate-content-tokens';

const logger = createLogger('CodexJsonlParser');

/** Maximum allowed line length in bytes (10 MB) */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Raw Codex JSONL types (defensive — all fields optional)
// ---------------------------------------------------------------------------

interface RawRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** Codex token usage within token_count event */
interface RawTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** Content item within a response_item message */
interface RawContentItem {
  type?: string;
  text?: string;
}

interface TokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  prevInputTokens: number;
  prevOutputTokens: number;
  prevCacheReadTokens: number;
  tokenCountEvents: number;
  contextWindowTokens: number;
  primaryModel: string;
  modelsUsed: string[];
  lastTurnComplete: boolean;
  openTurns: number;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface ActiveTurnState {
  startSnapshot: TokenTotals;
  lastAssistantMsgIndex: number;
}

function sumTokenTotals(snapshot: TokenTotals): number {
  return snapshot.inputTokens + snapshot.outputTokens + snapshot.cacheReadTokens;
}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface CodexParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  bytesRead: number;
  sessionId?: string;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

export interface CodexParseOptions {
  maxMessages?: number;
  byteOffset?: number;
  includeToolCalls?: boolean;
  pricingService?: PricingServiceInterface;
}

// ---------------------------------------------------------------------------
// Internal accumulator for coalescing assistant content
// ---------------------------------------------------------------------------

interface AssistantBuffer {
  timestamp: Date;
  content: UnifiedContentBlock[];
  toolCalls: UnifiedToolCall[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseCodexJsonl(
  filePath: string,
  options?: CodexParseOptions,
): Promise<CodexParseResult> {
  const byteOffset = options?.byteOffset ?? 0;
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const pricing = options?.pricingService;

  const messages: UnifiedMessage[] = [];
  let messageIndex = 0;

  // For incremental parses, establish baseline cumulative totals before byteOffset.
  const baselineSnapshot =
    byteOffset > 0
      ? await readTokenSnapshotBeforeOffset(filePath, byteOffset)
      : {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          prevInputTokens: 0,
          prevOutputTokens: 0,
          prevCacheReadTokens: 0,
          tokenCountEvents: 0,
          contextWindowTokens: 200_000,
          primaryModel: '',
          modelsUsed: [],
          lastTurnComplete: true,
          openTurns: 0,
        };

  // Session metadata
  let sessionId: string | undefined;

  // Model tracking
  let primaryModel = baselineSnapshot.primaryModel;
  const modelsSet = new Set<string>(baselineSnapshot.modelsUsed);

  // Token accumulators (from cumulative token_count events)
  let totalInput = baselineSnapshot.inputTokens;
  let totalOutput = baselineSnapshot.outputTokens;
  let totalCacheRead = baselineSnapshot.cacheReadTokens;
  let prevTokenSnapshot: TokenTotals = {
    inputTokens: baselineSnapshot.prevInputTokens,
    outputTokens: baselineSnapshot.prevOutputTokens,
    cacheReadTokens: baselineSnapshot.prevCacheReadTokens,
  };
  let currentTokenSnapshot: TokenTotals = {
    inputTokens: baselineSnapshot.inputTokens,
    outputTokens: baselineSnapshot.outputTokens,
    cacheReadTokens: baselineSnapshot.cacheReadTokens,
  };
  let tokenCountEvents = baselineSnapshot.tokenCountEvents;
  let sliceTokenCountEvents = 0;
  const totalCacheCreation = 0; // Codex doesn't report cache creation
  let contextWindowTokens = baselineSnapshot.contextWindowTokens;

  // Timestamp tracking
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  // Ongoing detection
  let lastTurnComplete = baselineSnapshot.lastTurnComplete;
  let openTurns = baselineSnapshot.openTurns;
  // Incremental split-turn limitation: if assistant content is before byteOffset and only
  // token_count/turn_complete lands in the delta slice, per-group usage may show 0 until
  // the next full reparse. Session-level metrics remain correct.
  const turnStack: ActiveTurnState[] = [];
  // Seed turn state for incremental parses where a turn started before byteOffset.
  // Without this, assistant messages in the slice have no turn context and receive
  // no usage attribution until the next full reparse.
  if (byteOffset > 0 && baselineSnapshot.openTurns > 0) {
    for (let i = 0; i < baselineSnapshot.openTurns; i++) {
      turnStack.push({
        startSnapshot: { ...currentTokenSnapshot },
        lastAssistantMsgIndex: -1,
      });
    }
  }

  // Compaction tracking
  let compactionCount = 0;
  const phases: PhaseTokenBreakdown[] = [];

  // Assistant buffer for coalescing consecutive assistant items
  let assistantBuffer: AssistantBuffer | null = null;

  // Pending tool results (function_call_output items to attach to the next user message)
  let pendingToolResults: UnifiedToolResult[] = [];
  let pendingToolResultContent: UnifiedContentBlock[] = [];

  // Byte tracking
  let bytesRead = byteOffset;

  // Cost
  let costUsd = 0;
  let visibleContextTokens = 0;

  // Warning accumulation
  let oversizedLineCount = 0;

  const stream = fs.createReadStream(filePath, {
    start: byteOffset,
    encoding: 'utf8',
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  function flushAssistantBuffer(): void {
    if (!assistantBuffer) return;
    if (assistantBuffer.content.length === 0 && assistantBuffer.toolCalls.length === 0) {
      assistantBuffer = null;
      return;
    }

    const msg: UnifiedMessage = {
      id: `codex-msg-${messageIndex++}`,
      parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
      role: 'assistant',
      timestamp: assistantBuffer.timestamp,
      content: assistantBuffer.content,
      model: primaryModel || undefined,
      toolCalls: assistantBuffer.toolCalls,
      toolResults: [],
      isMeta: false,
      isSidechain: false,
    };

    messages.push(msg);
    if (turnStack.length > 0) {
      turnStack[turnStack.length - 1].lastAssistantMsgIndex = messages.length - 1;
    }
    visibleContextTokens += estimateMessageTokens(msg.content);
    assistantBuffer = null;
  }

  function flushPendingToolResults(ts: Date): void {
    if (pendingToolResults.length === 0) return;

    const msg: UnifiedMessage = {
      id: `codex-msg-${messageIndex++}`,
      parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
      role: 'user',
      timestamp: ts,
      content: pendingToolResultContent,
      toolCalls: [],
      toolResults: pendingToolResults,
      isMeta: true,
      isSidechain: false,
    };

    messages.push(msg);
    visibleContextTokens += estimateMessageTokens(msg.content);
    pendingToolResults = [];
    pendingToolResultContent = [];
  }

  function ensureAssistantBuffer(ts: Date): AssistantBuffer {
    if (!assistantBuffer) {
      assistantBuffer = { timestamp: ts, content: [], toolCalls: [] };
    }
    return assistantBuffer;
  }

  function trackTimestamp(ts: Date): void {
    if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
  }

  function attachTurnUsage(turnState: ActiveTurnState): void {
    if (turnState.lastAssistantMsgIndex < 0) return;
    // Use prevTokenSnapshot (previous token_count event) instead of turn start snapshot.
    // Codex token_count values are cumulative across all API calls. Using the turn start
    // would give total tokens consumed across ALL API calls in the turn (e.g. 50 tool calls
    // × 50k context = 2.5M). Using the previous token_count event gives the LAST API call's
    // input tokens, which approximates the actual context size at that point.
    const usage: TokenUsage = {
      input: Math.max(0, currentTokenSnapshot.inputTokens - prevTokenSnapshot.inputTokens),
      output: Math.max(0, currentTokenSnapshot.outputTokens - prevTokenSnapshot.outputTokens),
      cacheRead: Math.max(
        0,
        currentTokenSnapshot.cacheReadTokens - prevTokenSnapshot.cacheReadTokens,
      ),
      cacheCreation: 0,
    };
    messages[turnState.lastAssistantMsgIndex].usage = usage;
  }

  try {
    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
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

      let entry: RawRolloutLine;
      try {
        entry = JSON.parse(line);
      } catch {
        logger.warn({ filePath }, 'Skipping malformed JSONL line');
        continue;
      }

      if (!entry.type) continue;

      const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
      trackTimestamp(ts);
      const payload = entry.payload ?? {};

      switch (entry.type) {
        // -----------------------------------------------------------------
        // Session metadata (first line)
        // -----------------------------------------------------------------
        case 'session_meta': {
          sessionId = payload.id as string | undefined;
          break;
        }

        // -----------------------------------------------------------------
        // Turn context — model and settings
        // -----------------------------------------------------------------
        case 'turn_context': {
          const model = payload.model as string | undefined;
          if (model) {
            primaryModel = model;
            modelsSet.add(model);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Response items — actual conversation data
        // -----------------------------------------------------------------
        case 'response_item': {
          const itemType = payload.type as string | undefined;
          if (!itemType) break;

          switch (itemType) {
            case 'message': {
              const role = payload.role as string | undefined;
              const contentItems = (payload.content as RawContentItem[] | undefined) ?? [];

              if (role === 'user') {
                // Flush any pending assistant buffer first
                flushAssistantBuffer();
                // Flush pending tool results before user message
                flushPendingToolResults(ts);

                const textParts = contentItems
                  .filter((c) => c.type === 'input_text' && c.text)
                  .map((c) => c.text!);

                if (textParts.length > 0) {
                  const msg: UnifiedMessage = {
                    id: `codex-msg-${messageIndex++}`,
                    parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
                    role: 'user',
                    timestamp: ts,
                    content: [{ type: 'text', text: textParts.join('\n') }],
                    toolCalls: [],
                    toolResults: [],
                    isMeta: false,
                    isSidechain: false,
                  };
                  messages.push(msg);
                  visibleContextTokens += estimateMessageTokens(msg.content);
                }
              } else if (role === 'assistant') {
                // Flush pending tool results before assistant message
                flushPendingToolResults(ts);

                const buf = ensureAssistantBuffer(ts);
                const textParts = contentItems
                  .filter((c) => c.type === 'output_text' && c.text)
                  .map((c) => c.text!);

                if (textParts.length > 0) {
                  buf.content.push({ type: 'text', text: textParts.join('\n') });
                }
              }
              // Skip developer/system role messages
              break;
            }

            case 'reasoning': {
              flushPendingToolResults(ts);
              const buf = ensureAssistantBuffer(ts);
              const summaryItems = (payload.summary as RawContentItem[] | undefined) ?? [];
              const thinkingText = summaryItems
                .filter((s) => s.type === 'summary_text' && s.text)
                .map((s) => s.text!)
                .join('\n');

              if (thinkingText) {
                buf.content.push({ type: 'thinking', thinking: thinkingText });
              }
              break;
            }

            case 'function_call': {
              if (!includeToolCalls) break;
              flushPendingToolResults(ts);
              const buf = ensureAssistantBuffer(ts);
              const callId = payload.call_id as string | undefined;
              const name = payload.name as string | undefined;
              let input: Record<string, unknown> = {};
              try {
                const args = payload.arguments as string | undefined;
                if (args) input = JSON.parse(args);
              } catch {
                input = { raw: payload.arguments };
              }

              if (callId && name) {
                buf.content.push({
                  type: 'tool_call',
                  toolCallId: callId,
                  toolName: name,
                  input,
                });
                buf.toolCalls.push({
                  id: callId,
                  name,
                  input,
                  isTask: false,
                });
              }
              break;
            }

            case 'local_shell_call': {
              if (!includeToolCalls) break;
              flushPendingToolResults(ts);
              const buf = ensureAssistantBuffer(ts);
              const callId = payload.call_id as string | undefined;
              const action = payload.action as Record<string, unknown> | undefined;
              const command = action?.command;
              const cmdStr = Array.isArray(command) ? command.join(' ') : String(command ?? '');
              const name = 'shell';
              const input = { command: cmdStr };

              if (callId) {
                buf.content.push({
                  type: 'tool_call',
                  toolCallId: callId,
                  toolName: name,
                  input,
                });
                buf.toolCalls.push({
                  id: callId,
                  name,
                  input,
                  isTask: false,
                });
              }
              break;
            }

            case 'function_call_output': {
              if (!includeToolCalls) break;

              // Flush assistant buffer so tool results come after the tool call
              flushAssistantBuffer();

              const callId = payload.call_id as string | undefined;
              const output = (payload.output as string) ?? '';

              if (callId) {
                pendingToolResultContent.push({
                  type: 'tool_result',
                  toolCallId: callId,
                  content: output,
                  isError: false,
                });
                pendingToolResults.push({
                  toolCallId: callId,
                  content: output,
                  isError: false,
                });
              }
              break;
            }

            // web_search_call, custom_tool_call, ghost_snapshot etc — skip for now
            default:
              break;
          }
          break;
        }

        // -----------------------------------------------------------------
        // Event messages
        // -----------------------------------------------------------------
        case 'event_msg': {
          const eventType = payload.type as string | undefined;
          if (!eventType) break;

          switch (eventType) {
            case 'task_started':
            case 'turn_started': {
              openTurns++;
              lastTurnComplete = false;
              turnStack.push({
                startSnapshot: { ...currentTokenSnapshot },
                lastAssistantMsgIndex: -1,
              });
              break;
            }

            case 'task_complete':
            case 'turn_complete': {
              // Flush remaining assistant buffer at turn end
              flushAssistantBuffer();
              flushPendingToolResults(ts);
              if (turnStack.length > 0) {
                attachTurnUsage(turnStack.pop()!);
              }
              openTurns = Math.max(0, openTurns - 1);
              if (openTurns === 0) lastTurnComplete = true;
              break;
            }

            case 'token_count': {
              const info = payload.info as Record<string, unknown> | undefined;
              if (info) {
                const total = info.total_token_usage as RawTokenUsage | undefined;
                if (total) {
                  // Codex input_tokens INCLUDES cached_input_tokens — subtract to avoid double-counting
                  const rawInput = total.input_tokens ?? 0;
                  const cached = total.cached_input_tokens ?? 0;
                  totalInput = rawInput - cached;
                  totalOutput = (total.output_tokens ?? 0) + (total.reasoning_output_tokens ?? 0);
                  totalCacheRead = cached;
                  prevTokenSnapshot = currentTokenSnapshot;
                  currentTokenSnapshot = {
                    inputTokens: totalInput,
                    outputTokens: totalOutput,
                    cacheReadTokens: totalCacheRead,
                  };
                  tokenCountEvents++;
                  sliceTokenCountEvents++;
                }
                const ctxWindow = info.model_context_window as number | undefined;
                if (ctxWindow) contextWindowTokens = ctxWindow;
              }
              break;
            }

            case 'context_compacted': {
              flushAssistantBuffer();
              flushPendingToolResults(ts);
              compactionCount++;
              visibleContextTokens = 0;
              break;
            }

            // Other events — skip
            default:
              break;
          }
          break;
        }

        // -----------------------------------------------------------------
        // Compacted — context compression marker
        // -----------------------------------------------------------------
        case 'compacted': {
          flushAssistantBuffer();
          flushPendingToolResults(ts);
          compactionCount++;
          visibleContextTokens = 0;

          const compactionText = (payload.message as string) ?? 'Context compacted';
          const msg: UnifiedMessage = {
            id: `codex-msg-${messageIndex++}`,
            parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
            role: 'user',
            timestamp: ts,
            content: [{ type: 'text', text: compactionText }],
            toolCalls: [],
            toolResults: [],
            isMeta: true,
            isSidechain: false,
            isCompactSummary: true,
          };
          messages.push(msg);
          visibleContextTokens += estimateMessageTokens(msg.content);
          break;
        }

        // Skip unknown types gracefully
        default:
          logger.debug({ type: entry.type }, 'Skipping unknown Codex rollout line type');
          break;
      }

      // Check max messages limit
      if (maxMessages && messages.length >= maxMessages) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Flush any remaining buffers
  flushAssistantBuffer();
  flushPendingToolResults(lastTimestamp ?? new Date());
  while (turnStack.length > 0) {
    attachTurnUsage(turnStack.pop()!);
  }

  // Codex token_count values are cumulative. For incremental parses, expose
  // additive deltas while preserving latest-state fields separately.
  const deltaInput =
    byteOffset > 0 ? Math.max(0, totalInput - baselineSnapshot.inputTokens) : totalInput;
  const deltaOutput =
    byteOffset > 0 ? Math.max(0, totalOutput - baselineSnapshot.outputTokens) : totalOutput;
  const deltaCacheRead =
    byteOffset > 0
      ? Math.max(0, totalCacheRead - baselineSnapshot.cacheReadTokens)
      : totalCacheRead;

  // Cost calculation
  if (pricing && primaryModel) {
    costUsd = pricing.calculateMessageCost(
      primaryModel,
      deltaInput,
      deltaOutput,
      deltaCacheRead,
      totalCacheCreation,
    );
  }

  // Duration
  const durationMs =
    firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

  // Ongoing detection
  const isOngoing = !lastTurnComplete;

  // Phase breakdowns (simplified — Codex doesn't provide per-phase data like Claude)
  if (phases.length === 0) {
    phases.push({
      phaseNumber: 1,
      contribution: deltaInput + deltaCacheRead,
      peakTokens: deltaInput + deltaCacheRead,
    });
  }

  const totalTokens = deltaInput + deltaOutput + deltaCacheRead + totalCacheCreation;
  let totalContextTokens = 0;
  if (sliceTokenCountEvents >= 1 && tokenCountEvents > 0) {
    totalContextTokens = Math.max(
      0,
      sumTokenTotals(currentTokenSnapshot) - sumTokenTotals(prevTokenSnapshot),
    );
  }
  const totalContextConsumption = phases.reduce((sum, p) => sum + p.contribution, 0);
  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  const metrics: UnifiedMetrics = {
    inputTokens: deltaInput,
    outputTokens: deltaOutput,
    cacheReadTokens: deltaCacheRead,
    cacheCreationTokens: totalCacheCreation,
    totalTokens,
    totalContextConsumption,
    compactionCount,
    phaseBreakdowns: phases,
    visibleContextTokens,
    totalContextTokens,
    contextWindowTokens,
    costUsd,
    primaryModel,
    modelsUsed,
    durationMs,
    messageCount: messages.length,
    isOngoing,
  };

  const warnings: string[] = [];
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

async function readTokenSnapshotBeforeOffset(
  filePath: string,
  byteOffset: number,
): Promise<TokenSnapshot> {
  const snapshot: TokenSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    prevInputTokens: 0,
    prevOutputTokens: 0,
    prevCacheReadTokens: 0,
    tokenCountEvents: 0,
    contextWindowTokens: 200_000,
    primaryModel: '',
    modelsUsed: [],
    lastTurnComplete: true,
    openTurns: 0,
  };
  const modelsSet = new Set<string>();

  if (byteOffset <= 0) return snapshot;

  const stream = fs.createReadStream(filePath, {
    start: 0,
    end: Math.max(0, byteOffset - 1),
    encoding: 'utf8',
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (lineBytes > MAX_LINE_BYTES) {
        logger.warn(
          { filePath, lineBytes, snippet: line.slice(0, 200) },
          'Skipping oversized JSONL line in snapshot read (>10MB)',
        );
        continue;
      }

      let entry: RawRolloutLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'turn_context') {
        const model = (entry.payload?.model as string | undefined) ?? '';
        if (model) {
          snapshot.primaryModel = model;
          modelsSet.add(model);
        }
        continue;
      }

      if (entry.type !== 'event_msg') continue;
      const payload = entry.payload ?? {};
      const eventType = payload.type as string | undefined;
      if (!eventType) continue;

      if (eventType === 'task_started' || eventType === 'turn_started') {
        snapshot.openTurns++;
        snapshot.lastTurnComplete = false;
        continue;
      }

      if (eventType === 'task_complete' || eventType === 'turn_complete') {
        snapshot.openTurns = Math.max(0, snapshot.openTurns - 1);
        if (snapshot.openTurns === 0) snapshot.lastTurnComplete = true;
        continue;
      }

      if (eventType !== 'token_count') continue;

      const info = payload.info as Record<string, unknown> | undefined;
      if (!info) continue;

      const total = info.total_token_usage as RawTokenUsage | undefined;
      if (total) {
        snapshot.prevInputTokens = snapshot.inputTokens;
        snapshot.prevOutputTokens = snapshot.outputTokens;
        snapshot.prevCacheReadTokens = snapshot.cacheReadTokens;
        // Codex input_tokens INCLUDES cached_input_tokens — subtract to avoid double-counting
        const rawInput = total.input_tokens ?? 0;
        const cached = total.cached_input_tokens ?? 0;
        snapshot.inputTokens = rawInput - cached;
        snapshot.outputTokens = (total.output_tokens ?? 0) + (total.reasoning_output_tokens ?? 0);
        snapshot.cacheReadTokens = cached;
        snapshot.tokenCountEvents++;
      }

      const ctxWindow = info.model_context_window as number | undefined;
      if (ctxWindow) snapshot.contextWindowTokens = ctxWindow;
    }
  } catch (error) {
    logger.warn(
      { error, filePath, byteOffset },
      'Failed to pre-scan Codex token baseline; defaulting to zero baseline',
    );
  } finally {
    rl.close();
    stream.destroy();
  }

  snapshot.modelsUsed = Array.from(modelsSet);
  return snapshot;
}
