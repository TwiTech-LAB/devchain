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

export type SingleDisplayItem = {
  type: 'thinking' | 'tool' | 'output' | 'subagent';
  step: EnhancerStep;
  linkedResult?: EnhancerStep;
};

export type ToolGroupDisplayItem = {
  type: 'tool-group';
  toolName: string;
  count: number;
  items: SingleDisplayItem[];
  totalTokens: number;
  totalDurationMs: number;
  errorCount: number;
  commonPathPrefix?: string;
};

export type DisplayItem = SingleDisplayItem | ToolGroupDisplayItem;

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

function computeCommonPathPrefix(items: SingleDisplayItem[]): string | undefined {
  const paths = items
    .map((item) => {
      const filePath = item.step.content.toolInput?.file_path;
      return typeof filePath === 'string' ? filePath : undefined;
    })
    .filter((p): p is string => p !== undefined);

  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];

  const segments = paths.map((p) => p.split('/'));
  const minLen = Math.min(...segments.map((s) => s.length));
  const commonParts: string[] = [];

  for (let i = 0; i < minLen; i++) {
    const segment = segments[0][i];
    if (segments.every((s) => s[i] === segment)) {
      commonParts.push(segment);
    } else {
      break;
    }
  }

  if (commonParts.length === 0) return undefined;
  return commonParts.join('/');
}

function getItemDurationMs(item: SingleDisplayItem): number {
  if (item.linkedResult?.startTime && item.step.startTime) {
    const diff =
      new Date(item.linkedResult.startTime).getTime() - new Date(item.step.startTime).getTime();
    return Number.isFinite(diff) ? Math.max(0, diff) : (item.step.durationMs ?? 0);
  }
  return item.step.durationMs ?? 0;
}

function groupConsecutiveSameType(items: DisplayItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];

    if (item.type === 'tool' && item.step.type === 'tool_call' && item.step.content.toolName) {
      const toolName = item.step.content.toolName;
      const group: SingleDisplayItem[] = [item];
      let j = i + 1;
      while (j < items.length) {
        const next = items[j];
        if (
          next.type === 'tool' &&
          (next as SingleDisplayItem).step.type === 'tool_call' &&
          (next as SingleDisplayItem).step.content.toolName === toolName
        ) {
          group.push(next as SingleDisplayItem);
          j++;
        } else {
          break;
        }
      }

      if (group.length >= 2) {
        let totalTokens = 0;
        let totalDurationMs = 0;
        let errorCount = 0;

        for (const g of group) {
          totalTokens += (g.step.estimatedTokens ?? 0) + (g.linkedResult?.estimatedTokens ?? 0);
          totalDurationMs += getItemDurationMs(g);
          if (g.linkedResult?.content.isError) errorCount++;
        }

        result.push({
          type: 'tool-group',
          toolName,
          count: group.length,
          items: group,
          totalTokens,
          totalDurationMs,
          errorCount,
          commonPathPrefix: toolName === 'Read' ? computeCommonPathPrefix(group) : undefined,
        });

        i = j;
      } else {
        result.push(item);
        i++;
      }
    } else {
      result.push(item);
      i++;
    }
  }

  return result;
}

export function buildDisplayItems(
  steps: EnhancerStep[],
  lastOutputId: string | null,
): DisplayItem[] {
  const displayItems: SingleDisplayItem[] = [];
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

  return groupConsecutiveSameType(displayItems);
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
    if (item.type === 'tool-group') {
      counts.tool += item.count;
    } else {
      counts[item.type] += 1;
    }
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
