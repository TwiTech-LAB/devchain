import type { UnifiedSemanticStep } from '@/modules/session-reader/dtos/unified-chunk.types';

export interface LastOutput {
  type: 'text' | 'tool_result';
  text: string;
  timestamp: Date;
  stepId: string;
}

export type EnhancerStep = Omit<UnifiedSemanticStep, 'startTime'> & {
  startTime: Date | string;
};

export type DisplayItem = {
  type: 'thinking' | 'tool' | 'output' | 'subagent';
  step: EnhancerStep;
  linkedResult?: EnhancerStep;
};

export interface HeaderTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface AIGroupDisplay {
  lastOutput: LastOutput | null;
  displayItems: DisplayItem[];
  summary: string;
  headerTokens: HeaderTokens | null;
  model: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function normalizeToolResultContent(content: string | unknown[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!content) {
    return '';
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isNonEmptyOutput(step: EnhancerStep): boolean {
  return step.type === 'output' && !!step.content.outputText?.trim();
}

function isNonEmptyToolResult(step: EnhancerStep): boolean {
  if (step.type !== 'tool_result') return false;
  return normalizeToolResultContent(step.content.toolResultContent).trim().length > 0;
}

export function findLastOutput(steps: EnhancerStep[]): LastOutput | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!isNonEmptyOutput(step)) continue;
    return {
      type: 'text',
      text: step.content.outputText ?? '',
      timestamp: toDate(step.startTime),
      stepId: step.id,
    };
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!isNonEmptyToolResult(step)) continue;
    return {
      type: 'tool_result',
      text: normalizeToolResultContent(step.content.toolResultContent),
      timestamp: toDate(step.startTime),
      stepId: step.id,
    };
  }

  return null;
}

export function buildDisplayItems(
  steps: EnhancerStep[],
  lastOutputId: string | null,
): DisplayItem[] {
  const displayItems: DisplayItem[] = [];
  const pendingToolCallIndexes = new Map<string, number[]>();

  for (const step of steps) {
    if (lastOutputId && step.id === lastOutputId) {
      continue;
    }

    switch (step.type) {
      case 'thinking':
        if (step.content.thinkingText?.trim()) {
          displayItems.push({ type: 'thinking', step });
        }
        break;

      case 'output':
        if (step.content.outputText?.trim()) {
          displayItems.push({ type: 'output', step });
        }
        break;

      case 'subagent':
        displayItems.push({ type: 'subagent', step });
        break;

      case 'tool_call': {
        const itemIndex = displayItems.length;
        displayItems.push({ type: 'tool', step });
        const toolCallId = step.content.toolCallId;
        if (!toolCallId) break;
        const queue = pendingToolCallIndexes.get(toolCallId) ?? [];
        queue.push(itemIndex);
        pendingToolCallIndexes.set(toolCallId, queue);
        break;
      }

      case 'tool_result': {
        const toolCallId = step.content.toolCallId;
        const queue = toolCallId ? pendingToolCallIndexes.get(toolCallId) : undefined;
        const toolItemIndex = queue?.shift();
        if (toolItemIndex !== undefined) {
          displayItems[toolItemIndex] = {
            ...displayItems[toolItemIndex],
            linkedResult: step,
          };
        } else {
          displayItems.push({ type: 'tool', step });
        }
        break;
      }
    }
  }

  return displayItems;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildSummary(displayItems: DisplayItem[]): string {
  const counts = {
    thinking: 0,
    tool: 0,
    output: 0,
    subagent: 0,
  };

  for (const item of displayItems) {
    counts[item.type] += 1;
  }

  const parts: string[] = [];
  if (counts.thinking > 0) {
    parts.push(`${counts.thinking} thinking`);
  }
  if (counts.tool > 0) {
    parts.push(pluralize(counts.tool, 'tool call', 'tool calls'));
  }
  if (counts.output > 0) {
    parts.push(pluralize(counts.output, 'message', 'messages'));
  }
  if (counts.subagent > 0) {
    parts.push(pluralize(counts.subagent, 'subagent', 'subagents'));
  }

  return parts.length > 0 ? parts.join(', ') : 'No items';
}

type HeaderTokenMessage = {
  role: 'user' | 'assistant' | 'system';
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
};

export type HeaderTokenChunk = {
  messages: HeaderTokenMessage[];
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
};

export function getHeaderTokens(chunk: HeaderTokenChunk): HeaderTokens | null {
  for (let index = chunk.messages.length - 1; index >= 0; index -= 1) {
    const message = chunk.messages[index];
    if (message.role !== 'assistant' || !message.usage) continue;
    return {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheCreation: message.usage.cacheCreation,
    };
  }

  if (!chunk.metrics) {
    return null;
  }

  return {
    input: chunk.metrics.inputTokens,
    output: chunk.metrics.outputTokens,
    cacheRead: chunk.metrics.cacheReadTokens,
    cacheCreation: chunk.metrics.cacheCreationTokens,
  };
}

export function getHeaderInputTotal(chunk: HeaderTokenChunk): number | null {
  const tokens = getHeaderTokens(chunk);
  if (!tokens) return null;
  return tokens.input + tokens.cacheRead + tokens.cacheCreation;
}
