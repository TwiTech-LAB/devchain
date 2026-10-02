import { cooperativeBudget, cooperativeMap } from './cooperative-work';
import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk, UnifiedSemanticStep, UnifiedTurn } from '../dtos/unified-chunk.types';

type RpcTranscriptTailSource =
  | { kind: 'full-refetch-required' }
  | {
      kind: 'delta';
      deltaChunks: UnifiedChunk[];
      deltaMessages: UnifiedMessage[];
    };

export function serializeMessage(message: UnifiedMessage): Record<string, unknown> {
  const { lastEntryAtMs, ...wire } = message;
  return {
    ...wire,
    timestamp: message.timestamp.toISOString(),
  };
}

function serializeSemanticStep(step: UnifiedSemanticStep): Record<string, unknown> {
  return {
    ...step,
    startTime: step.startTime.toISOString(),
  };
}

function serializeTurn(turn: UnifiedTurn): Record<string, unknown> {
  return {
    ...turn,
    timestamp: turn.timestamp.toISOString(),
    steps: turn.steps.map(serializeSemanticStep),
  };
}

function aiSemanticSteps(chunk: UnifiedChunk): UnifiedSemanticStep[] | undefined {
  return chunk.type === 'ai' && 'semanticSteps' in chunk ? chunk.semanticSteps : undefined;
}

/** The REST and push chunk shape; callers choose how the message and step lists are mapped. */
function chunkWire(
  chunk: UnifiedChunk,
  messages: Record<string, unknown>[],
  semanticSteps: Record<string, unknown>[] | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: chunk.id,
    type: chunk.type,
    startTime: chunk.startTime.toISOString(),
    endTime: chunk.endTime.toISOString(),
    messages,
    metrics: chunk.metrics,
  };

  if (semanticSteps) {
    base.semanticSteps = semanticSteps;
  }

  return base;
}

export function serializeChunk(chunk: UnifiedChunk): Record<string, unknown> {
  return chunkWire(
    chunk,
    chunk.messages.map(serializeMessage),
    aiSemanticSteps(chunk)?.map(serializeSemanticStep),
  );
}

/**
 * RPC transcript results preserve the raw chunk's additive wire-compatible fields and the
 * deprecated turns consumed by older clients. REST and push continue using serializeChunk's
 * narrower projection.
 */
export function serializeRpcChunk(chunk: UnifiedChunk): Record<string, unknown> {
  const serialized = {
    ...chunk,
    ...serializeChunk(chunk),
  };

  if (chunk.type === 'ai') {
    return {
      ...serialized,
      turns: chunk.turns.map(serializeTurn),
    };
  }

  return serialized;
}

export function serializeRpcTranscriptChunks(response: {
  chunks: UnifiedChunk[];
}): Record<string, unknown> {
  return {
    ...response,
    chunks: response.chunks.map(serializeRpcChunk),
  };
}

export function serializeRpcTranscriptTail(
  response: RpcTranscriptTailSource | null,
): Record<string, unknown> | null {
  if (response === null) {
    return response;
  }
  if (response.kind === 'full-refetch-required') return { ...response };

  return {
    ...response,
    deltaChunks: response.deltaChunks.map(serializeRpcChunk),
    deltaMessages: response.deltaMessages.map(serializeMessage),
  };
}

export async function serializeChunksCooperatively(
  chunks: UnifiedChunk[],
): Promise<Record<string, unknown>[]> {
  const checkpoint = cooperativeBudget();
  const result: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    const messages = await cooperativeMap(chunk.messages, serializeMessage, checkpoint);
    const steps = aiSemanticSteps(chunk);
    const semanticSteps = steps && (await cooperativeMap(steps, serializeSemanticStep, checkpoint));
    result.push(chunkWire(chunk, messages, semanticSteps));
    const pause = checkpoint();
    if (pause) await pause;
  }
  return result;
}
