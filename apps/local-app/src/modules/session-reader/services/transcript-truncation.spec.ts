import {
  DEFAULT_MAX_TOOL_RESULT_LENGTH,
  truncateToolResult,
  truncateMessages,
  truncateChunks,
} from './transcript-truncation';
import type { UnifiedMessage, UnifiedToolResult } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';

function makeToolResult(content: string, toolCallId = 'tc-1'): UnifiedToolResult {
  return {
    toolCallId,
    content,
    isError: false,
    isTruncated: false,
    fullLength: content.length,
  };
}

function makeMessage(id: string, toolResults: UnifiedToolResult[] = []): UnifiedMessage {
  return {
    id,
    parentId: null,
    role: 'assistant',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    content: toolResults.map((tr) => ({
      type: 'tool_result' as const,
      toolCallId: tr.toolCallId,
      content: tr.content,
      isTruncated: tr.isTruncated,
      fullLength: tr.fullLength,
    })),
    toolCalls: [],
    toolResults,
    isMeta: false,
    isSidechain: false,
  } as unknown as UnifiedMessage;
}

function makeAIChunk(
  id: string,
  messages: UnifiedMessage[],
  semanticSteps: Array<{
    id: string;
    type: string;
    content: Record<string, unknown>;
  }> = [],
): UnifiedChunk {
  return {
    id,
    type: 'ai',
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-01-01T00:00:01Z'),
    messages,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      messageCount: messages.length,
      durationMs: 1000,
      costUsd: 0,
    },
    semanticSteps: semanticSteps.map((s) => ({
      ...s,
      startTime: new Date('2026-01-01T00:00:00Z'),
      durationMs: 100,
      context: 'main' as const,
    })),
    turns: [],
  } as unknown as UnifiedChunk;
}

function makeUserChunk(id: string, messages: UnifiedMessage[]): UnifiedChunk {
  return {
    id,
    type: 'user',
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-01-01T00:00:01Z'),
    messages,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      messageCount: messages.length,
      durationMs: 0,
      costUsd: 0,
    },
  } as UnifiedChunk;
}

const OVERSIZED = 'x'.repeat(5000);

