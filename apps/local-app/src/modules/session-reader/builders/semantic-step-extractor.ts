/**
 * Semantic Step Extractor
 *
 * Extracts logical semantic steps from AI chunk messages. Each step
 * represents a discrete unit of work: thinking, tool invocation,
 * tool result, text output, or subagent dispatch.
 *
 * Steps are extracted from content blocks in message order, then
 * tool results are matched to their corresponding tool calls.
 */

import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedSemanticStep, UnifiedSemanticStepType } from '../dtos/unified-chunk.types';
import { estimateStepTokens } from '../adapters/utils/estimate-content-tokens';
import { runSteps } from '../services/cooperative-work';

const INTERRUPTION_PATTERN = /\[Request interrupted by user\]/i;

/**
 * Extract semantic steps from an array of AI chunk messages.
 *
 * Assistant messages produce thinking, tool_call, output, and subagent steps, plus
 * tool_result steps for any FOLDED tool results (parsers fold a tool turn's results onto
 * the preceding assistant message — claude/codex/opencode/gemini). User messages within
 * the AI buffer also produce tool_result steps (the parser fallback when a tool_result has
 * no preceding assistant). Steps are returned in message order, results after their calls.
 */
export function extractSemanticSteps(messages: UnifiedMessage[]): UnifiedSemanticStep[] {
  return runSteps(extractSemanticStepWork(messages));
}

export function* extractSemanticStepWork(
  messages: UnifiedMessage[],
): Generator<void, UnifiedSemanticStep[]> {
  const steps: UnifiedSemanticStep[] = [];
  let stepIndex = 0;

  for (const msg of messages) {
    yield;
    if (msg.role === 'assistant') {
      yield* extractAssistantSteps(msg, steps, stepIndex);
      stepIndex = steps.length;
      // Folded tool results live on the assistant message's toolResults — emit them right
      // after the call steps so the result still renders within the turn.
      yield* extractToolResultSteps(msg, steps, stepIndex);
      stepIndex = steps.length;
    } else if (msg.role === 'user') {
      yield* extractToolResultSteps(msg, steps, stepIndex);
      stepIndex = steps.length;
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Assistant message step extraction
// ---------------------------------------------------------------------------

function* extractAssistantSteps(
  msg: UnifiedMessage,
  steps: UnifiedSemanticStep[],
  baseIndex: number,
): Generator<void> {
  let idx = baseIndex;

  for (const block of msg.content) {
    yield;
    switch (block.type) {
      case 'thinking': {
        steps.push(
          makeStep(`step-${idx++}`, 'thinking', msg, {
            thinkingText: block.thinking,
          }),
        );
        break;
      }

      case 'tool_call': {
        const isSubagent = msg.toolCalls.some((tc) => tc.id === block.toolCallId && tc.isTask);

        if (isSubagent) {
          const tc = msg.toolCalls.find((t) => t.id === block.toolCallId);
          steps.push(
            makeStep(`step-${idx++}`, 'subagent', msg, {
              toolName: block.toolName,
              toolCallId: block.toolCallId,
              toolInput: block.input,
              subagentDescription: tc?.taskDescription,
            }),
          );
        } else {
          steps.push(
            makeStep(`step-${idx++}`, 'tool_call', msg, {
              toolName: block.toolName,
              toolCallId: block.toolCallId,
              toolInput: block.input,
            }),
          );
        }
        break;
      }

      case 'text': {
        // Check for user interruption pattern
        if (INTERRUPTION_PATTERN.test(block.text)) {
          steps.push(
            makeStep(`step-${idx++}`, 'interruption', msg, {
              interruptionText: block.text,
            }),
          );
        } else if (block.text.trim()) {
          steps.push(
            makeStep(`step-${idx++}`, 'output', msg, {
              outputText: block.text,
              sourceModel: msg.model,
            }),
          );
        }
        break;
      }

      // tool_result and image blocks in assistant messages are not expected
      // but handled gracefully by skipping
    }
  }
}

// ---------------------------------------------------------------------------
// Tool result step extraction (from user messages within AI buffer)
// ---------------------------------------------------------------------------

function* extractToolResultSteps(
  msg: UnifiedMessage,
  steps: UnifiedSemanticStep[],
  baseIndex: number,
): Generator<void> {
  let idx = baseIndex;

  for (const result of msg.toolResults) {
    yield;
    steps.push(
      makeStep(`step-${idx++}`, 'tool_result', msg, {
        toolCallId: result.toolCallId,
        toolResultContent: result.content,
        isError: result.isError,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeStep(
  id: string,
  type: UnifiedSemanticStepType,
  msg: UnifiedMessage,
  content: UnifiedSemanticStep['content'],
): UnifiedSemanticStep {
  return {
    id,
    type,
    startTime: msg.timestamp,
    durationMs: 0, // Duration requires cross-message timing; computed at higher level
    content,
    tokens: msg.usage
      ? { input: msg.usage.input, output: msg.usage.output, cached: msg.usage.cacheRead }
      : undefined,
    estimatedTokens: estimateStepTokens(type, content),
    sourceMessageId: msg.id,
    context: msg.isSidechain ? 'subagent' : 'main',
  };
}
