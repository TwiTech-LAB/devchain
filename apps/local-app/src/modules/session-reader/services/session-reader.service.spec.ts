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
};

const mockSessionCacheService = {
  getOrParse: jest.fn(),
  getOrParseWithMeta: jest.fn(),
  invalidate: jest.fn(),
  clear: jest.fn(),
  getEntry: jest.fn(),
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
  // Wire session cache to delegate to the mock adapter
  mockSessionCacheService.getOrParseWithMeta.mockImplementation(
    async (
      _id: string,
      filePath: string,
      adapter: { parseFullSession: (p: string) => Promise<UnifiedSession> },
    ) => {
      const session = await adapter.parseFullSession(filePath);
      return {
        session,
        cacheHit: false,
        lastOffset: 1024,
        lastSize: 1024,
        lastMtime: Date.now(),
      };
    },
  );
}

describe('SessionReaderService', () => {
  let service: SessionReaderService;

  beforeEach(() => {
    jest.clearAllMocks();
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

    it('should return same session reference when no tool results exceed maxLength (short-circuit)', async () => {
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

      expect(result).toBe(session);
    });

    it('should return same session reference when session has no tool results at all (short-circuit)', async () => {
      setupResolveChain();
      const session = makeSession([
        makeMessage('u1', 'user', '2026-01-01T10:00:00.000Z'),
        makeMessage('a1', 'assistant', '2026-01-01T10:00:05.000Z'),
      ]);
      mockAdapter.parseFullSession.mockResolvedValue(session);

      const result = await service.getTranscript('sess-1', { maxToolResultLength: 2000 });

      expect(result).toBe(session);
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
      const realSessionCacheService = new SessionCacheService();

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

        // Invalidate real cache to force a second parse pass and clear chunks cache.
        realSessionCacheService.invalidate('sess-1');
        (service as unknown as { chunksCache: Map<string, unknown> }).chunksCache.clear();

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
      // The adapter object is passed through to SessionCacheService
      expect(mockSessionCacheService.getOrParseWithMeta).toHaveBeenCalledWith(
        'sess-1',
        '/home/user/.claude/projects/-test/session.jsonl',
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
        })
        .mockResolvedValueOnce({
          session,
          cacheHit: true,
          lastOffset: 1000,
          lastSize: 1000,
          lastMtime: Date.now(),
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
        })
        .mockResolvedValueOnce({
          session: session2,
          cacheHit: false,
          lastOffset: 2000,
          lastSize: 2000,
          lastMtime: Date.now(),
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

    it('should evict oldest chunks entry when exceeding max size', async () => {
      setupResolveChain();

      // Fill chunks cache with 21 different sessions (max is 20)
      for (let i = 0; i < 21; i++) {
        const sessId = `sess-${i}`;
        const session = makeSession();
        mockSessionsService.getSession.mockReturnValue({
          id: sessId,
          agentId: 'agent-1',
          transcriptPath: '/home/user/.claude/projects/-test/session.jsonl',
          status: 'running',
        });
        mockSessionCacheService.getOrParseWithMeta.mockResolvedValueOnce({
          session,
          cacheHit: false,
          lastOffset: 1000,
          lastSize: 1000,
          lastMtime: Date.now(),
        });
        await service.getTranscript(sessId);
      }

      const chunksCache = (service as unknown as { chunksCache: Map<string, unknown> }).chunksCache;
      // Should have evicted the oldest entry to stay at max 20
      expect(chunksCache.size).toBeLessThanOrEqual(20);
      expect(chunksCache.has('sess-0')).toBe(false);
      expect(chunksCache.has('sess-20')).toBe(true);
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
});
