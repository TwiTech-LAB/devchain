import type { UnifiedMessage, UnifiedToolResult } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';

export const DEFAULT_MAX_TOOL_RESULT_LENGTH = 2_000;

export function truncateToolResult(
  result: UnifiedToolResult,
  maxLength: number,
): UnifiedToolResult {
  if (typeof result.content !== 'string') return result;
  const fullLength = result.content.length;
  if (fullLength <= maxLength) return result;
  return {
    ...result,
    content: result.content.slice(0, maxLength) + '…',
    isTruncated: true,
    fullLength,
  };
}

function truncateMessage(message: UnifiedMessage, maxLength: number): UnifiedMessage {
  let anyTruncated = false;
  const truncatedToolResults = message.toolResults.map((result) => {
    const t = truncateToolResult(result, maxLength);
    if (t !== result) anyTruncated = true;
    return t;
  });

  if (!anyTruncated) return message;

  const truncatedById = new Map(
    truncatedToolResults.filter((r) => r.isTruncated).map((r) => [r.toolCallId, r]),
  );

  const content = message.content.map((block) => {
    if (block.type !== 'tool_result') return block;
    const truncated = truncatedById.get(block.toolCallId);
    if (!truncated) return block;
    return {
      ...block,
      content: truncated.content,
      isTruncated: truncated.isTruncated,
      fullLength: truncated.fullLength,
    };
  });

  return { ...message, content, toolResults: truncatedToolResults };
}

export function truncateMessages(
  messages: UnifiedMessage[],
  maxLength: number = DEFAULT_MAX_TOOL_RESULT_LENGTH,
): UnifiedMessage[] {
  let anyChanged = false;
  const result = messages.map((message) => {
    const t = truncateMessage(message, maxLength);
    if (t !== message) anyChanged = true;
    return t;
  });
  return anyChanged ? result : messages;
}

function truncateChunk(
  chunk: UnifiedChunk,
  maxLength: number,
  extMap?: Map<string, UnifiedMessage>,
): UnifiedChunk {
  let messagesChanged = false;
  const newMessages = chunk.messages.map((m) => {
    const fromExt = extMap?.get(m.id);
    if (fromExt && fromExt !== m) {
      messagesChanged = true;
      return fromExt;
    }
    const t = truncateMessage(m, maxLength);
    if (t !== m) {
      messagesChanged = true;
      return t;
    }
    return m;
  });

  if (chunk.type !== 'ai' || !('semanticSteps' in chunk) || !chunk.semanticSteps) {
    if (!messagesChanged) return chunk;
    return { ...chunk, messages: newMessages };
  }

  const truncatedById = new Map<string, UnifiedToolResult>();
  for (const msg of newMessages) {
    for (const tr of msg.toolResults) {
      if (tr.isTruncated) truncatedById.set(tr.toolCallId, tr);
    }
  }

  let stepsChanged = false;
  const semanticSteps = chunk.semanticSteps.map((step) => {
    if (step.type !== 'tool_result' || !step.content.toolCallId) return step;

    const fromMap = truncatedById.get(step.content.toolCallId);
    if (fromMap) {
      stepsChanged = true;
      return {
        ...step,
        content: {
          ...step.content,
          toolResultContent: fromMap.content,
          isTruncated: true,
          fullLength: fromMap.fullLength,
        },
      };
    }

    if (
      typeof step.content.toolResultContent === 'string' &&
      step.content.toolResultContent.length > maxLength
    ) {
      stepsChanged = true;
      const fullLen = step.content.toolResultContent.length;
      return {
        ...step,
        content: {
          ...step.content,
          toolResultContent: step.content.toolResultContent.slice(0, maxLength) + '…',
          isTruncated: true,
          fullLength: fullLen,
        },
      };
    }

    return step;
  });

  if (!messagesChanged && !stepsChanged) return chunk;

  const turns = stepsChanged
    ? chunk.turns.map((turn) => {
        let turnChanged = false;
        const newSteps = turn.steps.map((step) => {
          if (step.type !== 'tool_result' || !step.content.toolCallId) return step;
          const fromMap = truncatedById.get(step.content.toolCallId);
          if (fromMap) {
            turnChanged = true;
            return {
              ...step,
              content: {
                ...step.content,
                toolResultContent: fromMap.content,
                isTruncated: true,
                fullLength: fromMap.fullLength,
              },
            };
          }
          if (
            typeof step.content.toolResultContent === 'string' &&
            step.content.toolResultContent.length > maxLength
          ) {
            turnChanged = true;
            const fullLen = step.content.toolResultContent.length;
            return {
              ...step,
              content: {
                ...step.content,
                toolResultContent: step.content.toolResultContent.slice(0, maxLength) + '…',
                isTruncated: true,
                fullLength: fullLen,
              },
            };
          }
          return step;
        });
        return turnChanged ? { ...turn, steps: newSteps } : turn;
      })
    : chunk.turns;

  return {
    ...chunk,
    messages: messagesChanged ? newMessages : chunk.messages,
    semanticSteps,
    turns,
  };
}

export function truncateChunks(
  chunks: UnifiedChunk[],
  maxLength: number = DEFAULT_MAX_TOOL_RESULT_LENGTH,
  externalMessages?: UnifiedMessage[],
): UnifiedChunk[] {
  const extMap = externalMessages ? new Map(externalMessages.map((m) => [m.id, m])) : undefined;

  let anyChanged = false;
  const result = chunks.map((chunk) => {
    const t = truncateChunk(chunk, maxLength, extMap);
    if (t !== chunk) anyChanged = true;
    return t;
  });

  return anyChanged ? result : chunks;
}
