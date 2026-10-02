import { ASK_USER_QUESTION_TOOL } from '../../hooks/dtos/ask-user-question.dto';
import type {
  UnifiedChunk,
  UnifiedSemanticStep,
  UnifiedTurn,
} from '../../session-reader/dtos/unified-chunk.types';
import type { UnifiedMessage } from '../../session-reader/dtos/unified-message.types';
import type {
  TranscriptTailResponse,
  UnifiedChunkedResponse,
} from '../../session-reader/services/session-reader.service';

/**
 * Thinking text one AI chunk may carry to the phone, in characters across its steps.
 * Output text is never capped.
 */
export const MOBILE_THINKING_CAP_CHARS = 16_000;

/**
 * Mobile-only view of the transcript. The phone shows an AI chunk's output text, its tool
 * names and a thinking toggle, and detects a pending AskUserQuestion from tool steps, so an
 * AI chunk keeps just that. User, system and compact chunks keep their message text.
 * Web REST and socket.io payloads are not projected here.
 */
export function projectMobileChunk(chunk: UnifiedChunk): UnifiedChunk {
  if (chunk.type !== 'ai') return chunk;

  // `semanticSteps` and the deprecated `turns` each carry their own copy of the steps, so
  // each copy gets its own cap.
  const stepBudget = allocateThinking(chunk.semanticSteps);
  const turnBudget = allocateThinking(chunk.turns.flatMap((turn) => turn.steps));

  return {
    ...chunk,
    messages: chunk.messages.map(withoutMessageContent),
    semanticSteps: chunk.semanticSteps.map((step) => projectStep(step, stepBudget)),
    turns: chunk.turns.map((turn) => projectTurn(turn, turnBudget)),
  };
}

export function projectMobileChunksPage(page: UnifiedChunkedResponse): UnifiedChunkedResponse {
  return { ...page, chunks: page.chunks.map(projectMobileChunk) };
}

/** `deltaMessages` is empty: the phone applies `deltaChunks` and reads messages from chunks. */
export function projectMobileTail(
  tail: TranscriptTailResponse | null,
): TranscriptTailResponse | null {
  if (tail?.kind !== 'delta') return tail;
  return { ...tail, deltaChunks: tail.deltaChunks.map(projectMobileChunk), deltaMessages: [] };
}

function withoutMessageContent(message: UnifiedMessage): UnifiedMessage {
  return { ...message, content: [], toolCalls: [], toolResults: [] };
}

/**
 * Splits the thinking cap over the steps by id. The newest step is served first, so a trim
 * lands on the oldest thinking and the latest survives.
 */
function allocateThinking(steps: UnifiedSemanticStep[]): Map<string, number> {
  const allowed = new Map<string, number>();
  let remaining = MOBILE_THINKING_CAP_CHARS;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    const text = step.content.thinkingText;
    if (step.type !== 'thinking' || !text) continue;
    const take = Math.min(text.length, remaining);
    allowed.set(step.id, take);
    remaining -= take;
  }
  return allowed;
}

function projectTurn(turn: UnifiedTurn, thinkingBudget: Map<string, number>): UnifiedTurn {
  return { ...turn, steps: turn.steps.map((step) => projectStep(step, thinkingBudget)) };
}

function projectStep(
  step: UnifiedSemanticStep,
  thinkingBudget: Map<string, number>,
): UnifiedSemanticStep {
  const { content } = step;
  switch (step.type) {
    case 'output':
      return { ...step, content: { outputText: content.outputText } };
    case 'thinking': {
      const text = content.thinkingText ?? '';
      const take = thinkingBudget.get(step.id) ?? 0;
      if (take >= text.length) return { ...step, content: { thinkingText: content.thinkingText } };
      return { ...step, content: take > 0 ? { thinkingText: `${text.slice(0, take)}…` } : {} };
    }
    case 'tool_call':
      return {
        ...step,
        content: {
          toolName: content.toolName,
          toolCallId: content.toolCallId,
          ...(content.toolName === ASK_USER_QUESTION_TOOL && content.toolInput
            ? { toolInput: content.toolInput }
            : {}),
        },
      };
    case 'tool_result':
      return { ...step, content: { toolCallId: content.toolCallId, isError: content.isError } };
    case 'subagent':
      return {
        ...step,
        content: {
          subagentId: content.subagentId,
          subagentDescription: content.subagentDescription,
        },
      };
    case 'interruption':
      return { ...step, content: { interruptionText: content.interruptionText } };
    default:
      return step;
  }
}