describe('transcript-truncation', () => {
  describe('DEFAULT_MAX_TOOL_RESULT_LENGTH', () => {
    it('is 2000', () => {
      expect(DEFAULT_MAX_TOOL_RESULT_LENGTH).toBe(2000);
    });
  });

  describe('truncateToolResult', () => {
    it('returns the same object when content is within limit', () => {
      const result = makeToolResult('short content');
      expect(truncateToolResult(result, 2000)).toBe(result);
    });

    it('truncates content exceeding limit and sets markers', () => {
      const result = makeToolResult(OVERSIZED);
      const truncated = truncateToolResult(result, 2000);
      expect(truncated.content).toHaveLength(2001);
      expect((truncated.content as string).endsWith('…')).toBe(true);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.fullLength).toBe(5000);
    });

    it('returns the same object for non-string content', () => {
      const result: UnifiedToolResult = {
        toolCallId: 'tc-1',
        content: [{ type: 'image', data: 'base64...' }] as unknown[],
        isError: false,
        isTruncated: false,
        fullLength: 0,
      };
      expect(truncateToolResult(result, 2000)).toBe(result);
    });
  });

  describe('truncateMessages', () => {
    it('returns the same array reference when no tool results exceed limit', () => {
      const messages = [makeMessage('m1', [makeToolResult('short')])];
      expect(truncateMessages(messages)).toBe(messages);
    });

    it('truncates messages with oversized tool results', () => {
      const messages = [makeMessage('m1', [makeToolResult(OVERSIZED)])];
      const truncated = truncateMessages(messages, 2000);
      expect(truncated).not.toBe(messages);
      expect(truncated[0].toolResults[0].isTruncated).toBe(true);
      expect(truncated[0].toolResults[0].fullLength).toBe(5000);
      expect((truncated[0].toolResults[0].content as string).length).toBeLessThanOrEqual(2001);
    });

    it('preserves isTruncated/fullLength in content blocks', () => {
      const messages = [makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-1')])];
      const truncated = truncateMessages(messages, 2000);
      const toolBlock = truncated[0].content.find(
        (b: { type: string }) => b.type === 'tool_result',
      ) as { isTruncated: boolean; fullLength: number };
      expect(toolBlock.isTruncated).toBe(true);
      expect(toolBlock.fullLength).toBe(5000);
    });

    it('preserves message reference when that message has no oversized content', () => {
      const shortMsg = makeMessage('m1', [makeToolResult('short')]);
      const longMsg = makeMessage('m2', [makeToolResult(OVERSIZED)]);
      const messages = [shortMsg, longMsg];
      const truncated = truncateMessages(messages, 2000);
      expect(truncated[0]).toBe(shortMsg);
      expect(truncated[1]).not.toBe(longMsg);
    });
  });

  describe('truncateChunks', () => {
    it('returns the same array reference when no truncation needed', () => {
      const msg = makeMessage('m1', [makeToolResult('short')]);
      const chunks = [makeAIChunk('c-0', [msg])];
      expect(truncateChunks(chunks)).toBe(chunks);
    });

    it('returns the same chunk reference when that chunk needs no truncation', () => {
      const shortChunk = makeUserChunk('c-0', [makeMessage('m1', [makeToolResult('short')])]);
      const longChunk = makeUserChunk('c-1', [makeMessage('m2', [makeToolResult(OVERSIZED)])]);
      const chunks = [shortChunk, longChunk];
      const truncated = truncateChunks(chunks, 2000);
      expect(truncated[0]).toBe(shortChunk);
      expect(truncated[1]).not.toBe(longChunk);
    });

    it('truncates chunk.messages without external map (self-sufficient)', () => {
      const msg = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-1')]);
      const chunks = [makeUserChunk('c-0', [msg])];
      const truncated = truncateChunks(chunks, 2000);
      expect(truncated).not.toBe(chunks);
      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
      expect(
        (truncated[0].messages[0].toolResults[0].content as string).length,
      ).toBeLessThanOrEqual(2001);
    });

    it('truncates AI chunk semantic step content', () => {
      const msg = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-1')]);
      const chunks = [
        makeAIChunk(
          'c-0',
          [msg],
          [
            {
              id: 'step-1',
              type: 'tool_result',
              content: { toolCallId: 'tc-1', toolResultContent: OVERSIZED },
            },
          ],
        ),
      ];
      const truncated = truncateChunks(chunks, 2000);
      const step = (
        truncated[0] as {
          semanticSteps: Array<{
            content: { toolResultContent: string; isTruncated: boolean; fullLength: number };
          }>;
        }
      ).semanticSteps[0];
      expect(step.content.isTruncated).toBe(true);
      expect(step.content.fullLength).toBe(5000);
      expect(step.content.toolResultContent.length).toBeLessThanOrEqual(2001);
    });

    it('uses external message map when provided', () => {
      const msg = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-1')]);
      const truncatedMsgs = truncateMessages([msg], 2000);
      const chunks = [makeAIChunk('c-0', [msg])];
      const truncated = truncateChunks(chunks, 2000, truncatedMsgs);
      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
    });

    it('falls back to self-truncation for messages not in external map', () => {
      const msg1 = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-1')]);
      const msg2 = makeMessage('m2', [makeToolResult(OVERSIZED, 'tc-2')]);
      const externalMsgs = truncateMessages([msg1], 2000);
      const chunks = [makeUserChunk('c-0', [msg1, msg2])];
      const truncated = truncateChunks(chunks, 2000, externalMsgs);
      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
      expect(truncated[0].messages[1].toolResults[0].isTruncated).toBe(true);
    });
  });

  describe('payload-size regression', () => {
    it('truncateMessages bounds tool result to ≤ maxLen + 1 char', () => {
      const messages = [makeMessage('m1', [makeToolResult(OVERSIZED)])];
      const truncated = truncateMessages(messages, 2000);
      const content = truncated[0].toolResults[0].content as string;
      expect(content.length).toBeLessThanOrEqual(2001);
      expect(truncated[0].toolResults[0].isTruncated).toBe(true);
      expect(truncated[0].toolResults[0].fullLength).toBe(5000);
    });

    it('truncateChunks bounds chunk.messages without external map', () => {
      const msg = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-big')]);
      const chunks = [makeUserChunk('c-0', [msg])];
      const truncated = truncateChunks(chunks, 2000);
      const content = truncated[0].messages[0].toolResults[0].content as string;
      expect(content.length).toBeLessThanOrEqual(2001);
      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
    });

    it('truncateChunks bounds semantic step content', () => {
      const msg = makeMessage('m1', [makeToolResult(OVERSIZED, 'tc-big')]);
      const chunks = [
        makeAIChunk(
          'c-0',
          [msg],
          [
            {
              id: 'step-big',
              type: 'tool_result',
              content: { toolCallId: 'tc-big', toolResultContent: OVERSIZED },
            },
          ],
        ),
      ];
      const truncated = truncateChunks(chunks, 2000);
      const step = (
        truncated[0] as {
          semanticSteps: Array<{
            content: { toolResultContent: string; isTruncated: boolean; fullLength: number };
          }>;
        }
      ).semanticSteps[0];
      expect(step.content.toolResultContent.length).toBeLessThanOrEqual(2001);
      expect(step.content.isTruncated).toBe(true);
      expect(step.content.fullLength).toBe(5000);
    });
  });

  describe('overlap-chunk bounding (R2)', () => {
    it('bounds older pre-cursor messages inside overlap chunk without external map', () => {
      const olderMsg = makeMessage('m-old', [makeToolResult(OVERSIZED, 'tc-old')]);
      const newerMsg = makeMessage('m-new', [makeToolResult('short', 'tc-new')]);
      const overlapChunk = makeUserChunk('c-overlap', [olderMsg, newerMsg]);

      const truncated = truncateChunks([overlapChunk], 2000);

      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
      expect(
        (truncated[0].messages[0].toolResults[0].content as string).length,
      ).toBeLessThanOrEqual(2001);
      expect(truncated[0].messages[1].toolResults[0].isTruncated).toBe(false);
    });

    it('bounds older messages even when external map only covers newer messages', () => {
      const olderMsg = makeMessage('m-old', [makeToolResult(OVERSIZED, 'tc-old')]);
      const newerMsg = makeMessage('m-new', [makeToolResult(OVERSIZED, 'tc-new')]);
      const overlapChunk = makeUserChunk('c-overlap', [olderMsg, newerMsg]);

      const postCursorOnly = truncateMessages([newerMsg], 2000);
      const truncated = truncateChunks([overlapChunk], 2000, postCursorOnly);

      expect(truncated[0].messages[0].toolResults[0].isTruncated).toBe(true);
      expect(
        (truncated[0].messages[0].toolResults[0].content as string).length,
      ).toBeLessThanOrEqual(2001);
      expect(truncated[0].messages[1].toolResults[0].isTruncated).toBe(true);
    });

    it('simulates tail overlap: chunk has pre-cursor oversized message, only post-cursor in deltaMessages', () => {
      const preCursorMsg = makeMessage('m-pre', [makeToolResult(OVERSIZED, 'tc-pre')]);
      const postCursorMsg = makeMessage('m-post', [makeToolResult('small', 'tc-post')]);
      const overlapChunk = makeUserChunk('c-0', [preCursorMsg, postCursorMsg]);

      // Tail path: truncateChunks called without external map
      const result = truncateChunks([overlapChunk]);

      const preCursorContent = result[0].messages[0].toolResults[0].content as string;
      expect(preCursorContent.length).toBeLessThanOrEqual(2001);
      expect(result[0].messages[0].toolResults[0].isTruncated).toBe(true);
      expect(result[0].messages[0].toolResults[0].fullLength).toBe(5000);
    });
  });
});
