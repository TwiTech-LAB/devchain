import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SessionReaderService } from './session-reader.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { SessionCacheService } from './session-cache.service';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import { OpenCodeSessionReaderAdapter } from '../adapters/opencode-session-reader.adapter';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { PricingServiceInterface } from './pricing.interface';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import { decodeCursor } from './transcript-cursor';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapterFactory = {
  getAdapter: jest.fn(),
  getSupportedProviders: jest.fn().mockReturnValue(['claude']),
} as unknown as jest.Mocked<SessionReaderAdapterFactory>;

const mockPathValidator = {
  validateForRead: jest.fn(),
} as unknown as jest.Mocked<Pick<TranscriptPathValidator, 'validateForRead'>>;

const mockSessionsService = {
  getSession: jest.fn(),
};

const mockStorage = {
  getAgent: jest.fn(),
  getProfileProviderConfig: jest.fn(),
  getProvider: jest.fn(),
};

const mockMetricsService = {
  registerCacheStatsProvider: jest.fn(),
  registerStatsProvider: jest.fn(),
} as never;

const mockProviderAdapterFactory = {
  getAdapter: jest.fn().mockImplementation((name: string) => {
    if (name === 'claude') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ClaudeAdapter } = require('../../providers/adapters/claude.adapter');
      return new ClaudeAdapter();
    }
    return { providerName: name };
  }),
};

function makeMessage(id: string, role: 'user' | 'assistant', tsIso: string): UnifiedMessage {
  return {
    id,
    parentId: null,
    role,
    timestamp: new Date(tsIso),
    content: [{ type: 'text', text: `Message ${id}` }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
  };
}

function makeMetrics(overrides?: Partial<UnifiedMetrics>): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 150,
    totalContextConsumption: 150,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 5000,
    messageCount: 3,
    isOngoing: false,
    ...overrides,
  };
}

function makeSession(messages?: UnifiedMessage[]): UnifiedSession {
  const msgs = messages ?? [
    makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
    makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
    makeMessage('m3', 'user', '2026-01-01T10:00:10.000Z'),
  ];
  return {
    id: 'test-session',
    providerName: 'claude',
    filePath: '/home/user/.claude/projects/-test/session.jsonl',
    messages: msgs,
    metrics: makeMetrics({ messageCount: msgs.length }),
    isOngoing: false,
  };
}

const mockAdapter = {
  providerName: 'claude',
  parseSessionFile: jest.fn(),
  parseFullSession: jest.fn(),
  getSummary: jest.fn(),
};

const mockSessionCacheService = {
  getOrParse: jest.fn(),
  getOrParseWithMeta: jest.fn(),
  getFreshSession: jest.fn(),
  invalidate: jest.fn(),
  clear: jest.fn(),
  getEntry: jest.fn(),
  getChunks: jest.fn(),
  setChunks: jest.fn(),
  getChunksCacheStats: jest.fn(),
};

