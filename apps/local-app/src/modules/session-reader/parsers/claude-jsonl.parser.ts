import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { createLogger } from '../../../common/logging/logger';
import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedToolResult,
  TokenUsage,
  UnifiedMetrics,
  PhaseTokenBreakdown,
} from '../dtos/unified-session.types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { estimateMessageTokens } from '../adapters/utils/estimate-content-tokens';

const logger = createLogger('ClaudeJsonlParser');

/** Maximum allowed line length in bytes (10 MB) */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

/** Filtered entry types that are not converted to messages */
const FILTERED_TYPES = new Set(['summary', 'file-history-snapshot', 'queue-operation', 'progress']);

// ---------------------------------------------------------------------------
// Raw JSONL types
// ---------------------------------------------------------------------------

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

interface RawClaudeEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
    model?: string;
    id?: string;
    usage?: RawUsage;
    stop_reason?: string | null;
  };
  isMeta?: boolean;
  isCompactSummary?: boolean;
  subtype?: string;
  durationMs?: number;
  /** Links subagent's first user entry back to parent's Task tool_use block */
  sourceToolUseID?: string;
}

// ---------------------------------------------------------------------------
// Compaction tracking state
// ---------------------------------------------------------------------------

interface CompactionState {
  lastMainAssistantInputTokens: number;
  awaitingPostCompaction: boolean;
  phases: PhaseTokenBreakdown[];
  compactionCount: number;
  currentPhaseNumber: number;
  lastCompactionMessageId?: string;
}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface ClaudeParseResult {
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  bytesRead: number;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

export interface ClaudeParseOptions {
  maxMessages?: number;
  byteOffset?: number;
  includeToolCalls?: boolean;
  pricingService?: PricingServiceInterface;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseClaudeJsonl(
  filePath: string,
  options?: ClaudeParseOptions,
): Promise<ClaudeParseResult> {
  const byteOffset = options?.byteOffset ?? 0;
  const maxMessages = options?.maxMessages;
  const includeToolCalls = options?.includeToolCalls ?? true;
  const pricing = options?.pricingService;

  const messages: UnifiedMessage[] = [];

  // Token accumulators
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let costUsd = 0;

  // Timestamp tracking
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  // Model tracking
  let primaryModel = '';
  const modelsSet = new Set<string>();

  // Compaction tracking
  const compaction: CompactionState = {
    lastMainAssistantInputTokens: 0,
    awaitingPostCompaction: false,
    phases: [],
    compactionCount: 0,
    currentPhaseNumber: 1,
  };

  // Visible context
  let visibleContextTokens = 0;
  let totalContextTokens = 0;

  // Ongoing detection: track last assistant stop_reason
  let lastAssistantStopReason: string | null = null;

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

  try {
    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
      bytesRead += lineBytes;

      // Skip empty lines
      if (!line.trim()) continue;

      // Max line length guard
      if (lineBytes > MAX_LINE_BYTES) {
        logger.warn(
          { filePath, lineBytes, byteOffset: bytesRead - lineBytes, snippet: line.slice(0, 200) },
          'Skipping oversized JSONL line (>10MB)',
        );
        oversizedLineCount++;
        continue;
      }

      // Parse JSON
      let entry: RawClaudeEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        logger.warn({ filePath }, 'Skipping malformed JSONL line');
        continue;
      }

      // Skip filtered types
      if (!entry.type || FILTERED_TYPES.has(entry.type)) continue;

      // Skip system entries (extract nothing for now)
      if (entry.type === 'system') continue;

      // Only process user and assistant
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;

      // Track timestamps
      const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;

      const msg = entry.message;
      if (!msg) continue;

      // Build unified message
      const unified = buildUnifiedMessage(entry, ts, includeToolCalls);
      if (!unified) continue;

      if (!entry.isSidechain) {
        visibleContextTokens += estimateMessageTokens(unified.content);
      }

      // Process assistant-specific metrics
      if (entry.type === 'assistant' && msg.usage) {
        const usage = msg.usage;
        const input = usage.input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cacheCreation = usage.cache_creation_input_tokens ?? 0;

        totalInput += input;
        totalOutput += output;
        totalCacheRead += cacheRead;
        totalCacheCreation += cacheCreation;

        // Cost calculation via PricingService
        if (pricing && msg.model) {
          costUsd += pricing.calculateMessageCost(
            msg.model,
            input,
            output,
            cacheRead,
            cacheCreation,
          );
        }

        // Model tracking
        if (msg.model && msg.model !== '<synthetic>') {
          primaryModel = msg.model;
          modelsSet.add(msg.model);
        }

        // Last assistant stop_reason for ongoing detection
        lastAssistantStopReason = msg.stop_reason ?? null;

        // Compaction tracking (main thread only)
        if (!entry.isSidechain) {
          const inputTokens = input + cacheRead + cacheCreation;

          if (compaction.awaitingPostCompaction) {
            // Record post-compaction on current phase
            const currentPhase = compaction.phases[compaction.phases.length - 1];
            if (currentPhase) {
              currentPhase.postCompaction = inputTokens;
              currentPhase.contribution =
                currentPhase.peakTokens -
                (compaction.phases.length > 1
                  ? (compaction.phases[compaction.phases.length - 2]?.postCompaction ?? 0)
                  : 0);
            }
            // Start new phase
            compaction.currentPhaseNumber++;
            compaction.awaitingPostCompaction = false;
          }

          compaction.lastMainAssistantInputTokens = inputTokens;
          totalContextTokens = input + output + cacheRead + cacheCreation;
        }
      }

      // Compaction detection (user compact summary)
      if (entry.type === 'user' && entry.isCompactSummary && !entry.isSidechain) {
        // Record pre-compaction peak
        compaction.phases.push({
          phaseNumber: compaction.currentPhaseNumber,
          contribution: 0, // computed when post-compaction arrives
          peakTokens: compaction.lastMainAssistantInputTokens,
          compactionMessageId: entry.uuid,
        });
        compaction.compactionCount++;
        compaction.awaitingPostCompaction = true;
      }

      messages.push(unified);

      if (entry.type === 'user' && entry.isCompactSummary && !entry.isSidechain) {
        // Reset visible context to compact summary tokens only.
        visibleContextTokens = estimateMessageTokens(unified.content);
      }

      // Check max messages limit
      if (maxMessages && messages.length >= maxMessages) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Finalize phases: add final phase only when last postCompaction > 0
  const lastPhase = compaction.phases[compaction.phases.length - 1];
  if (
    compaction.phases.length > 0 &&
    lastPhase?.postCompaction !== undefined &&
    lastPhase.postCompaction > 0
  ) {
    const finalContribution = compaction.lastMainAssistantInputTokens - lastPhase.postCompaction;
    compaction.phases.push({
      phaseNumber: compaction.currentPhaseNumber,
      contribution: finalContribution,
      peakTokens: compaction.lastMainAssistantInputTokens,
    });
  } else if (compaction.phases.length === 0) {
    // No compactions: single phase = total input
    compaction.phases.push({
      phaseNumber: 1,
      contribution: compaction.lastMainAssistantInputTokens,
      peakTokens: compaction.lastMainAssistantInputTokens,
    });
  }

  // Fix first phase contribution (no predecessor)
  if (compaction.phases.length > 0 && compaction.compactionCount > 0) {
    compaction.phases[0].contribution = compaction.phases[0].peakTokens;
  }

  // Total context consumption
  const totalContextConsumption = compaction.phases.reduce((sum, p) => sum + p.contribution, 0);

  // Duration
  const durationMs =
    firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

  // Ongoing detection
  const isOngoing = lastAssistantStopReason === null || lastAssistantStopReason === 'tool_use';

  // Context window from pricing
  const contextWindowTokens = pricing ? pricing.getContextWindowSize(primaryModel) : 200_000;

  // Models used (only populated if >1)
  const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreation;

  const metrics: UnifiedMetrics = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreation,
    totalTokens,
    totalContextConsumption,
    compactionCount: compaction.compactionCount,
    phaseBreakdowns: compaction.phases,
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

  return { messages, metrics, bytesRead, warnings: warnings.length > 0 ? warnings : undefined };
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildUnifiedMessage(
  entry: RawClaudeEntry,
  timestamp: Date,
  includeToolCalls: boolean,
): UnifiedMessage | null {
  const msg = entry.message;
  if (!msg) return null;

  const role = entry.type === 'assistant' ? 'assistant' : 'user';
  const id = entry.uuid ?? '';
  const parentId = entry.parentUuid ?? null;
  const isMeta = entry.isMeta ?? false;
  const isSidechain = entry.isSidechain ?? false;
  const isCompactSummary = entry.isCompactSummary ?? false;
  const model = msg.model;

  let content: UnifiedContentBlock[] = [];
  let toolCalls: UnifiedToolCall[] = [];
  let toolResults: UnifiedToolResult[] = [];
  let usage: TokenUsage | undefined;

  if (entry.type === 'assistant') {
    // Extract usage
    if (msg.usage) {
      usage = {
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
      };
    }

    // Extract content blocks from assistant message
    if (Array.isArray(msg.content)) {
      const extracted = extractAssistantContent(msg.content as RawContentBlock[], includeToolCalls);
      content = extracted.content;
      toolCalls = extracted.toolCalls;
    }
  } else if (entry.type === 'user') {
    if (typeof msg.content === 'string') {
      // Plain text user message
      content = [{ type: 'text', text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      // Tool results or structured content
      const extracted = extractUserContent(msg.content as RawContentBlock[]);
      content = extracted.content;
      toolResults = extracted.toolResults;
    }
  }

  return {
    id,
    parentId,
    role,
    timestamp,
    content,
    usage,
    model,
    toolCalls,
    toolResults,
    isMeta,
    isSidechain,
    isCompactSummary: isCompactSummary || undefined,
    sourceToolUseId: entry.sourceToolUseID || undefined,
  };
}

// ---------------------------------------------------------------------------
// Content extractors
// ---------------------------------------------------------------------------

function extractAssistantContent(
  rawContent: RawContentBlock[],
  includeToolCalls: boolean,
): { content: UnifiedContentBlock[]; toolCalls: UnifiedToolCall[] } {
  const content: UnifiedContentBlock[] = [];
  const toolCalls: UnifiedToolCall[] = [];

  for (const block of rawContent) {
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) {
          content.push({ type: 'text', text: block.text });
        }
        break;

      case 'thinking':
        if (block.thinking !== undefined) {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature,
          });
        }
        break;

      case 'tool_use':
        if (block.id && block.name) {
          if (includeToolCalls) {
            content.push({
              type: 'tool_call',
              toolCallId: block.id,
              toolName: block.name,
              input: (block.input as Record<string, unknown>) ?? {},
            });
          }
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: (block.input as Record<string, unknown>) ?? {},
            isTask: block.name === 'Task',
            taskDescription:
              block.name === 'Task' ? (block.input?.description as string | undefined) : undefined,
            taskSubagentType:
              block.name === 'Task'
                ? (block.input?.subagent_type as string | undefined)
                : undefined,
          });
        }
        break;

      case 'image':
        if (block.source) {
          content.push({
            type: 'image',
            mediaType: block.source.media_type ?? 'image/png',
            data: block.source.data ?? '',
          });
        }
        break;
    }
  }

  return { content, toolCalls };
}

function extractUserContent(rawContent: RawContentBlock[]): {
  content: UnifiedContentBlock[];
  toolResults: UnifiedToolResult[];
} {
  const content: UnifiedContentBlock[] = [];
  const toolResults: UnifiedToolResult[] = [];

  for (const block of rawContent) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      const resultContent = block.content ?? '';
      content.push({
        type: 'tool_result',
        toolCallId: block.tool_use_id,
        content: resultContent as string | unknown[],
        isError: block.is_error ?? false,
      });
      toolResults.push({
        toolCallId: block.tool_use_id,
        content: resultContent as string | unknown[],
        isError: block.is_error ?? false,
      });
    } else if (block.type === 'text' && block.text !== undefined) {
      content.push({ type: 'text', text: block.text });
    }
  }

  return { content, toolResults };
}
