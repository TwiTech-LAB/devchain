import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { TurnSummary, UnifiedSemanticStep, UnifiedTurn } from '../dtos/unified-chunk.types';

function makeEmptySummary(): TurnSummary {
  return {
    thinkingCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
    outputCount: 0,
  };
}

function applySummaryStep(summary: TurnSummary, step: UnifiedSemanticStep): void {
  switch (step.type) {
    case 'thinking':
      summary.thinkingCount += 1;
      break;
    case 'tool_call':
      summary.toolCallCount += 1;
      break;
    case 'subagent':
      summary.subagentCount += 1;
      break;
    case 'output':
      summary.outputCount += 1;
      break;
  }
}

function addStepTokens(
  turn: UnifiedTurn,
  step: UnifiedSemanticStep,
  seenSourceIds: Set<string>,
): void {
  if (!step.tokens) return;

  const tokenKey = step.sourceMessageId ?? `step:${step.id}`;
  if (seenSourceIds.has(tokenKey)) return;
  seenSourceIds.add(tokenKey);

  if (!turn.tokens) {
    turn.tokens = { input: 0, output: 0, cached: 0 };
  }

  turn.tokens.input += step.tokens.input;
  turn.tokens.output += step.tokens.output;
  turn.tokens.cached = (turn.tokens.cached ?? 0) + (step.tokens.cached ?? 0);
}

/**
 * Group semantic steps into provider-agnostic API turns.
 *
 * Strategy:
 * - Each assistant message starts one turn (stable id: turn-{assistantMessageId})
 * - Assistant-owned steps map by sourceMessageId -> turn
 * - tool_result steps map by toolCallId -> turn (from tool_call/subagent steps)
 *
 * @deprecated Use AIGroupCard with semanticSteps instead. Will be removed in cleanup epic.
 */
export function buildTurns(
  steps: UnifiedSemanticStep[],
  messages: UnifiedMessage[],
): UnifiedTurn[] {
  const assistantMessages = messages.filter((msg) => msg.role === 'assistant');
  if (assistantMessages.length === 0) return [];

  const turns: UnifiedTurn[] = assistantMessages.map((msg) => ({
    id: `turn-${msg.id}`,
    assistantMessageId: msg.id,
    model: msg.model,
    timestamp: msg.timestamp,
    steps: [],
    summary: makeEmptySummary(),
    durationMs: 0,
  }));

  const sourceMessageToTurnIndex = new Map<string, number>();
  for (let i = 0; i < assistantMessages.length; i += 1) {
    sourceMessageToTurnIndex.set(assistantMessages[i].id, i);
  }

  const toolCallToTurnIndex = new Map<string, number>();
  for (const step of steps) {
    if (step.type !== 'tool_call' && step.type !== 'subagent') continue;
    if (!step.content.toolCallId || !step.sourceMessageId) continue;
    const turnIndex = sourceMessageToTurnIndex.get(step.sourceMessageId);
    if (turnIndex === undefined) continue;
    toolCallToTurnIndex.set(step.content.toolCallId, turnIndex);
  }

  const tokenSourceByTurn = turns.map(() => new Set<string>());
  for (const step of steps) {
    let turnIndex: number | undefined;

    if (step.type === 'tool_result' && step.content.toolCallId) {
      turnIndex = toolCallToTurnIndex.get(step.content.toolCallId);
    }

    if (turnIndex === undefined && step.sourceMessageId) {
      turnIndex = sourceMessageToTurnIndex.get(step.sourceMessageId);
    }

    if (turnIndex === undefined) {
      turnIndex = turns.length - 1;
    }

    const turn = turns[turnIndex];
    turn.steps.push(step);
    applySummaryStep(turn.summary, step);
    addStepTokens(turn, step, tokenSourceByTurn[turnIndex]);
  }

  const chunkEndTime =
    messages[messages.length - 1]?.timestamp ??
    assistantMessages[assistantMessages.length - 1].timestamp;
  for (let i = 0; i < turns.length; i += 1) {
    const nextTurnStart = i < turns.length - 1 ? turns[i + 1].timestamp : chunkEndTime;
    turns[i].durationMs = Math.max(0, nextTurnStart.getTime() - turns[i].timestamp.getTime());

    const turnTokens = turns[i].tokens;
    if (turnTokens && turnTokens.cached === 0) {
      turns[i].tokens = {
        input: turnTokens.input,
        output: turnTokens.output,
      };
    }
  }

  return turns;
}
