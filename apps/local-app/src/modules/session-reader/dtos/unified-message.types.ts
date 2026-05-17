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
}
