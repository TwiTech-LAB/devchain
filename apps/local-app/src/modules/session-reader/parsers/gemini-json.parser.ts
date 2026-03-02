import * as fs from 'node:fs/promises';
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

const logger = createLogger('GeminiJsonParser');

// ---------------------------------------------------------------------------
// Raw Gemini session types (defensive — all fields optional)
// ---------------------------------------------------------------------------

interface RawConversationRecord {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: RawMessageRecord[];
  summary?: string;
  kind?: string;
}

interface RawMessageRecord {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string | RawPart[];
  displayContent?: string | RawPart[];
  model?: string;
  tokens?: RawTokensSummary;
  thoughts?: RawThought[];
  toolCalls?: RawToolCallRecord[];
}

interface RawPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: { output?: string };
  };
}

interface RawTokensSummary {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface RawThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface RawToolCallRecord {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: RawPart[] | null;
  status?: string;
  timestamp?: string;
  displayName?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface GeminiParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  bytesRead: number;
  sessionId?: string;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

export interface GeminiParseOptions {
  maxMessages?: number;
  includeToolCalls?: boolean;
  pricingService?: PricingServiceInterface;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextContent(content: string | RawPart[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => typeof p.text === 'string' && p.text.trim().length > 0)
    .map((p) => p.text!)
    .join('\n');
}

function extractToolResultText(result: RawPart[] | null | undefined): string {
  if (!result || !Array.isArray(result)) return '';
  return result
    .map((p) => {
      if (p.functionResponse?.response?.output) {
        return p.functionResponse.response.output;
      }
      if (p.text) return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function asParts(content: string | RawPart[] | undefined): RawPart[] {
  return Array.isArray(content) ? content : [];
}

function extractToolParts(rawMsg: RawMessageRecord): RawPart[] {
  return [...asParts(rawMsg.content), ...asParts(rawMsg.displayContent)];
}

function makeToolResultKey(toolCallId: string, content: string): string {
  return `${toolCallId}::${content}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseGeminiJson(
  filePath: string,
  options?: GeminiParseOptions,
): Promise<GeminiParseResult> {
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const pricing = options?.pricingService;

  // Read the entire file
  let fileContent: string;
  let bytesRead: number;

  try {
    const stat = await fs.stat(filePath);
    bytesRead = stat.size;
    fileContent = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    logger.warn({ filePath, error }, 'Failed to read Gemini session file');
    return emptyResult(0, undefined, ['File could not be read — session data unavailable']);
  }

  if (!fileContent.trim()) {
    return emptyResult(bytesRead);
  }

  // Parse JSON
  let record: RawConversationRecord;
  try {
    record = JSON.parse(fileContent);
  } catch {
    logger.warn({ filePath }, 'Failed to parse Gemini session file as JSON');
    return emptyResult(bytesRead);
  }

  if (!record.messages || !Array.isArray(record.messages)) {
    return emptyResult(bytesRead, record.sessionId);
  }

  const messages: UnifiedMessage[] = [];
  let messageIndex = 0;

  // Model tracking
  let primaryModel = '';
  const modelsSet = new Set<string>();

  // Token accumulators
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalContextTokens = 0;
  let visibleContextTokens = 0;
  const totalCacheCreation = 0; // Gemini doesn't report cache creation separately
  const contextWindowTokens = 1_000_000; // Gemini default context window

  // Timestamp tracking
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  // Cost
  let costUsd = 0;

  function trackTimestamp(ts: Date): void {
    if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
    if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
  }

  for (const rawMsg of record.messages) {
    if (maxMessages && messages.length >= maxMessages) break;

    if (!rawMsg.type) continue;

    const ts = rawMsg.timestamp ? new Date(rawMsg.timestamp) : new Date();
    trackTimestamp(ts);

    switch (rawMsg.type) {
      case 'user': {
        const text = extractTextContent(rawMsg.content);
        if (!text) break;

        const msg: UnifiedMessage = {
          id: rawMsg.id ?? `gemini-msg-${messageIndex++}`,
          parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
          role: 'user',
          timestamp: ts,
          content: [{ type: 'text', text }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
        };
        messages.push(msg);
        visibleContextTokens += estimateMessageTokens(msg.content);
        break;
      }

      case 'gemini': {
        // Track model
        if (rawMsg.model) {
          if (!primaryModel) primaryModel = rawMsg.model;
          modelsSet.add(rawMsg.model);
        }

        // Accumulate tokens
        if (rawMsg.tokens) {
          totalInput += rawMsg.tokens.input ?? 0;
          totalOutput += (rawMsg.tokens.output ?? 0) + (rawMsg.tokens.thoughts ?? 0);
          totalCacheRead += rawMsg.tokens.cached ?? 0;
          totalContextTokens =
            (rawMsg.tokens.input ?? 0) +
            (rawMsg.tokens.output ?? 0) +
            (rawMsg.tokens.thoughts ?? 0) +
            (rawMsg.tokens.cached ?? 0);
        }

        // Build content blocks
        const content: UnifiedContentBlock[] = [];
        const toolCalls: UnifiedToolCall[] = [];
        const toolResults: UnifiedToolResult[] = [];
        const seenToolCallIds = new Set<string>();
        const seenToolResultKeys = new Set<string>();

        // Thinking/reasoning
        if (rawMsg.thoughts && rawMsg.thoughts.length > 0) {
          const thinkingText = rawMsg.thoughts
            .map((t) => [t.subject, t.description].filter(Boolean).join(': '))
            .join('\n');
          if (thinkingText) {
            content.push({ type: 'thinking', thinking: thinkingText });
          }
        }

        // Text content
        const text = extractTextContent(rawMsg.content);
        if (text) {
          content.push({ type: 'text', text });
        }

        // Tool calls
        if (includeToolCalls && rawMsg.toolCalls && rawMsg.toolCalls.length > 0) {
          for (const tc of rawMsg.toolCalls) {
            if (!tc.id || !tc.name) continue;
            if (seenToolCallIds.has(tc.id)) continue;

            content.push({
              type: 'tool_call',
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.args ?? {},
            });
            toolCalls.push({
              id: tc.id,
              name: tc.name,
              input: tc.args ?? {},
              isTask: false,
            });
            seenToolCallIds.add(tc.id);

            // Tool result
            if (tc.result) {
              const resultText = extractToolResultText(tc.result);
              const isError = tc.status === 'error';
              const resultKey = makeToolResultKey(tc.id, resultText);
              if (seenToolResultKeys.has(resultKey)) continue;
              content.push({
                type: 'tool_result',
                toolCallId: tc.id,
                content: resultText,
                isError,
              });
              toolResults.push({
                toolCallId: tc.id,
                content: resultText,
                isError,
              });
              seenToolResultKeys.add(resultKey);
            }
          }
        }

        // Tool calls/results encoded as content/displayContent parts.
        if (includeToolCalls) {
          for (const part of extractToolParts(rawMsg)) {
            const fc = part.functionCall;
            if (fc?.name) {
              const callId = fc.id ?? `gemini-fc-${messageIndex}-${toolCalls.length}`;
              if (!seenToolCallIds.has(callId)) {
                content.push({
                  type: 'tool_call',
                  toolCallId: callId,
                  toolName: fc.name,
                  input: fc.args ?? {},
                });
                toolCalls.push({
                  id: callId,
                  name: fc.name,
                  input: fc.args ?? {},
                  isTask: false,
                });
                seenToolCallIds.add(callId);
              }
            }

            const fr = part.functionResponse;
            if (fr) {
              const toolCallId = fr.id ?? '';
              const resultText = fr.response?.output ?? '';
              const resultKey = makeToolResultKey(toolCallId, resultText);
              if (!seenToolResultKeys.has(resultKey)) {
                content.push({
                  type: 'tool_result',
                  toolCallId,
                  content: resultText,
                  isError: false,
                });
                toolResults.push({
                  toolCallId,
                  content: resultText,
                  isError: false,
                });
                seenToolResultKeys.add(resultKey);
              }
            }
          }
        }

        // Skip if no content at all
        if (content.length === 0) break;

        const msg: UnifiedMessage = {
          id: rawMsg.id ?? `gemini-msg-${messageIndex++}`,
          parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
          role: 'assistant',
          timestamp: ts,
          content,
          usage: rawMsg.tokens
            ? {
                input: rawMsg.tokens.input ?? 0,
                output: (rawMsg.tokens.output ?? 0) + (rawMsg.tokens.thoughts ?? 0),
                cacheRead: rawMsg.tokens.cached ?? 0,
                cacheCreation: 0,
              }
            : undefined,
          model: rawMsg.model,
          toolCalls,
          toolResults,
          isMeta: false,
          isSidechain: false,
        };
        messages.push(msg);
        visibleContextTokens += estimateMessageTokens(msg.content);
        break;
      }

      case 'info':
      case 'error':
      case 'warning': {
        const text = extractTextContent(rawMsg.content);
        if (!text) break;

        const msg: UnifiedMessage = {
          id: rawMsg.id ?? `gemini-msg-${messageIndex++}`,
          parentId: messages.length > 0 ? messages[messages.length - 1].id : null,
          role: 'system',
          timestamp: ts,
          content: [{ type: 'text', text }],
          toolCalls: [],
          toolResults: [],
          isMeta: true,
          isSidechain: false,
        };
        messages.push(msg);
        break;
      }

      default:
        logger.debug({ type: rawMsg.type }, 'Skipping unknown Gemini message type');
        break;
    }
  }

  // Cost calculation
  if (pricing && primaryModel) {
    costUsd = pricing.calculateMessageCost(
      primaryModel,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheCreation,
    );
  }

  // Duration
  const startTs = record.startTime ? new Date(record.startTime) : firstTimestamp;
  const endTs = record.lastUpdated ? new Date(record.lastUpdated) : lastTimestamp;
  const durationMs = startTs && endTs ? endTs.getTime() - startTs.getTime() : 0;

  // Phase breakdowns (simplified — Gemini doesn't support compaction yet)
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreation;
  const phases: PhaseTokenBreakdown[] = [
    {
      phaseNumber: 1,
      contribution: visibleContextTokens,
      peakTokens: visibleContextTokens,
    },
  ];

  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  const metrics: UnifiedMetrics = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreation,
    totalTokens,
    totalContextConsumption: visibleContextTokens,
    compactionCount: 0,
    phaseBreakdowns: phases,
    visibleContextTokens,
    totalContextTokens,
    contextWindowTokens,
    costUsd,
    primaryModel,
    modelsUsed,
    durationMs,
    messageCount: messages.length,
    isOngoing: false,
  };

  return { messages, metrics, bytesRead, sessionId: record.sessionId };
}

function emptyResult(
  bytesRead: number,
  sessionId?: string,
  warnings?: string[],
): GeminiParseResult {
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
      contextWindowTokens: 1_000_000,
      costUsd: 0,
      primaryModel: '',
      durationMs: 0,
      messageCount: 0,
      isOngoing: false,
    },
    bytesRead,
    sessionId,
    warnings,
  };
}
