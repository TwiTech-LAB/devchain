import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk, UnifiedSemanticStep } from '../dtos/unified-chunk.types';

export function serializeMessage(message: UnifiedMessage): Record<string, unknown> {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

function serializeSemanticStep(step: UnifiedSemanticStep): Record<string, unknown> {
  return {
    ...step,
    startTime: step.startTime.toISOString(),
  };
}

export function serializeChunk(chunk: UnifiedChunk): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: chunk.id,
    type: chunk.type,
    startTime: chunk.startTime.toISOString(),
    endTime: chunk.endTime.toISOString(),
    messages: chunk.messages.map(serializeMessage),
    metrics: chunk.metrics,
  };

  if (chunk.type === 'ai' && 'semanticSteps' in chunk) {
    base.semanticSteps = chunk.semanticSteps.map(serializeSemanticStep);
  }

  return base;
}
