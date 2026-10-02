import {
  serializeChunk,
  serializeChunksCooperatively,
  serializeMessage,
  serializeRpcChunk,
  serializeRpcTranscriptChunks,
  serializeRpcTranscriptTail,
} from './transcript-serialization';
import type { TranscriptTailDeltaResponse, UnifiedChunkedResponse } from './session-reader.service';
import type { UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';

function makeMessage(id: string): UnifiedMessage {
  return {
    id,
    parentId: null,
    role: 'user',
    timestamp: new Date('2026-01-01T10:00:00.000Z'),
    content: [{ type: 'text', text: 'hello' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
  } as unknown as UnifiedMessage;
}

function makeAIChunk(messages: UnifiedMessage[]): UnifiedChunk {
  return {
    id: 'chunk-0',
    type: 'ai',
    startTime: new Date('2026-01-01T10:00:00.000Z'),
    endTime: new Date('2026-01-01T10:00:05.000Z'),
    messages,
    metrics: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 300,
      messageCount: messages.length,
      durationMs: 5000,
      costUsd: 0.01,
    },
    semanticSteps: [
      {
        id: 'step-1',
        type: 'output',
        startTime: new Date('2026-01-01T10:00:01.000Z'),
        durationMs: 100,
        content: { outputText: 'hello' },
        context: 'main',
      },
    ],
    turns: [
      {
        id: 'turn-1',
        assistantMessageId: 'msg-1',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        steps: [
          {
            id: 'turn-step-1',
            type: 'thinking',
            startTime: new Date('2026-01-01T10:00:02.000Z'),
            durationMs: 50,
            content: { thinkingText: 'considering' },
            context: 'main',
            additiveStepField: 'kept',
          },
        ],
        summary: { thinkingCount: 0, toolCallCount: 0, subagentCount: 0, outputCount: 1 },
        durationMs: 100,
        additiveTurnField: 'kept',
      },
    ],
    additiveChunkField: 'kept',
  } as unknown as UnifiedChunk;
}

describe('transcript-serialization', () => {
  describe('serializeMessage', () => {
    it('converts timestamp to ISO string', () => {
      const msg = makeMessage('m1');
      const serialized = serializeMessage(msg);
      expect(serialized.timestamp).toBe('2026-01-01T10:00:00.000Z');
      expect(typeof serialized.timestamp).toBe('string');
    });
  });

  describe('serializeChunk', () => {
    it('converts date fields to ISO strings', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const serialized = serializeChunk(chunk);
      expect(serialized.startTime).toBe('2026-01-01T10:00:00.000Z');
      expect(serialized.endTime).toBe('2026-01-01T10:00:05.000Z');
    });

    it('does NOT include turns (T1.3 contract)', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const serialized = serializeChunk(chunk);
      expect(serialized).not.toHaveProperty('turns');
    });

    it('includes semanticSteps for AI chunks with serialized dates', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const serialized = serializeChunk(chunk);
      expect(serialized.semanticSteps).toBeDefined();
      const steps = serialized.semanticSteps as Array<{ startTime: string }>;
      expect(steps[0].startTime).toBe('2026-01-01T10:00:01.000Z');
    });

    it('does not include semanticSteps for non-AI chunks', () => {
      const chunk: UnifiedChunk = {
        id: 'chunk-0',
        type: 'user',
        startTime: new Date('2026-01-01T10:00:00.000Z'),
        endTime: new Date('2026-01-01T10:00:00.000Z'),
        messages: [makeMessage('m1')],
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          messageCount: 1,
          durationMs: 0,
          costUsd: 0,
        },
      } as UnifiedChunk;
      const serialized = serializeChunk(chunk);
      expect(serialized).not.toHaveProperty('semanticSteps');
      expect(serialized).not.toHaveProperty('turns');
    });

    it('includes id, type, and metrics', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const serialized = serializeChunk(chunk);
      expect(serialized.id).toBe('chunk-0');
      expect(serialized.type).toBe('ai');
      expect(serialized.metrics).toBeDefined();
    });

    it('serializes nested message timestamps', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const serialized = serializeChunk(chunk);
      const messages = serialized.messages as Array<{ timestamp: string }>;
      expect(messages[0].timestamp).toBe('2026-01-01T10:00:00.000Z');
    });
  });

  describe('RPC transcript projection', () => {
    it('preserves additive chunk fields and deprecated turns while serializing all known dates', () => {
      const serialized = serializeRpcChunk(makeAIChunk([makeMessage('m1')]));
      const turns = serialized.turns as Array<{
        timestamp: string;
        additiveTurnField: string;
        steps: Array<{ startTime: string; additiveStepField: string }>;
      }>;

      expect(serialized.additiveChunkField).toBe('kept');
      expect(turns[0]).toMatchObject({
        timestamp: '2026-01-01T10:00:00.000Z',
        additiveTurnField: 'kept',
      });
      expect(turns[0].steps[0]).toMatchObject({
        startTime: '2026-01-01T10:00:02.000Z',
        additiveStepField: 'kept',
      });
    });

    it('projects chunks and delta-tail messages without changing their response envelopes', () => {
      const chunk = makeAIChunk([makeMessage('m1')]);
      const chunksPage: UnifiedChunkedResponse = {
        chunks: [chunk],
        nextCursor: null,
        prevCursor: null,
        totalCount: 1,
      };
      const chunks = serializeRpcTranscriptChunks(chunksPage);
      const tailResponse: TranscriptTailDeltaResponse = {
        kind: 'delta',
        cursor: 'cursor-2',
        replaceFromChunkId: chunk.id,
        replaceFromChunkIndex: 0,
        deltaChunks: [chunk],
        deltaMessages: [makeMessage('m2')],
        metrics: {} as never,
        totalChunkCount: 1,
        totalMessageCount: 2,
      };
      const tail = serializeRpcTranscriptTail(tailResponse);

      expect((chunks.chunks as Array<{ startTime: string }>)[0].startTime).toBe(
        '2026-01-01T10:00:00.000Z',
      );
      expect((tail?.deltaMessages as Array<{ timestamp: string }>)[0].timestamp).toBe(
        '2026-01-01T10:00:00.000Z',
      );
      expect(tail).toMatchObject({
        kind: 'delta',
        cursor: 'cursor-2',
        replaceFromChunkId: 'chunk-0',
        totalChunkCount: 1,
      });
    });
  });
});

// Wire projection parity belongs at the pure serializer boundary, including legacy field omissions.
it('cooperative REST chunk projection exactly matches the synchronous wire projection', async () => {
  const chunks = [makeAIChunk([makeMessage('one'), makeMessage('two')])];
  expect(await serializeChunksCooperatively(chunks)).toEqual(chunks.map(serializeChunk));
});