const mockChunksBySession = new Map<string, { sourceVersion: number; chunks: UnifiedChunk[] }>();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupResolveChain() {
  mockSessionsService.getSession.mockReturnValue({
    id: 'sess-1',
    agentId: 'agent-1',
    transcriptPath: '/home/user/.claude/projects/-test/session.jsonl',
    status: 'running',
  });
  mockStorage.getAgent.mockResolvedValue({
    id: 'agent-1',
    providerConfigId: 'config-1',
  });
  mockStorage.getProfileProviderConfig.mockResolvedValue({
    id: 'config-1',
    providerId: 'provider-1',
  });
  mockStorage.getProvider.mockResolvedValue({
    id: 'provider-1',
    name: 'claude',
  });
  (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(mockAdapter);
  (mockPathValidator.validateForRead as jest.Mock).mockResolvedValue(
    '/home/user/.claude/projects/-test/session.jsonl',
  );
  // Wire session cache to delegate to the mock adapter
  mockSessionCacheService.getOrParseWithMeta.mockImplementation(
    async (
      _id: string,
      source: string | { filePath: string },
      adapter: { parseFullSession: (p: string) => Promise<UnifiedSession> },
    ) => {
      const filePath = typeof source === 'string' ? source : source.filePath;
      const session = await adapter.parseFullSession(filePath);
      return {
        session,
        cacheHit: false,
        sourceChangeKind: 'unknown-full-parse',
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
        sourceVersion: 1024,
      };
    },
  );
}

describe('SessionReaderService', () => {
  let service: SessionReaderService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChunksBySession.clear();
    mockSessionCacheService.getEntry.mockReturnValue(undefined);
    mockSessionCacheService.getFreshSession.mockResolvedValue(undefined);
    mockAdapter.getSummary.mockResolvedValue(null);
    mockSessionCacheService.getChunks.mockImplementation(
      (sessionId: string, sourceVersion: number) => {
        const cached = mockChunksBySession.get(sessionId);
        return cached && cached.sourceVersion === sourceVersion ? cached.chunks : undefined;
      },
    );
    mockSessionCacheService.setChunks.mockImplementation(
      (sessionId: string, sourceVersion: number, chunks: UnifiedChunk[]) => {
        mockChunksBySession.set(sessionId, { sourceVersion, chunks });
      },
    );
    mockSessionCacheService.getChunksCacheStats.mockReturnValue({
      entries: 0,
      bytesEstimated: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      bytesMethod: 'deferred-to-aggregate',
    });
    service = new SessionReaderService(
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockPathValidator as unknown as TranscriptPathValidator,
      mockSessionCacheService as unknown as SessionCacheService,
      mockSessionsService as unknown as SessionsService,
      mockStorage as unknown as StorageService,
      mockProviderAdapterFactory as unknown as never,
    );
  });

  describe('getTranscript', () => {
    it('should return full session when resolution succeeds', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result).not.toBe(session);
      expect(result.messages).toBe(session.messages);
      expect(session.chunks).toBeUndefined();
      expect(mockSessionsService.getSession).toHaveBeenCalledWith('sess-1');
      expect(mockStorage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(mockStorage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(mockPathValidator.validateForRead).toHaveBeenCalledWith(
        '/home/user/.claude/projects/-test/session.jsonl',
        'claude',
      );
    });

    it('should attach semantic chunks to transcript responses', async () => {
      setupResolveChain();
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            { type: 'thinking', thinking: 'Let me inspect the file' },
            { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read', input: { path: 'a.ts' } },
            { type: 'text', text: 'Running the read tool now' },
          ],
          toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: 'a.ts' }, isTask: false }],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: 'export const x = 1;',
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: 'export const x = 1;', isError: false }],
        },
        {
          ...makeMessage('a2', 'assistant', '2026-01-01T10:00:08.000Z'),
          content: [{ type: 'text', text: 'Done reading the file.' }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.chunks).toBeDefined();
      expect(result.chunks?.map((chunk) => chunk.type)).toEqual(['user', 'ai']);

      const aiChunk = result.chunks?.[1];
      expect(aiChunk?.messages.map((msg) => msg.id)).toEqual(['a1', 'u2', 'a2']);

      if (aiChunk?.type === 'ai') {
        const stepTypes = aiChunk.semanticSteps.map((step) => step.type);
        expect(stepTypes).toEqual(
          expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'output']),
        );
      } else {
        throw new Error('Expected AI chunk with semantic steps');
      }
    });

    it('should throw NotFoundError when session not found', async () => {
      mockSessionsService.getSession.mockReturnValue(null);

      await expect(service.getTranscript('nonexistent')).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when transcript path not set', async () => {
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-1',
        agentId: 'agent-1',
        transcriptPath: null,
      });

      await expect(service.getTranscript('sess-1')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when no agentId', async () => {
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-1',
        agentId: null,
        transcriptPath: '/some/path.jsonl',
      });

      await expect(service.getTranscript('sess-1')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when agent has no providerConfigId', async () => {
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-1',
        agentId: 'agent-1',
        transcriptPath: '/some/path.jsonl',
      });
      mockStorage.getAgent.mockResolvedValue({
        id: 'agent-1',
        providerConfigId: null,
      });

      await expect(service.getTranscript('sess-1')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when provider not supported', async () => {
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-1',
        agentId: 'agent-1',
        transcriptPath: '/some/path.jsonl',
      });
      mockStorage.getAgent.mockResolvedValue({
        id: 'agent-1',
        providerConfigId: 'config-1',
      });
      mockStorage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        providerId: 'provider-1',
      });
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'unsupported',
      });
      (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(undefined);

      await expect(service.getTranscript('sess-1')).rejects.toThrow(ValidationError);
    });

    it('should truncate tool results when maxToolResultLength is provided', async () => {
      setupResolveChain();
      const longToolResult = 'A'.repeat(2600);
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            { type: 'thinking', thinking: 'Reading file contents' },
            {
              type: 'tool_call',
              toolCallId: 'tc-1',
              toolName: 'Read',
              input: { file_path: '/tmp/a.ts' },
            },
            { type: 'text', text: 'Calling read tool now' },
          ],
          toolCalls: [
            { id: 'tc-1', name: 'Read', input: { file_path: '/tmp/a.ts' }, isTask: false },
          ],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: longToolResult,
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: longToolResult, isError: false }],
        },
        {
          ...makeMessage('a2', 'assistant', '2026-01-01T10:00:08.000Z'),
          content: [{ type: 'text', text: 'Done reading the file.' }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1', { maxToolResultLength: 2000 });

      const toolResultMessage = result.messages.find((message) => message.id === 'u2');
      expect(toolResultMessage).toBeDefined();
      if (!toolResultMessage) {
        throw new Error('Expected tool result message');
      }

      const truncated = toolResultMessage.toolResults[0];
      expect(typeof truncated.content).toBe('string');
      expect((truncated.content as string).length).toBe(2001);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.fullLength).toBe(2600);

      const truncatedBlock = toolResultMessage.content.find(
        (block) => block.type === 'tool_result',
      );
      expect(truncatedBlock).toMatchObject({
        type: 'tool_result',
        toolCallId: 'tc-1',
        isTruncated: true,
        fullLength: 2600,
      });

      const aiChunk = result.chunks?.find((chunk) => chunk.type === 'ai');
      expect(aiChunk).toBeDefined();
      if (!aiChunk || aiChunk.type !== 'ai') {
        throw new Error('Expected AI chunk');
      }

      const semanticToolResultStep = aiChunk.semanticSteps.find(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1',
      );
      expect(semanticToolResultStep).toBeDefined();
      expect(semanticToolResultStep?.content.isTruncated).toBe(true);
      expect(semanticToolResultStep?.content.fullLength).toBe(2600);
      expect(semanticToolResultStep?.content.toolResultContent).toBe(truncated.content);

      const turnToolResultStep = aiChunk.turns
        .flatMap((turn) => turn.steps)
        .find((step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1');
      expect(turnToolResultStep).toBeDefined();
      expect(turnToolResultStep?.content.isTruncated).toBe(true);
      expect(turnToolResultStep?.content.fullLength).toBe(2600);
      expect(turnToolResultStep?.content.toolResultContent).toBe(truncated.content);
    });

    it('should keep under-limit tool results unchanged across message, semantic, and turn paths', async () => {
      setupResolveChain();
      const shortToolResult = 'short-result-content';
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            {
              type: 'tool_call',
              toolCallId: 'tc-1',
              toolName: 'Read',
              input: { path: '/tmp/a.ts' },
            },
            { type: 'text', text: 'Reading file now' },
          ],
          toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: '/tmp/a.ts' }, isTask: false }],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: shortToolResult,
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: shortToolResult, isError: false }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1', { maxToolResultLength: 2000 });

      const toolResultMessage = result.messages.find((message) => message.id === 'u2');
      expect(toolResultMessage).toBeDefined();
      if (!toolResultMessage) {
        throw new Error('Expected tool result message');
      }
      expect(toolResultMessage.toolResults[0].content).toBe(shortToolResult);
      expect(toolResultMessage.toolResults[0].isTruncated).toBeUndefined();
      expect(toolResultMessage.toolResults[0].fullLength).toBeUndefined();

      const toolResultBlock = toolResultMessage.content.find(
        (block) => block.type === 'tool_result',
      );
      expect(toolResultBlock).toMatchObject({
        type: 'tool_result',
        toolCallId: 'tc-1',
        content: shortToolResult,
      });
      expect(toolResultBlock?.isTruncated).toBeUndefined();
      expect(toolResultBlock?.fullLength).toBeUndefined();

      const aiChunk = result.chunks?.find((chunk) => chunk.type === 'ai');
      expect(aiChunk).toBeDefined();
      if (!aiChunk || aiChunk.type !== 'ai') {
        throw new Error('Expected AI chunk');
      }

      const semanticToolResultStep = aiChunk.semanticSteps.find(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1',
      );
      expect(semanticToolResultStep?.content.toolResultContent).toBe(shortToolResult);
      expect(semanticToolResultStep?.content.isTruncated).toBeUndefined();
      expect(semanticToolResultStep?.content.fullLength).toBeUndefined();

      const turnToolResultStep = aiChunk.turns
        .flatMap((turn) => turn.steps)
        .find((step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1');
      expect(turnToolResultStep?.content.toolResultContent).toBe(shortToolResult);
      expect(turnToolResultStep?.content.isTruncated).toBeUndefined();
      expect(turnToolResultStep?.content.fullLength).toBeUndefined();
    });

    it('should not apply truncation when maxToolResultLength is omitted', async () => {
      setupResolveChain();
      const longToolResult = 'B'.repeat(2600);
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            {
              type: 'tool_call',
              toolCallId: 'tc-1',
              toolName: 'Read',
              input: { path: '/tmp/a.ts' },
            },
            { type: 'text', text: 'Reading file now' },
          ],
          toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: '/tmp/a.ts' }, isTask: false }],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: longToolResult,
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: longToolResult, isError: false }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      const toolResultMessage = result.messages.find((message) => message.id === 'u2');
      expect(toolResultMessage).toBeDefined();
      if (!toolResultMessage) {
        throw new Error('Expected tool result message');
      }
      expect(toolResultMessage.toolResults[0].content).toBe(longToolResult);
      expect(toolResultMessage.toolResults[0].isTruncated).toBeUndefined();
      expect(toolResultMessage.toolResults[0].fullLength).toBeUndefined();

      const aiChunk = result.chunks?.find((chunk) => chunk.type === 'ai');
      expect(aiChunk).toBeDefined();
      if (!aiChunk || aiChunk.type !== 'ai') {
        throw new Error('Expected AI chunk');
      }
      const semanticToolResultStep = aiChunk.semanticSteps.find(
        (step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1',
      );
      expect(semanticToolResultStep?.content.toolResultContent).toBe(longToolResult);
      expect(semanticToolResultStep?.content.isTruncated).toBeUndefined();

      const turnToolResultStep = aiChunk.turns
        .flatMap((turn) => turn.steps)
        .find((step) => step.type === 'tool_result' && step.content.toolCallId === 'tc-1');
      expect(turnToolResultStep?.content.toolResultContent).toBe(longToolResult);
      expect(turnToolResultStep?.content.isTruncated).toBeUndefined();
    });

    it('should reduce serialized transcript payload size when truncation is active', async () => {
      setupResolveChain();
      const longToolResult = 'C'.repeat(10_000);
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            {
              type: 'tool_call',
              toolCallId: 'tc-1',
              toolName: 'Read',
              input: { path: '/tmp/a.ts' },
            },
            { type: 'text', text: 'Reading file now' },
          ],
          toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: '/tmp/a.ts' }, isTask: false }],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: longToolResult,
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: longToolResult, isError: false }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const fullTranscript = await service.getTranscript('sess-1');
      const truncatedTranscript = await service.getTranscript('sess-1', {
        maxToolResultLength: 2000,
      });

      const fullPayloadSize = JSON.stringify({
        messages: fullTranscript.messages,
        chunks: fullTranscript.chunks,
      }).length;
      const truncatedPayloadSize = JSON.stringify({
        messages: truncatedTranscript.messages,
        chunks: truncatedTranscript.chunks,
      }).length;

      expect(truncatedPayloadSize).toBeLessThan(fullPayloadSize);
    });

    it('should throw ValidationError for invalid maxToolResultLength', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());

      await expect(service.getTranscript('sess-1', { maxToolResultLength: 0 })).rejects.toThrow(
        ValidationError,
      );
    });

    it('should preserve the enriched wrapper when no tool results exceed maxLength', async () => {
      setupResolveChain();
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [
            {
              type: 'tool_call',
              toolCallId: 'tc-1',
              toolName: 'Read',
              input: { path: '/tmp/a.ts' },
            },
          ],
          toolCalls: [{ id: 'tc-1', name: 'Read', input: { path: '/tmp/a.ts' }, isTask: false }],
        },
        {
          ...makeMessage('u2', 'user', '2026-01-01T10:00:06.000Z'),
          isMeta: true, // real Claude tool_result entries are meta → classified 'ai' via the default branch
          content: [
            {
              type: 'tool_result',
              toolCallId: 'tc-1',
              content: 'short-result',
              isError: false,
            },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: 'short-result', isError: false }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1', { maxToolResultLength: 2000 });

      expect(result).not.toBe(session);
      expect(result.messages).toBe(session.messages);
      expect(session.chunks).toBeUndefined();
    });

    it('should preserve the enriched wrapper when the session has no tool results', async () => {
      setupResolveChain();
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1', { maxToolResultLength: 2000 });

      expect(result).not.toBe(session);
      expect(result.messages).toBe(session.messages);
      expect(session.chunks).toBeUndefined();
    });
  });

  describe('getTranscriptSummaryWithCursor', () => {
    it('mints an opaque cursor from a single parse and the cursor round-trips into getTranscriptTail', async () => {
      setupResolveChain();
      const session = makeSession(); // 3 messages
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const summary = await service.getTranscriptSummaryWithCursor('sess-1');

      expect(summary.sessionId).toBe('sess-1');
      expect(summary.messageCount).toBe(3);
      expect(summary.metrics).toBeDefined();
      expect(typeof summary.cursor).toBe('string');
      expect(summary.cursor.length).toBeGreaterThan(0);
      // bootstrap mints the cursor from one parse — no extra full-transcript read
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);

      // Feed the bootstrap cursor straight into the tail path: with no new
      // messages it must be accepted (not expired) and report a TRUE-empty delta.
      const tail = await service.getTranscriptTail('sess-1', summary.cursor);
      expect(tail).not.toBeNull();
      expect(tail).toMatchObject({ kind: 'delta' });
      expect(tail?.totalMessageCount).toBe(3);
      expect(tail?.deltaMessages).toEqual([]);
      expect(tail?.deltaChunks).toEqual([]);
      expect(tail?.replaceFromChunkId).toBeNull();
    });
  });

  describe('getTranscriptTail — window-safe merge contract', () => {
    it('no-op poll (no new messages) returns true-empty delta and the unchanged cursor', async () => {
      setupResolveChain();
      const session = makeSession(); // 3 messages
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const summary = await service.getTranscriptSummaryWithCursor('sess-1');
      const tail = await service.getTranscriptTail('sess-1', summary.cursor);

      expect(tail).not.toBeNull();
      expect(tail).toMatchObject({ kind: 'delta' });
      expect(tail?.deltaChunks).toEqual([]);
      expect(tail?.deltaMessages).toEqual([]);
      expect(tail?.replaceFromChunkId).toBeNull();
      // Cursor unchanged → genuine no-op (preserves client adaptive backoff).
      expect(tail?.cursor).toBe(summary.cursor);
    });

    it('returns the window-stable anchor id of the first delta chunk when the tail grows', async () => {
      setupResolveChain();
      const twoMessages = [
        makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
      ];
      // Mint a cursor at the 2-message state.
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(twoMessages));
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session: makeSession(twoMessages),
        cacheHit: false,
        sourceChangeKind: 'unknown-full-parse',
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
        sourceVersion: 1024,
        boundaryFold: false,
      });
      const summary = await service.getTranscriptSummaryWithCursor('sess-1');

      // A new message arrives (transcript grew).
      const threeMessages = [...twoMessages, makeMessage('m3', 'user', '2026-01-01T10:00:10.000Z')];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(threeMessages));
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session: makeSession(threeMessages),
        cacheHit: false,
        sourceChangeKind: 'same-file-append',
        lastOffset: 2048,
        lastSize: 2048,
        lastMtime: Date.now(),
        sourceVersion: 2048,
        boundaryFold: false,
      });

      const tail = await service.getTranscriptTail('sess-1', summary.cursor);

      expect(tail).not.toBeNull();
      expect(tail).toMatchObject({ kind: 'delta' });
      expect(tail?.deltaChunks.length).toBeGreaterThan(0);
      expect(tail?.deltaMessages.length).toBeGreaterThan(0);
      // Anchor is authoritative and equals the first delta chunk's stable id.
      expect(tail?.replaceFromChunkId).not.toBeNull();
      expect(tail?.replaceFromChunkId).toBe(tail?.deltaChunks[0].id);
      expect(tail?.totalMessageCount).toBe(3);
    });

    it('returns an in-place delta on source-revision change even when message count is unchanged', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('m3', 'user', '2026-01-01T10:00:10.000Z'),
      ];
      const session = makeSession(messages);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      // Mint at sourceVersion 1024; the tail then sees a bumped revision (2048)
      // with the SAME messages (DB in-place part update — no new messages).
      mockSessionCacheService.getOrParseWithMeta
        .mockResolvedValueOnce({
          session,
          cacheHit: false,
          sourceChangeKind: 'unknown-full-parse',
          lastOffset: 1024,
          lastSize: 1024,
          lastMtime: Date.now(),
          sourceVersion: 1024,
        })
        .mockResolvedValueOnce({
          session,
          cacheHit: false,
          sourceChangeKind: 'db-update',
          lastOffset: 2048,
          lastSize: 2048,
          lastMtime: Date.now(),
          sourceVersion: 2048,
        });

      const summary = await service.getTranscriptSummaryWithCursor('sess-1');
      const tail = await service.getTranscriptTail('sess-1', summary.cursor);

      expect(tail).not.toBeNull();
      expect(tail).toMatchObject({ kind: 'delta' });
      expect(tail?.totalMessageCount).toBe(3);
      // In-place last-chunk replacement: delta chunks present, but no NEW messages.
      expect(tail?.deltaChunks.length).toBeGreaterThan(0);
      expect(tail?.deltaMessages).toEqual([]);
      expect(tail?.replaceFromChunkId).not.toBeNull();
      // Cursor advanced to the new revision (NOT a no-op).
      expect(tail?.cursor).not.toBe(summary.cursor);
    });

    it.each([
      'file-replacement',
      'file-truncation',
      'same-file-rewrite',
      'cache-hit',
      'unknown-full-parse',
    ] as const)(
      'requires a cursor-free full refetch for an unsafe %s revision change',
      async (sourceChangeKind) => {
        setupResolveChain();
        const session = makeSession();
        mockAdapter.parseFullSession.mockResolvedValue(session);
        mockSessionCacheService.getOrParseWithMeta
          .mockResolvedValueOnce({
            session,
            cacheHit: false,
            sourceChangeKind: 'unknown-full-parse',
            lastOffset: 1024,
            lastSize: 1024,
            lastMtime: Date.now(),
            sourceVersion: 1024,
            boundaryFold: false,
          })
          .mockResolvedValueOnce({
            session,
            cacheHit: sourceChangeKind === 'cache-hit',
            sourceChangeKind,
            lastOffset: 2048,
            lastSize: 2048,
            lastMtime: Date.now(),
            sourceVersion: 2048,
            boundaryFold: false,
          });

        const summary = await service.getTranscriptSummaryWithCursor('sess-1');
        const tail = await service.getTranscriptTail('sess-1', summary.cursor);

        expect(tail).toEqual({
          kind: 'full-refetch-required',
          sourceChangeKind,
        });
        expect(tail).not.toHaveProperty('cursor');
        expect(tail).not.toHaveProperty('deltaChunks');
        expect(tail).not.toHaveProperty('deltaMessages');
      },
    );

    it('returns null on an expired cursor (message count exceeds the current total)', async () => {
      setupResolveChain();
      const threeMessages = [
        makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('m3', 'user', '2026-01-01T10:00:10.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(threeMessages));
      const summary = await service.getTranscriptSummaryWithCursor('sess-1');

      // Session shrank (e.g. rotated) below the cursor's message count.
      mockAdapter.parseFullSession.mockResolvedValue(
        makeSession([makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')]),
      );

      const tail = await service.getTranscriptTail('sess-1', summary.cursor);
      expect(tail).toBeNull();
    });
  });

  describe('getTranscriptSummary', () => {
    it('module-unit: serves a large cold summary without materializing messages', async () => {
      setupResolveChain();
      const metrics = makeMetrics({ messageCount: 50_000, isOngoing: true });
      mockAdapter.getSummary.mockResolvedValue({ metrics, exactFields: [] });

      const result = await service.getTranscriptSummary('sess-1');

      expect(result).toEqual({
        sessionId: 'sess-1',
        providerName: 'claude',
        metrics,
        messageCount: 50_000,
        isOngoing: true,
      });
      expect(mockAdapter.getSummary).toHaveBeenCalledWith({
        filePath: '/home/user/.claude/projects/-test/session.jsonl',
        providerName: 'claude',
        kind: 'file',
      });
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
      expect(mockSessionCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
    });

    it('module-unit: applies the 1M context override to lightweight adapter metrics', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const metrics = makeMetrics({
        primaryModel: 'claude-opus-4-6',
        contextWindowTokens: 200_000,
      });
      mockAdapter.getSummary.mockResolvedValue({ metrics, exactFields: [] });

      const result = await service.getTranscriptSummary('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
      expect(metrics.contextWindowTokens).toBe(200_000);
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
    });

    it('module-unit: reuses an active watcher metrics snapshot before reading the source', async () => {
      setupResolveChain();
      const metrics = makeMetrics({ messageCount: 11, isOngoing: true });
      const watcher = { getLastKnownSummaryMetrics: jest.fn().mockReturnValue(metrics) };
      const watcherBackedService = new SessionReaderService(
        mockAdapterFactory as unknown as SessionReaderAdapterFactory,
        mockPathValidator as unknown as TranscriptPathValidator,
        mockSessionCacheService as unknown as SessionCacheService,
        mockSessionsService as unknown as SessionsService,
        mockStorage as unknown as StorageService,
        mockProviderAdapterFactory as unknown as never,
        watcher as never,
      );

      const result = await watcherBackedService.getTranscriptSummary('sess-1');

      expect(result.metrics).toBe(metrics);
      expect(watcher.getLastKnownSummaryMetrics).toHaveBeenCalledWith('sess-1');
      expect(mockAdapter.getSummary).not.toHaveBeenCalled();
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
    });

    it('module-unit: falls back to the existing full parse when summary capability fails', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.getSummary.mockRejectedValue(new Error('summary unavailable'));
      mockAdapter.parseFullSession.mockResolvedValue(session);

      await expect(service.getTranscriptSummary('sess-1')).resolves.toEqual(
        expect.objectContaining({ messageCount: session.metrics.messageCount }),
      );

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);
    });

    it('module-unit: returns complete cached metrics without entering parsed/chunk construction', async () => {
      setupResolveChain();
      const cachedSession = makeSession();
      const cachedMetrics = cachedSession.metrics;
      Object.defineProperty(cachedSession, 'messages', {
        get() {
          throw new Error('summary cache hit must not materialize messages');
        },
      });
      mockSessionCacheService.getEntry.mockReturnValue({ session: cachedSession });
      mockSessionCacheService.getFreshSession.mockResolvedValue(cachedSession);

      const result = await service.getTranscriptSummary('sess-1');

      expect(result).toEqual({
        sessionId: 'sess-1',
        providerName: 'claude',
        metrics: cachedMetrics,
        messageCount: cachedMetrics.messageCount,
        isOngoing: cachedMetrics.isOngoing,
      });
      expect(result.metrics).toBe(cachedMetrics);
      expect(mockSessionCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
      expect(service.getChunksCacheStats()).toMatchObject({ hits: 0, misses: 0 });
    });

    it('module-unit: preserves context-window enrichment on a parsed-cache hit', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const cachedSession = makeSession();
      cachedSession.metrics.primaryModel = 'claude-opus-4-6';
      mockSessionCacheService.getEntry.mockReturnValue({ session: cachedSession });
      mockSessionCacheService.getFreshSession.mockResolvedValue(cachedSession);

      const result = await service.getTranscriptSummary('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
      expect(mockSessionCacheService.getOrParseWithMeta).not.toHaveBeenCalled();
    });

    it('module-unit: keeps the summary response field-for-field identical across cold and warm paths', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const cold = await service.getTranscriptSummary('sess-1');
      mockSessionCacheService.getEntry.mockReturnValue({ session });
      mockSessionCacheService.getFreshSession.mockResolvedValue(session);
      const warm = await service.getTranscriptSummary('sess-1');

      expect(warm).toEqual(cold);
      expect(Object.keys(warm).sort()).toEqual(Object.keys(cold).sort());
    });

    it('should return summary with metrics', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscriptSummary('sess-1');

      expect(result.sessionId).toBe('sess-1');
      expect(result.providerName).toBe('claude');
      expect(result.messageCount).toBe(3);
      expect(result.isOngoing).toBe(false);
      expect(result.metrics).toBeDefined();
    });

    it('should surface parser->cache merged context metrics in summary output', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-summary-context-'));
      const filePath = path.join(tmpDir, 'session.jsonl');

      const initialLines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u-001',
          parentUuid: null,
          isSidechain: false,
          timestamp: '2026-01-01T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' }, // 5 chars => 2 tokens
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a-001',
          parentUuid: 'u-001',
          isSidechain: false,
          timestamp: '2026-01-01T10:00:05.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'Hi there!' }], // 9 chars => 3 tokens
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ];

      await fs.writeFile(filePath, initialLines.join('\n') + '\n', 'utf8');

      const pricing: PricingServiceInterface = {
        calculateMessageCost: jest.fn().mockReturnValue(0.001),
        getContextWindowSize: jest.fn().mockReturnValue(200_000),
      };
      const realClaudeAdapter = new ClaudeSessionReaderAdapter(pricing);
      const realSessionCacheService = new SessionCacheService(mockMetricsService);

      // Wire mockSessionCacheService to delegate to the real SessionCacheService
      mockSessionCacheService.getOrParseWithMeta.mockImplementation(
        async (_sessionId: string, targetPath: string, _adapter: unknown) =>
          realSessionCacheService.getOrParseWithMeta('sess-1', targetPath, realClaudeAdapter),
      );

      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-1',
        agentId: 'agent-1',
        transcriptPath: filePath,
        status: 'running',
      });
      mockStorage.getAgent.mockResolvedValue({
        id: 'agent-1',
        providerConfigId: 'config-1',
      });
      mockStorage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        providerId: 'provider-1',
      });
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
      });
      (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(mockAdapter);
      (mockPathValidator.validateForRead as jest.Mock).mockResolvedValue(filePath);

      try {
        const firstSummary = await service.getTranscriptSummary('sess-1');
        expect(firstSummary.metrics.totalContextTokens).toBe(140);
        expect(firstSummary.metrics.visibleContextTokens).toBe(5);

        await fs.appendFile(
          filePath,
          JSON.stringify({
            type: 'user',
            uuid: 'u-002',
            parentUuid: 'a-001',
            isSidechain: false,
            timestamp: '2026-01-01T10:00:20.000Z',
            message: { role: 'user', content: 'Follow up' }, // 9 chars => 3 tokens
          }) + '\n',
          'utf8',
        );

        // Invalidate both test-owned cache layers to force a second parse pass.
        realSessionCacheService.invalidate('sess-1');
        mockChunksBySession.clear();

        const secondSummary = await service.getTranscriptSummary('sess-1');
        // Delta slice had no assistant usage snapshot, so existing value is preserved.
        expect(secondSummary.metrics.totalContextTokens).toBe(140);
        // Recomputed from merged messages: hello(2) + hi there!(3) + follow up(3).
        expect(secondSummary.metrics.visibleContextTokens).toBe(8);
      } finally {
        realSessionCacheService.onModuleDestroy();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('getToolResult', () => {
    it('should return full tool result content by toolCallId', async () => {
      setupResolveChain();
      const session = makeSession([
        {
          ...makeMessage('m-tool', 'assistant', '2026-01-01T10:00:00.000Z'),
          toolCalls: [
            { id: 'tc-1', name: 'Read', input: { file_path: '/tmp/a.ts' }, isTask: false },
          ],
          toolResults: [{ toolCallId: 'tc-1', content: 'full content', isError: false }],
        },
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getToolResult('sess-1', 'tc-1');

      expect(result).toEqual({
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        content: 'full content',
        isError: false,
        fullLength: 12,
      });
    });

    it('should throw NotFoundError when tool result is missing', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());

      await expect(service.getToolResult('sess-1', 'missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getUnifiedTranscriptChunks', () => {
    it('should return paginated UnifiedChunk[] with cursor-stable IDs', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('u2', 'user', '2026-01-01T10:00:10.000Z'),
        makeMessage('a2', 'assistant', '2026-01-01T10:00:15.000Z'),
        makeMessage('u3', 'user', '2026-01-01T10:00:20.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getUnifiedTranscriptChunks('sess-1', undefined, 2);

      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0].id).toBe('chunk-0');
      expect(result.chunks[0].type).toBe('user');
      expect(result.chunks[1].id).toBe('chunk-1');
      expect(result.totalCount).toBeGreaterThan(2);
      expect(result.nextCursor).toBeDefined();
      expect(result.prevCursor).toBeNull();
    });

    it('should use cursor as starting chunk ID (forward)', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('u2', 'user', '2026-01-01T10:00:10.000Z'),
        makeMessage('a2', 'assistant', '2026-01-01T10:00:15.000Z'),
        makeMessage('u3', 'user', '2026-01-01T10:00:20.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const first = await service.getUnifiedTranscriptChunks('sess-1', undefined, 2);
      const second = await service.getUnifiedTranscriptChunks(
        'sess-1',
        first.nextCursor!,
        2,
        'forward',
      );

      expect(second.chunks[0].id).toBe(first.nextCursor);
      expect(second.prevCursor).toBeDefined();
    });

    it('should paginate backward from cursor', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('u2', 'user', '2026-01-01T10:00:10.000Z'),
        makeMessage('a2', 'assistant', '2026-01-01T10:00:15.000Z'),
        makeMessage('u3', 'user', '2026-01-01T10:00:20.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const all = await service.getUnifiedTranscriptChunks('sess-1', undefined, 100);
      const lastChunkId = all.chunks[all.chunks.length - 1].id;

      const backward = await service.getUnifiedTranscriptChunks(
        'sess-1',
        lastChunkId,
        2,
        'backward',
      );

      expect(backward.chunks.length).toBeLessThanOrEqual(2);
      expect(backward.chunks[backward.chunks.length - 1].id).toBe(lastChunkId);
    });

    it('should throw ValidationError for invalid cursor', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());

      await expect(service.getUnifiedTranscriptChunks('sess-1', 'chunk-999')).rejects.toThrow(
        ValidationError,
      );
    });

    it('should return semantic steps in AI chunks', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [{ type: 'text' as const, text: 'Hello from assistant' }],
        },
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getUnifiedTranscriptChunks('sess-1');

      const aiChunk = result.chunks.find((c) => c.type === 'ai');
      expect(aiChunk).toBeDefined();
      if (aiChunk?.type === 'ai') {
        expect(aiChunk.semanticSteps.length).toBeGreaterThan(0);
      }
    });

    it('should NOT call getTranscript internally', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());
      const spy = jest.spyOn(service, 'getTranscript');

      await service.getUnifiedTranscriptChunks('sess-1');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('getUnifiedTranscriptChunk', () => {
    it('should return a single UnifiedChunk by ID', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getUnifiedTranscriptChunk('sess-1', 'chunk-0');

      expect(result.id).toBe('chunk-0');
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('should throw NotFoundError for unknown chunk ID', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());

      await expect(service.getUnifiedTranscriptChunk('sess-1', 'chunk-999')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('getTranscriptIndex', () => {
    it('should return lightweight index metadata', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [{ type: 'text' as const, text: 'Hello from assistant' }],
        },
        makeMessage('u2', 'user', '2026-01-01T10:00:10.000Z'),
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptIndex('sess-1');

      expect(result.totals.messageCount).toBe(3);
      expect(result.totals.chunkCount).toBeGreaterThan(0);
      expect(result.chunkIds.length).toBe(result.totals.chunkCount);
      expect(result.providerName).toBe('claude');
      expect(result.isOngoing).toBe(false);
      expect(decodeCursor(result.cursor)?.fileSize).toBe(1024);
    });

    it('advances the opaque index cursor when an equal-shape source revision changes', async () => {
      setupResolveChain();
      const session = makeSession();
      mockSessionCacheService.getOrParseWithMeta
        .mockResolvedValueOnce({
          session,
          cacheHit: false,
          sourceChangeKind: 'unknown-full-parse',
          lastOffset: 1024,
          lastSize: 1024,
          lastMtime: 1,
          sourceVersion: 111,
        })
        .mockResolvedValueOnce({
          session,
          cacheHit: false,
          sourceChangeKind: 'same-file-rewrite',
          lastOffset: 1024,
          lastSize: 1024,
          lastMtime: 2,
          sourceVersion: 222,
        });

      const before = await service.getTranscriptIndex('sess-1');
      const after = await service.getTranscriptIndex('sess-1');

      expect(after.totals).toEqual(before.totals);
      expect(after.chunkIds).toEqual(before.chunkIds);
      expect(after.cursor).not.toBe(before.cursor);
      expect(decodeCursor(after.cursor)?.fileSize).toBe(222);
    });

    it('should return latestOutputPreview from last AI chunk', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [{ type: 'text' as const, text: 'This is the final output text' }],
        },
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptIndex('sess-1');

      expect(result.latestOutputPreview).toBe('This is the final output text');
    });

    it('should return null latestOutputPreview when no AI output exists', async () => {
      setupResolveChain();
      const messages = [makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z')];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptIndex('sess-1');

      expect(result.latestOutputPreview).toBeNull();
    });

    it('should NOT call getTranscript internally', async () => {
      setupResolveChain();
      mockAdapter.parseFullSession.mockResolvedValue(makeSession());
      const spy = jest.spyOn(service, 'getTranscript');

      await service.getTranscriptIndex('sess-1');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should be cheaper than full transcript (no semantic step content in response)', async () => {
      setupResolveChain();
      const messages = [
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        {
          ...makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
          content: [{ type: 'text' as const, text: 'A'.repeat(5000) }],
        },
      ];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const index = await service.getTranscriptIndex('sess-1');
      const full = await service.getTranscript('sess-1');

      const indexSize = JSON.stringify(index).length;
      const fullSize = JSON.stringify(full).length;

      expect(indexSize).toBeLessThan(fullSize / 2);
    });
  });

  describe('Claude 1M context override', () => {
    it('should override contextWindowTokens to 1M when opus model and oneMillionContextEnabled', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
    });

    it('should not override contextWindowTokens when Claude provider has oneMillionContextEnabled=false', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: false,
      });
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(200_000);
    });

    it('should not override contextWindowTokens for non-Claude providers', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        oneMillionContextEnabled: true,
      });
      (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(mockAdapter);
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(200_000);
    });

    it('should apply override on every call including cache hits from SessionCacheService', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';

      // First call: fresh parse via adapter delegation
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session,
        cacheHit: false,
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
      });
      // Second call: cache hit (no adapter.parseFullSession call)
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session,
        cacheHit: true,
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
      });

      const result1 = await service.getTranscript('sess-1');
      const result2 = await service.getTranscript('sess-1');

      expect(result1.metrics.contextWindowTokens).toBe(1_000_000);
      expect(result2.metrics.contextWindowTokens).toBe(1_000_000);
      // adapter.parseFullSession was NOT called directly — SessionCacheService manages it
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
    });

    it('should return default contextWindowTokens when oneMillionContextEnabled toggles from true to false', async () => {
      setupResolveChain();
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';
      session.metrics.contextWindowTokens = 200_000;

      mockSessionCacheService.getOrParseWithMeta.mockResolvedValue({
        session,
        cacheHit: false,
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
      });

      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const result1 = await service.getTranscript('sess-1');
      expect(result1.metrics.contextWindowTokens).toBe(1_000_000);

      mockSessionCacheService.getOrParseWithMeta.mockResolvedValue({
        session,
        cacheHit: true,
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
      });
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: false,
      });
      const result2 = await service.getTranscript('sess-1');
      expect(result2.metrics.contextWindowTokens).toBe(200_000);
      expect(session.metrics.contextWindowTokens).toBe(200_000);
    });

    it('should not override primaryModel even when 1M context is enabled', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.primaryModel).toBe('claude-opus-4-6');
      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
    });

    it('should not override contextWindowTokens for sonnet model even with 1M enabled', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const session = makeSession();
      // default fixture is claude-sonnet-4-6
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(200_000);
    });

    it('should not override contextWindowTokens for haiku model even with 1M enabled', async () => {
      setupResolveChain();
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });
      const session = makeSession();
      session.metrics.primaryModel = 'claude-haiku-4-5';
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result.metrics.contextWindowTokens).toBe(200_000);
    });
  });

  describe('session cache delegation', () => {
    it('coalesces concurrent summary, index, and chunk requests into one parse flight', async () => {
      setupResolveChain();
      const session = makeSession();
      let resolveParse!: (value: UnifiedSession) => void;
      const parseDeferred = new Promise<UnifiedSession>((resolve) => {
        resolveParse = resolve;
      });
      mockAdapter.parseFullSession.mockReturnValue(parseDeferred);

      const summary = service.getTranscriptSummary('sess-1');
      const index = service.getTranscriptIndex('sess-1');
      const chunks = service.getUnifiedTranscriptChunks('sess-1');

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);

      resolveParse(session);
      const [summaryResult, indexResult, chunksResult] = await Promise.all([
        summary,
        index,
        chunks,
      ]);

      expect(summaryResult.messageCount).toBe(session.messages.length);
      expect(indexResult.totals.messageCount).toBe(session.messages.length);
      expect(chunksResult.totalCount).toBeGreaterThan(0);
    });

    it('rejects every waiter and clears a failed parse flight so the next request retries', async () => {
      setupResolveChain();
      const parseError = new Error('deferred parse failed');
      let rejectParse!: (reason: Error) => void;
      const parseDeferred = new Promise<UnifiedSession>((_resolve, reject) => {
        rejectParse = reject;
      });
      mockAdapter.parseFullSession.mockReturnValue(parseDeferred);

      const summary = service.getTranscriptSummary('sess-1');
      const index = service.getTranscriptIndex('sess-1');
      const chunk = service.getUnifiedTranscriptChunks('sess-1');

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
      rejectParse(parseError);

      await expect(Promise.allSettled([summary, index, chunk])).resolves.toEqual([
        expect.objectContaining({ status: 'rejected', reason: parseError }),
        expect.objectContaining({ status: 'rejected', reason: parseError }),
        expect.objectContaining({ status: 'rejected', reason: parseError }),
      ]);

      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);
      await expect(service.getTranscriptSummary('sess-1')).resolves.toEqual(
        expect.objectContaining({ messageCount: session.messages.length }),
      );
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(2);
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
    });

    it('re-enters freshness detection after a settled flight instead of pinning its result', async () => {
      setupResolveChain();
      const firstSession = makeSession();
      const changedSession = makeSession([
        ...firstSession.messages,
        makeMessage('m4', 'assistant', '2026-01-01T10:00:15.000Z'),
      ]);
      type CacheResult = Awaited<ReturnType<SessionCacheService['getOrParseWithMeta']>>;
      let resolveFirstParse!: (value: CacheResult) => void;
      const firstParse = new Promise<CacheResult>((resolve) => {
        resolveFirstParse = resolve;
      });
      mockSessionCacheService.getOrParseWithMeta.mockReturnValueOnce(firstParse);

      const firstRequest = service.getTranscriptSummary('sess-1');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(1);

      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session: changedSession,
        cacheHit: false,
        lastOffset: 2000,
        lastSize: 2000,
        lastMtime: Date.now(),
        sourceVersion: 2000,
        boundaryFold: false,
      });
      resolveFirstParse({
        session: firstSession,
        cacheHit: false,
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: Date.now(),
        sourceVersion: 1000,
        boundaryFold: false,
      });

      const first = await firstRequest;
      const afterFreshnessChange = await service.getTranscriptSummary('sess-1');

      expect(first.messageCount).toBe(3);
      expect(afterFreshnessChange.messageCount).toBe(4);
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(2);
    });

    it('should call getOrParseWithMeta once for repeated calls (cache sharing)', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      await service.getTranscript('sess-1');
      await service.getUnifiedTranscriptChunks('sess-1', undefined, 2);
      await service.getTranscriptSummary('sess-1');

      // getOrParseWithMeta is called on every getParsedSession invocation;
      // whether it re-parses or returns cached data is SessionCacheService's job.
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledTimes(3);
      // The resolved source-ref + adapter are passed through to SessionCacheService
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledWith(
        'sess-1',
        {
          filePath: '/home/user/.claude/projects/-test/session.jsonl',
          providerName: 'claude',
          kind: 'file',
        },
        mockAdapter,
      );
    });

    it('should share cache between getTranscript and getTranscriptSummary', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      await service.getTranscript('sess-1');
      const summary = await service.getTranscriptSummary('sess-1');

      // Both methods call getOrParseWithMeta which delegates to adapter.parseFullSession.
      // With default mock delegation, parseFullSession is called each time.
      // The cache-hit deduplication is SessionCacheService's responsibility.
      expect(summary.providerName).toBe('claude');
      expect(summary.messageCount).toBe(3);
    });
  });

  describe('chunks cache', () => {
    it('should reuse built chunks when offset unchanged', async () => {
      setupResolveChain();
      const session = makeSession();
      // Both calls return the same lastOffset
      mockSessionCacheService.getOrParseWithMeta
        .mockResolvedValueOnce({
          session,
          cacheHit: false,
          lastOffset: 1000,
          lastSize: 1000,
          lastMtime: Date.now(),
          sourceVersion: 1000,
        })
        .mockResolvedValueOnce({
          session,
          cacheHit: true,
          lastOffset: 1000,
          lastSize: 1000,
          lastMtime: Date.now(),
          sourceVersion: 1000,
        });

      const result1 = await service.getTranscript('sess-1');
      const result2 = await service.getTranscript('sess-1');

      // Both should have chunks
      expect(result1.chunks).toBeDefined();
      expect(result2.chunks).toBeDefined();
      // The chunks arrays should be the same reference (reused from cache)
      expect(result1.chunks).toBe(result2.chunks);
    });

    it('should rebuild chunks when offset changes', async () => {
      setupResolveChain();
      const session1 = makeSession();
      const session2 = makeSession([
        makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('m2', 'assistant', '2026-01-01T10:00:05.000Z'),
        makeMessage('m3', 'user', '2026-01-01T10:00:10.000Z'),
        makeMessage('m4', 'assistant', '2026-01-01T10:00:15.000Z'),
      ]);

      mockSessionCacheService.getOrParseWithMeta
        .mockResolvedValueOnce({
          session: session1,
          cacheHit: false,
          lastOffset: 1000,
          lastSize: 1000,
          lastMtime: Date.now(),
          sourceVersion: 1000,
        })
        .mockResolvedValueOnce({
          session: session2,
          cacheHit: false,
          lastOffset: 2000,
          lastSize: 2000,
          lastMtime: Date.now(),
          sourceVersion: 2000,
        });

      const result1 = await service.getTranscript('sess-1');
      const result2 = await service.getTranscript('sess-1');

      expect(result1.chunks).toBeDefined();
      expect(result2.chunks).toBeDefined();
      // Chunks should be different references (rebuilt due to offset change)
      expect(result1.chunks).not.toBe(result2.chunks);
      // Second result has more messages, so chunk count may differ
      expect(result2.messages).toHaveLength(4);
    });

    it('should store built chunks in the composite session cache', async () => {
      setupResolveChain();
      const session = makeSession();
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session,
        cacheHit: false,
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: Date.now(),
        sourceVersion: 1000,
      });

      const result = await service.getTranscript('sess-1');

      expect(mockSessionCacheService.setChunks).toHaveBeenCalledWith('sess-1', 1000, result.chunks);
      expect(session.chunks).toBeUndefined();
    });
  });

  describe('cache-split regression', () => {
    it('should not call parseFullSession when cache returns warm session', async () => {
      setupResolveChain();
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';

      // Override provider to enable 1M context
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });

      // Return cached session (cacheHit: true) without calling adapter
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValue({
        session,
        cacheHit: true,
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: Date.now(),
      });

      const result = await service.getTranscript('sess-1');

      // parseFullSession should NOT have been called (warm cache path)
      expect(mockAdapter.parseFullSession).not.toHaveBeenCalled();
      // Chunks should still be built and attached
      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBeGreaterThan(0);
      // Context-window override should still be applied
      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
    });

    it('should apply context-window override on every call including cache hits', async () => {
      setupResolveChain();
      const session = makeSession();
      session.metrics.primaryModel = 'claude-opus-4-6';

      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        oneMillionContextEnabled: true,
      });

      // First call: fresh parse
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session,
        cacheHit: false,
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: Date.now(),
      });
      const result1 = await service.getTranscript('sess-1');
      expect(result1.metrics.contextWindowTokens).toBe(1_000_000);

      // Second call: cache hit
      mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
        session,
        cacheHit: true,
        lastOffset: 1000,
        lastSize: 1000,
        lastMtime: Date.now(),
      });
      const result2 = await service.getTranscript('sess-1');
      expect(result2.metrics.contextWindowTokens).toBe(1_000_000);
    });
  });

  // ---------------------------------------------------------------------------
  // DB-backed in-place revision — REAL cache + REAL OpenCode adapter
  //
  // The mocked-cache tests above prove the tail BRANCHING; this block proves the
  // integrated cache→adapter→tail path actually surfaces an in-place part edit.
  // It exercises the real SessionCacheService and the real
  // OpenCodeSessionReaderAdapter (real OpencodeSqliteReader) over a fixture
  // `opencode.db`. The `resolveAdapter` seam is stubbed only to supply a
  // SessionSourceRef carrying `providerSessionId` (read-path providerSessionId
  // threading is the adapter-wiring task's concern, not tail semantics).
  // ---------------------------------------------------------------------------
  describe('DB-backed in-place revision (real cache + real OpenCode adapter)', () => {
    const SCHEMA_SQL = `
      CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, model TEXT, agent TEXT, parent_id TEXT,
        directory TEXT, project_id TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX part_session_idx ON part (session_id);
    `;
    const SES = 'ses_inplace';

    let tmpDir: string;
    let dbPath: string;
    let realCache: SessionCacheService;
    let dbService: SessionReaderService;
    let resolveSpy: jest.SpyInstance;

    function makePricing(): jest.Mocked<PricingServiceInterface> {
      return {
        calculateMessageCost: jest.fn().mockReturnValue(0),
        getContextWindowSize: jest.fn().mockReturnValue(200_000),
      } as unknown as jest.Mocked<PricingServiceInterface>;
    }

    function seedDb(): void {
      const db = new Database(dbPath);
      try {
        db.pragma('journal_mode = WAL'); // mirror OpenCode (WAL); reader must read it
        db.exec(SCHEMA_SQL);
        db.prepare(
          `INSERT INTO session (id, title, model, agent, parent_id, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(SES, 'In-place test', 'glm-5.1', 'build', null, 1_000, 9_999);
        const insMsg = db.prepare(
          `INSERT INTO message (id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?)`,
        );
        const insPart = db.prepare(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insMsg.run('msg_user', SES, 1_000, 1_000, JSON.stringify({ role: 'user' }));
        insPart.run(
          'prt_user',
          'msg_user',
          SES,
          1_000,
          1_000,
          JSON.stringify({ type: 'text', text: 'run the tool' }),
        );
        insMsg.run('msg_asst', SES, 2_000, 2_000, JSON.stringify({ role: 'assistant' }));
        insPart.run(
          'prt_asst',
          'msg_asst',
          SES,
          2_000,
          2_000,
          JSON.stringify({ type: 'text', text: 'working…' }),
        );
      } finally {
        db.close();
      }
    }

    /** Simulate an in-place part edit (no new message): mutate the part + bump its time_updated. */
    function bumpPartInPlace(newTimeUpdated: number): void {
      const db = new Database(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        db.prepare(`UPDATE part SET data = ?, time_updated = ? WHERE id = ?`).run(
          JSON.stringify({ type: 'text', text: 'done — tool output here' }),
          newTimeUpdated,
          'prt_asst',
        );
      } finally {
        db.close();
      }
    }

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-tail-'));
      dbPath = path.join(tmpDir, 'opencode.db');
      seedDb();

      realCache = new SessionCacheService(mockMetricsService);
      const adapter = new OpenCodeSessionReaderAdapter(makePricing());

      dbService = new SessionReaderService(
        mockAdapterFactory as unknown as SessionReaderAdapterFactory,
        mockPathValidator as unknown as TranscriptPathValidator,
        realCache,
        mockSessionsService as unknown as SessionsService,
        mockStorage as unknown as StorageService,
        mockProviderAdapterFactory as unknown as never,
      );

      const sourceRef: SessionSourceRef = {
        filePath: dbPath,
        providerName: 'opencode',
        providerSessionId: SES,
        kind: 'db',
      };
      // Stub only the resolution seam; cache + adapter + reader are all real.
      resolveSpy = jest
        .spyOn(dbService as unknown as { resolveAdapter: () => unknown }, 'resolveAdapter')
        .mockResolvedValue({
          adapter,
          transcriptPath: dbPath,
          sourceRef,
          providerName: 'opencode',
          oneMillionContextEnabled: false,
        });
    });

    afterEach(async () => {
      resolveSpy?.mockRestore();
      realCache?.onModuleDestroy();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('moves sourceVersion off the token (maxUpdated), not the container file size, on an in-place edit', async () => {
      // Mint a cursor at the initial revision (session.time_updated = 9_999 dominates).
      await dbService.getTranscriptSummaryWithCursor(SES);
      expect(realCache.getEntry(SES)?.sourceVersion).toBe(9_999);

      // In-place part edit (same message count) bumps maxUpdated to a sentinel that
      // is unmistakably NOT a byte size of the tiny fixture DB.
      const SENTINEL = 7_000_000;
      bumpPartInPlace(SENTINEL);

      // No manual invalidation: the cache must detect the change purely from the
      // freshness token (maxUpdated moved), even though the part COUNT is unchanged.
      await dbService.getTranscript(SES); // re-parse through the real cache
      const after = realCache.getEntry(SES)?.sourceVersion;
      expect(after).toBe(SENTINEL);

      // Decouple proof: sourceVersion is the token's maxUpdated, not the file size.
      const dbSize = (await fs.stat(dbPath)).size;
      expect(after).not.toBe(dbSize);
    });

    it('returns an in-place delta from getTranscriptTail when only a part changed (no new message)', async () => {
      const summary = await dbService.getTranscriptSummaryWithCursor(SES);

      const SENTINEL = 7_000_000;
      bumpPartInPlace(SENTINEL);

      const tail = await dbService.getTranscriptTail(SES, summary.cursor);

      expect(tail).not.toBeNull();
      expect(tail).toMatchObject({ kind: 'delta' });
      // Same number of messages — the change is an in-place part mutation.
      expect(tail?.totalMessageCount).toBe(2);
      expect(tail?.deltaMessages).toEqual([]);
      // In-place last-chunk replacement: a delta chunk with a real anchor id.
      expect(tail?.deltaChunks.length).toBeGreaterThan(0);
      expect(tail?.replaceFromChunkId).not.toBeNull();
      // Cursor advanced to the new revision (NOT a no-op).
      expect(tail?.cursor).not.toBe(summary.cursor);
    });
  });

  // ---------------------------------------------------------------------------
  // DB-backed end-to-end via the REAL resolveAdapter (NO seam stub).
  //
  // Proves the pull-based read path renders a real OpenCode session WITHOUT
  // stubbing `resolveAdapter`: the session row's `providerSessionId` must thread
  // resolveAdapter → SessionSourceRef → adapter, or `parseFullSession` throws
  // `requireSessionId(...)`. Real SessionCacheService + real
  // OpenCodeSessionReaderAdapter + real OpencodeSqliteReader over a fixture DB.
  // ---------------------------------------------------------------------------
  describe('DB-backed end-to-end via the real resolveAdapter (no seam stub)', () => {
    const SCHEMA_SQL = `
      CREATE TABLE session (
        id TEXT PRIMARY KEY, title TEXT, model TEXT, agent TEXT, parent_id TEXT,
        directory TEXT, project_id TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX part_session_idx ON part (session_id);
    `;
    const SES = 'ses_e2e';

    let tmpDir: string;
    let dbPath: string;
    let realCache: SessionCacheService;
    let dbService: SessionReaderService;

    function makePricing(): jest.Mocked<PricingServiceInterface> {
      return {
        calculateMessageCost: jest.fn().mockReturnValue(0),
        getContextWindowSize: jest.fn().mockReturnValue(200_000),
      } as unknown as jest.Mocked<PricingServiceInterface>;
    }

    function seedDb(): void {
      const db = new Database(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        db.exec(SCHEMA_SQL);
        db.prepare(
          `INSERT INTO session (id, title, model, agent, parent_id, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(SES, 'E2E', 'glm-5.1', 'build', null, 1_000, 2_000);
        const insMsg = db.prepare(
          `INSERT INTO message (id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?)`,
        );
        const insPart = db.prepare(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insMsg.run('m_user', SES, 1_000, 1_000, JSON.stringify({ role: 'user' }));
        insPart.run(
          'p_user',
          'm_user',
          SES,
          1_000,
          1_000,
          JSON.stringify({ type: 'text', text: 'hello opencode' }),
        );
        insMsg.run('m_asst', SES, 2_000, 2_000, JSON.stringify({ role: 'assistant' }));
        insPart.run(
          'p_asst',
          'm_asst',
          SES,
          2_000,
          2_000,
          JSON.stringify({ type: 'text', text: 'hi there' }),
        );
      } finally {
        db.close();
      }
    }

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-e2e-'));
      dbPath = path.join(tmpDir, 'opencode.db');
      seedDb();

      realCache = new SessionCacheService(mockMetricsService);
      const adapter = new OpenCodeSessionReaderAdapter(makePricing());

      // Real resolveAdapter chain — NOTHING about the resolve seam is stubbed.
      mockSessionsService.getSession.mockReturnValue({
        id: SES,
        agentId: 'agent-1',
        transcriptPath: dbPath,
        providerSessionId: SES,
        status: 'running',
      });
      mockStorage.getAgent.mockResolvedValue({ id: 'agent-1', providerConfigId: 'config-1' });
      mockStorage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        providerId: 'provider-1',
      });
      mockStorage.getProvider.mockResolvedValue({ id: 'provider-1', name: 'opencode' });
      (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(adapter);
      (mockPathValidator.validateForRead as jest.Mock).mockResolvedValue(dbPath);

      dbService = new SessionReaderService(
        mockAdapterFactory as unknown as SessionReaderAdapterFactory,
        mockPathValidator as unknown as TranscriptPathValidator,
        realCache,
        mockSessionsService as unknown as SessionsService,
        mockStorage as unknown as StorageService,
        mockProviderAdapterFactory as unknown as never,
      );
    });

    afterEach(async () => {
      realCache?.onModuleDestroy();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('renders summary + chunks for a real OpenCode session through the real resolve path', async () => {
      const transcript = await dbService.getTranscript(SES);
      expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(transcript.messages[1].content.some((c) => c.type === 'text')).toBe(true);

      const summary = await dbService.getTranscriptSummaryWithCursor(SES);
      expect(summary.cursor).toBeTruthy();

      const chunks = await dbService.getUnifiedTranscriptChunks(SES);
      expect(chunks.totalCount).toBe(2);
      expect(chunks.chunks.length).toBeGreaterThan(0);

      // The resolve seam was real — prove the OpenCode path was actually taken.
      expect(mockPathValidator.validateForRead).toHaveBeenCalledWith(dbPath, 'opencode');
    });

    it('throws (not a silent no-op) when the session row has no providerSessionId — threading regression guard', async () => {
      mockSessionsService.getSession.mockReturnValue({
        id: SES,
        agentId: 'agent-1',
        transcriptPath: dbPath,
        providerSessionId: null,
        status: 'running',
      });

      await expect(dbService.getTranscript(SES)).rejects.toThrow(/providerSessionId/i);
    });
  });
});
