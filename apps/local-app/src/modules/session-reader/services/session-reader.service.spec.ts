import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionReaderService } from './session-reader.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { SessionCacheService } from './session-cache.service';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import type { PricingServiceInterface } from './pricing.interface';

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
};

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
}

describe('SessionReaderService', () => {
  let service: SessionReaderService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionReaderService(
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockPathValidator as unknown as TranscriptPathValidator,
      mockSessionsService as unknown as SessionsService,
      mockStorage as unknown as StorageService,
    );
  });

  describe('getTranscript', () => {
    it('should return full session when resolution succeeds', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1');

      expect(result).toBe(session);
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
  });

  describe('getTranscriptSummary', () => {
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
      const incrementalCache = new SessionCacheService();

      const cacheBackedAdapter = {
        providerName: 'claude',
        parseFullSession: (targetPath: string) =>
          incrementalCache.getOrParse('sess-1', targetPath, realClaudeAdapter),
      } as Pick<typeof mockAdapter, 'providerName' | 'parseFullSession'>;

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
      (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(cacheBackedAdapter);
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

        // Clear SessionReaderService cache to force a second parse pass.
        (service as unknown as { transcriptCache: Map<string, unknown> }).transcriptCache.clear();

        const secondSummary = await service.getTranscriptSummary('sess-1');
        // Delta slice had no assistant usage snapshot, so existing value is preserved.
        expect(secondSummary.metrics.totalContextTokens).toBe(140);
        // Recomputed from merged messages: hello(2) + hi there!(3) + follow up(3).
        expect(secondSummary.metrics.visibleContextTokens).toBe(8);
      } finally {
        incrementalCache.onModuleDestroy();
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

  describe('getTranscriptChunks', () => {
    it('should return paginated chunks', async () => {
      setupResolveChain();
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage(
          `m${i}`,
          i % 2 === 0 ? 'user' : 'assistant',
          `2026-01-01T10:00:${String(i * 5).padStart(2, '0')}.000Z`,
        ),
      );
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptChunks('sess-1', undefined, 2);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].chunkId).toBe('chunk-0');
      expect(result.chunks[0].messageCount).toBe(2);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('1');
      expect(result.totalChunks).toBe(3); // 5 messages / 2 per chunk = 3
    });

    it('should respect cursor for pagination', async () => {
      setupResolveChain();
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage(
          `m${i}`,
          i % 2 === 0 ? 'user' : 'assistant',
          `2026-01-01T10:00:${String(i * 5).padStart(2, '0')}.000Z`,
        ),
      );
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptChunks('sess-1', '2', 2);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].chunkId).toBe('chunk-2');
      expect(result.chunks[0].messageCount).toBe(1); // last chunk has 1 message
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('should throw ValidationError for invalid cursor', async () => {
      await expect(service.getTranscriptChunks('sess-1', 'invalid', 20)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('getTranscriptChunk', () => {
    it('should return a single chunk by ID', async () => {
      setupResolveChain();
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage(
          `m${i}`,
          i % 2 === 0 ? 'user' : 'assistant',
          `2026-01-01T10:00:${String(i * 5).padStart(2, '0')}.000Z`,
        ),
      );
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      const result = await service.getTranscriptChunk('sess-1', 'chunk-1', 2);

      expect(result.chunkId).toBe('chunk-1');
      expect(result.index).toBe(1);
      expect(result.messageCount).toBe(2);
    });

    it('should throw ValidationError for invalid chunkId format', async () => {
      await expect(service.getTranscriptChunk('sess-1', 'bad-format', 20)).rejects.toThrow(
        ValidationError,
      );
    });

    it('should throw NotFoundError for out-of-range chunk', async () => {
      setupResolveChain();
      const messages = [makeMessage('m1', 'user', '2026-01-01T10:00:00.000Z')];
      mockAdapter.parseFullSession.mockResolvedValue(makeSession(messages));

      await expect(service.getTranscriptChunk('sess-1', 'chunk-99', 20)).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('transcript cache', () => {
    it('should not re-parse on second call within TTL (cache hit)', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result1 = await service.getTranscript('sess-1');
      const result2 = await service.getTranscript('sess-1');

      expect(result1).toBe(session);
      expect(result2).toBe(session);
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
    });

    it('should re-parse after TTL expires', async () => {
      setupResolveChain();
      const session1 = makeSession();
      const session2 = makeSession([makeMessage('m10', 'user', '2026-01-01T11:00:00.000Z')]);

      mockAdapter.parseFullSession.mockResolvedValueOnce(session1);
      mockAdapter.parseFullSession.mockResolvedValueOnce(session2);

      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_700_000_000_000;
      nowSpy.mockReturnValue(baseTime);

      const result1 = await service.getTranscript('sess-1');
      expect(result1).toBe(session1);

      // Advance past 30s TTL
      nowSpy.mockReturnValue(baseTime + 31_000);

      const result2 = await service.getTranscript('sess-1');
      expect(result2).toBe(session2);
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });

    it('should use longer TTL for large sessions', async () => {
      setupResolveChain();
      const largeMessages = Array.from({ length: 1001 }, (_, i) =>
        makeMessage(
          `m${i}`,
          i % 2 === 0 ? 'user' : 'assistant',
          `2026-01-01T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        ),
      );
      const session1 = makeSession(largeMessages);
      const session2 = makeSession([
        ...largeMessages,
        makeMessage('m1001', 'assistant', '2026-01-01T11:00:00.000Z'),
      ]);

      mockAdapter.parseFullSession.mockResolvedValueOnce(session1);
      mockAdapter.parseFullSession.mockResolvedValueOnce(session2);

      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_700_000_000_000;
      nowSpy.mockReturnValue(baseTime);

      const result1 = await service.getTranscript('sess-1');
      expect(result1).toBe(session1);

      // Large-session TTL should still be valid at +31s
      nowSpy.mockReturnValue(baseTime + 31_000);
      const result2 = await service.getTranscript('sess-1');
      expect(result2).toBe(session1);
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);

      // Large-session TTL should expire after +120s
      nowSpy.mockReturnValue(baseTime + 121_000);
      const result3 = await service.getTranscript('sess-1');
      expect(result3).toBe(session2);
      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });

    it('should share cache between getTranscript and getTranscriptChunks', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      await service.getTranscript('sess-1');
      await service.getTranscriptChunks('sess-1', undefined, 2);

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
    });

    it('should share cache between getTranscript and getTranscriptSummary', async () => {
      setupResolveChain();
      const session = makeSession();
      mockAdapter.parseFullSession.mockResolvedValue(session);

      await service.getTranscript('sess-1');
      const summary = await service.getTranscriptSummary('sess-1');

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(1);
      expect(summary.providerName).toBe('claude');
      expect(summary.messageCount).toBe(3);
    });

    it('should evict oldest entry when cache exceeds max size', async () => {
      setupResolveChain();

      // Fill cache to max (20 entries) by using different session IDs
      for (let i = 0; i < 20; i++) {
        const sessId = `sess-${i}`;
        mockSessionsService.getSession.mockReturnValue({
          id: sessId,
          agentId: 'agent-1',
          transcriptPath: '/home/user/.claude/projects/-test/session.jsonl',
          status: 'running',
        });
        mockAdapter.parseFullSession.mockResolvedValueOnce(makeSession());
        await service.getTranscript(sessId);
      }

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(20);

      // Add one more — should evict sess-0
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-new',
        agentId: 'agent-1',
        transcriptPath: '/home/user/.claude/projects/-test/session.jsonl',
        status: 'running',
      });
      mockAdapter.parseFullSession.mockResolvedValueOnce(makeSession());
      await service.getTranscript('sess-new');

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(21);

      // sess-0 was evicted — requesting it should trigger a new parse
      mockSessionsService.getSession.mockReturnValue({
        id: 'sess-0',
        agentId: 'agent-1',
        transcriptPath: '/home/user/.claude/projects/-test/session.jsonl',
        status: 'running',
      });
      mockAdapter.parseFullSession.mockResolvedValueOnce(makeSession());
      await service.getTranscript('sess-0');

      expect(mockAdapter.parseFullSession).toHaveBeenCalledTimes(22);
    });
  });
});
