/**
 * Unified Session Model Types
 *
 * Provider-agnostic types that define the contract between session reader
 * adapters and the rest of the system. All adapters must produce these types
 * so the service layer and UI can consume data uniformly.
 */

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

/** Per-message token usage breakdown */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// ---------------------------------------------------------------------------
// Content Blocks (discriminated union)
// ---------------------------------------------------------------------------

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ThinkingContentBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolCallContentBlock {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  isTruncated?: boolean;
  fullLength?: number;
}

export interface ImageContentBlock {
  type: 'image';
  mediaType: string;
  data: string;
}

/** Discriminated union of all content block types */
export type UnifiedContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock
  | ImageContentBlock;

// ---------------------------------------------------------------------------
// Tool Call / Tool Result
// ---------------------------------------------------------------------------

export interface UnifiedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isTask: boolean;
  taskDescription?: string;
  taskSubagentType?: string;
}

export interface UnifiedToolResult {
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  isTruncated?: boolean;
  fullLength?: number;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type UnifiedMessageRole = 'user' | 'assistant' | 'system';

export interface UnifiedMessage {
  id: string;
  parentId: string | null;
  role: UnifiedMessageRole;
  timestamp: Date;
  content: UnifiedContentBlock[];
  usage?: TokenUsage;
  model?: string;
  toolCalls: UnifiedToolCall[];
  toolResults: UnifiedToolResult[];
  isMeta: boolean;
  isSidechain: boolean;
  isCompactSummary?: boolean;
  /** Links subagent's first user message back to parent's Task tool_use ID */
  sourceToolUseId?: string;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface PhaseTokenBreakdown {
  phaseNumber: number;
  /** Tokens added in this phase */
  contribution: number;
  /** Pre-compaction peak token count */
  peakTokens: number;
  /** Post-compaction token count (undefined for last active phase) */
  postCompaction?: number;
  /** Links to compaction event for deterministic debugging */
  compactionMessageId?: string;
}

export interface UnifiedMetrics {
  // Per-category token totals (aggregated across all messages)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;

  // Cross-compaction context consumption
  totalContextConsumption: number;
  compactionCount: number;
  phaseBreakdowns: PhaseTokenBreakdown[];

  // Context snapshot
  /**
   * Estimated tokens from identifiable content injections in the current context
   * window (post-last-compaction). Recomputed from all messages on cache merge.
   */
  visibleContextTokens: number;
  /**
   * Total tokens from the last API call (input + output + cacheRead +
   * cacheCreation). Latest-state field: updated from incremental deltas when
   * assistant message observed (>0 guard in cache merge).
   */
  totalContextTokens: number;
  contextWindowTokens: number;

  // Cost
  costUsd: number;

  // Model identification
  primaryModel: string;
  modelsUsed?: string[];

  // Session metadata
  durationMs: number;
  messageCount: number;
  isOngoing: boolean;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface UnifiedSession {
  id: string;
  providerName: string;
  filePath: string;
  messages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  isOngoing: boolean;
  /** Semantic chunks (populated by chunk builder in Phase 2+) */
  chunks?: import('./unified-chunk.types').UnifiedChunk[];
  /** Degradation warnings when session data may be incomplete (e.g., oversized lines skipped) */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Process (subagent resolution)
// ---------------------------------------------------------------------------

/** How a subagent file was matched to a parent Task tool call */
export type SubagentMatchMethod = 'result' | 'description' | 'positional';

/** A resolved subagent process linked to a parent session's Task tool call */
export interface UnifiedProcess {
  /** Unique identifier (e.g., "process-0") */
  id: string;
  /** The Task tool_use ID from the parent session */
  toolCallId: string;
  /** Task description from the parent's tool call input */
  description?: string;
  /** Subagent type from the parent's tool call input */
  subagentType?: string;
  /** Absolute path to the subagent JSONL file */
  filePath: string;
  /** Parsed subagent session */
  session: UnifiedSession;
  /** How this process was matched to the tool call */
  matchMethod: SubagentMatchMethod;
  /** Whether this process ran in parallel with another (100ms overlap) */
  isParallel: boolean;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

export function isTextContent(block: UnifiedContentBlock): block is TextContentBlock {
  return block.type === 'text';
}

export function isThinkingContent(block: UnifiedContentBlock): block is ThinkingContentBlock {
  return block.type === 'thinking';
}

export function isToolCallContent(block: UnifiedContentBlock): block is ToolCallContentBlock {
  return block.type === 'tool_call';
}

export function isToolResultContent(block: UnifiedContentBlock): block is ToolResultContentBlock {
  return block.type === 'tool_result';
}

export function isImageContent(block: UnifiedContentBlock): block is ImageContentBlock {
  return block.type === 'image';
}
