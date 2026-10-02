export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

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

export type UnifiedContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock
  | ImageContentBlock;

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
  sourceToolUseId?: string;
  /**
   * Provider turn-completion signal for the LAST API response folded into this assistant
   * message (Claude `message.stop_reason`: `'end_turn'` = completed turn, `'tool_use'`/`null`
   * = paused awaiting a tool result / continuation). Set by the Claude parser; left undefined
   * by providers whose turn boundaries are event-driven (Codex `turn_complete`).
   *
   * Used by the incremental cache-boundary continuation fold (`session-cache.service.ts`) to
   * apply the over-merge guard: a continuation assistant arriving in a later slice must NOT
   * fold onto a cached tail that already `end_turn`-ed (that is a new turn, not a continuation).
   */
  stopReason?: string | null;
  /**
   * Epoch ms of the last assistant entry folded into this message; absent when nothing was
   * folded (`timestamp` is then that entry's time). `timestamp` stays the FIRST entry's time,
   * so turn-end evidence must read this to date a folded turn by its closing entry.
   * Internal: not sent on the wire.
   */
  lastEntryAtMs?: number;
}
