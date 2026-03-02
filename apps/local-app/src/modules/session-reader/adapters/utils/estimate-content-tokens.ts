import type { UnifiedContentBlock, UnifiedMessage } from '../../dtos/unified-session.types';

/**
 * Rough token estimate heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Estimate token count from a message's content blocks.
 */
export function estimateMessageTokens(content: UnifiedContentBlock[]): number {
  let total = 0;

  for (const block of content) {
    switch (block.type) {
      case 'text':
        total += estimateTokens(block.text);
        break;
      case 'thinking':
        total += estimateTokens(block.thinking);
        break;
      case 'tool_result':
        total += estimateTokens(
          typeof block.content === 'string' ? block.content : stringifySafe(block.content),
        );
        break;
      case 'tool_call':
        total += estimateTokens(stringifySafe(block.input));
        break;
      case 'image':
        // Base64 data does not represent model context text directly.
        break;
      default:
        break;
    }
  }

  return total;
}

export interface StepTokenEstimateContent {
  thinkingText?: string;
  toolInput?: Record<string, unknown>;
  toolResultContent?: string | unknown[];
  outputText?: string;
}

export function estimateStepTokens(type: string, content: StepTokenEstimateContent): number {
  switch (type) {
    case 'thinking':
      return estimateTokens(content.thinkingText ?? '');
    case 'tool_call':
      return content.toolInput === undefined ? 0 : estimateTokens(stringifySafe(content.toolInput));
    case 'tool_result':
      if (content.toolResultContent === undefined) return 0;
      return estimateTokens(
        typeof content.toolResultContent === 'string'
          ? content.toolResultContent
          : stringifySafe(content.toolResultContent),
      );
    case 'output':
      return estimateTokens(content.outputText ?? '');
    default:
      return 0;
  }
}

/**
 * Estimate visible context tokens from messages after the most recent compaction
 * boundary, excluding sidechain messages.
 */
export function estimateVisibleFromMessages(messages: UnifiedMessage[]): number {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isCompactSummary) {
      startIndex = i + 1;
      break;
    }
  }

  let total = 0;
  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i];
    if (message.isSidechain) continue;
    total += estimateMessageTokens(message.content);
  }

  return total;
}
