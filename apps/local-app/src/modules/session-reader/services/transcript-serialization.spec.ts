import { serializeChunk, serializeMessage } from './transcript-serialization';
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
        steps: [],
        summary: { thinkingCount: 0, toolCallCount: 0, subagentCount: 0, outputCount: 1 },
        durationMs: 100,
      },
    ],
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
});
