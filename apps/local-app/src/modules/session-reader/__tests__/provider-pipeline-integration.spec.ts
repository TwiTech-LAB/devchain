import * as path from 'node:path';
import { parseCodexJsonl } from '../parsers/codex-jsonl.parser';
import { parseGeminiJson } from '../parsers/gemini-json.parser';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';
import type { PricingServiceInterface } from '../services/pricing.interface';

/**
 * End-to-end integration tests for the multi-provider session reader pipeline.
 * Tests the full flow: fixture file → parser → UnifiedSession/UnifiedMetrics.
 * Also tests: factory selection → adapter parse → cost calculation.
 */

const FIXTURES_DIR = path.join(__dirname, '..', '__fixtures__');

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.005),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

// ---------------------------------------------------------------------------
// Codex pipeline integration
// ---------------------------------------------------------------------------

describe('Codex pipeline: fixture → parser → unified model', () => {
  const filePath = path.join(FIXTURES_DIR, 'codex-rollout.jsonl');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should parse the fixture and produce valid messages', async () => {
    const result = await parseCodexJsonl(filePath, { pricingService: mockPricing });

    // Fixture has: user msg, reasoning+assistant, function_call+output, assistant, function_call+output, assistant
    expect(result.messages.length).toBeGreaterThanOrEqual(4);

    // First message should be user
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'Fix the bug in auth.ts',
    });
  });

  it('should extract session ID from fixture', async () => {
    const result = await parseCodexJsonl(filePath);
    expect(result.sessionId).toBe('codex-test-session-001');
  });

  it('should track model from turn_context', async () => {
    const result = await parseCodexJsonl(filePath);
    expect(result.metrics.primaryModel).toBe('o3');
  });

  it('should extract cumulative token metrics', async () => {
    const result = await parseCodexJsonl(filePath);

    expect(result.metrics.inputTokens).toBe(650);
    // output + reasoning: 120 + 45 = 165
    expect(result.metrics.outputTokens).toBe(165);
    expect(result.metrics.cacheReadTokens).toBe(200);
  });

  it('should map function calls to tool calls', async () => {
    const result = await parseCodexJsonl(filePath);

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    const allToolCalls = assistantMsgs.flatMap((m) => m.toolCalls);

    expect(allToolCalls.length).toBeGreaterThanOrEqual(2);
    expect(allToolCalls.find((tc) => tc.name === 'read_file')).toBeDefined();
    expect(allToolCalls.find((tc) => tc.name === 'write_file')).toBeDefined();
  });

  it('should include reasoning/thinking content', async () => {
    const result = await parseCodexJsonl(filePath);

    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
    const thinkingBlocks = assistantMsgs.flatMap((m) =>
      m.content.filter((c) => c.type === 'thinking'),
    );

    expect(thinkingBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect session as completed (not ongoing)', async () => {
    const result = await parseCodexJsonl(filePath);
    expect(result.metrics.isOngoing).toBe(false);
  });

  it('should calculate duration from timestamps', async () => {
    const result = await parseCodexJsonl(filePath);
    // From 10:00:00 to 10:00:17 = 17000ms
    expect(result.metrics.durationMs).toBe(17_000);
  });

  it('should chain parentId across messages', async () => {
    const result = await parseCodexJsonl(filePath);

    expect(result.messages[0].parentId).toBeNull();
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].parentId).toBe(result.messages[i - 1].id);
    }
  });

  it('should invoke pricing service for cost calculation', async () => {
    await parseCodexJsonl(filePath, { pricingService: mockPricing });
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith('o3', 650, 165, 200, 0);
  });
});

// ---------------------------------------------------------------------------
// Gemini pipeline integration
// ---------------------------------------------------------------------------

describe('Gemini pipeline: fixture → parser → unified model', () => {
  const filePath = path.join(FIXTURES_DIR, 'gemini-session.json');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should parse the fixture and produce valid messages', async () => {
    const result = await parseGeminiJson(filePath, { pricingService: mockPricing });

    // Fixture has: user, gemini(+tool), gemini(+tool), info, user, gemini
    expect(result.messages).toHaveLength(6);
  });

  it('should extract session ID', async () => {
    const result = await parseGeminiJson(filePath);
    expect(result.sessionId).toBe('gemini-test-session-001');
  });

  it('should map message roles correctly', async () => {
    const result = await parseGeminiJson(filePath);

    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('assistant');
    expect(result.messages[3].role).toBe('system'); // info message
    expect(result.messages[4].role).toBe('user');
    expect(result.messages[5].role).toBe('assistant');
  });

  it('should track model as gemini-2.5-pro', async () => {
    const result = await parseGeminiJson(filePath);
    expect(result.metrics.primaryModel).toBe('gemini-2.5-pro');
  });

  it('should aggregate token metrics across gemini messages', async () => {
    const result = await parseGeminiJson(filePath);

    // msg1: input=450, output=85, cached=100, thoughts=30
    // msg2: input=680, output=95, cached=200, thoughts=25
    // msg3: input=820, output=40, cached=350
    expect(result.metrics.inputTokens).toBe(450 + 680 + 820);
    // output includes thoughts: (85+30) + (95+25) + 40 = 275
    expect(result.metrics.outputTokens).toBe(275);
    expect(result.metrics.cacheReadTokens).toBe(100 + 200 + 350);
  });

  it('should map tool calls from gemini messages', async () => {
    const result = await parseGeminiJson(filePath);

    // First gemini message has read_file, second has edit_file
    expect(result.messages[1].toolCalls).toHaveLength(1);
    expect(result.messages[1].toolCalls[0].name).toBe('read_file');
    expect(result.messages[2].toolCalls).toHaveLength(1);
    expect(result.messages[2].toolCalls[0].name).toBe('edit_file');
  });

  it('should map tool results from function responses', async () => {
    const result = await parseGeminiJson(filePath);

    expect(result.messages[1].toolResults).toHaveLength(1);
    expect(result.messages[1].toolResults[0].content).toContain('validateToken');
    expect(result.messages[1].toolResults[0].isError).toBe(false);
  });

  it('should include thinking content from thoughts', async () => {
    const result = await parseGeminiJson(filePath);

    const thinkingBlocks = result.messages[1].content.filter((c) => c.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    if (thinkingBlocks[0].type === 'thinking') {
      expect(thinkingBlocks[0].thinking).toContain('Analyzing request');
    }
  });

  it('should mark info message as meta', async () => {
    const result = await parseGeminiJson(filePath);

    expect(result.messages[3].isMeta).toBe(true);
    expect(result.messages[3].content[0]).toEqual({
      type: 'text',
      text: 'Session checkpoint created',
    });
  });

  it('should calculate duration from startTime/lastUpdated', async () => {
    const result = await parseGeminiJson(filePath);
    // 10:00:00 to 10:02:30 = 150000ms
    expect(result.metrics.durationMs).toBe(150_000);
  });

  it('should chain parentId across messages', async () => {
    const result = await parseGeminiJson(filePath);

    expect(result.messages[0].parentId).toBeNull();
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].parentId).toBe(result.messages[i - 1].id);
    }
  });

  it('should preserve message IDs from fixture', async () => {
    const result = await parseGeminiJson(filePath);

    expect(result.messages[0].id).toBe('msg-user-001');
    expect(result.messages[1].id).toBe('msg-gemini-001');
  });

  it('should invoke pricing service for cost calculation', async () => {
    await parseGeminiJson(filePath, { pricingService: mockPricing });
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith(
      'gemini-2.5-pro',
      1950,
      275,
      650,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Factory selection → adapter pipeline
// ---------------------------------------------------------------------------

describe('Factory selection → adapter pipeline', () => {
  function makeMockAdapter(name: string, roots: string[]): SessionReaderAdapter {
    return {
      providerName: name,
      incrementalMode: name === 'gemini' ? 'snapshot' : 'delta',
      allowedRoots: roots,
      discoverSessionFile: jest.fn(),
      parseSessionFile: jest.fn().mockResolvedValue({
        hasMore: false,
        nextByteOffset: 100,
        messageCount: 1,
        entries: [],
      }),
      parseIncremental: jest.fn(),
      getWatchPaths: jest.fn().mockReturnValue(roots),
      calculateCost: jest.fn().mockReturnValue(0),
      parseFullSession: jest.fn(),
    };
  }

  it('should resolve correct adapter by provider name', () => {
    const factory = new SessionReaderAdapterFactory();
    const claude = makeMockAdapter('claude', ['/home/user/.claude/projects/']);
    const codex = makeMockAdapter('codex', ['/home/user/.codex/sessions/']);
    const gemini = makeMockAdapter('gemini', ['/home/user/.gemini/tmp/']);

    factory.registerAdapter(claude);
    factory.registerAdapter(codex);
    factory.registerAdapter(gemini);

    expect(factory.getAdapter('claude')).toBe(claude);
    expect(factory.getAdapter('codex')).toBe(codex);
    expect(factory.getAdapter('gemini')).toBe(gemini);
  });

  it('should resolve adapter by path when provider is unknown', () => {
    const factory = new SessionReaderAdapterFactory();
    const claude = makeMockAdapter('claude', ['/home/user/.claude/projects/']);
    const codex = makeMockAdapter('codex', ['/home/user/.codex/sessions/']);
    const gemini = makeMockAdapter('gemini', ['/home/user/.gemini/tmp/']);

    factory.registerAdapter(claude);
    factory.registerAdapter(codex);
    factory.registerAdapter(gemini);

    const claudePath = '/home/user/.claude/projects/abc/session.jsonl';
    const codexPath = '/home/user/.codex/sessions/2026/01/01/rollout.jsonl';
    const geminiPath = '/home/user/.gemini/tmp/my-project/chats/session.json';

    expect(factory.getAdapterForPath(claudePath)?.providerName).toBe('claude');
    expect(factory.getAdapterForPath(codexPath)?.providerName).toBe('codex');
    expect(factory.getAdapterForPath(geminiPath)?.providerName).toBe('gemini');
  });

  it('should call parseSessionFile on resolved adapter', async () => {
    const factory = new SessionReaderAdapterFactory();
    const codex = makeMockAdapter('codex', ['/home/user/.codex/sessions/']);
    factory.registerAdapter(codex);

    const adapter = factory.getAdapter('codex');
    expect(adapter).toBeDefined();

    await adapter!.parseSessionFile('/home/user/.codex/sessions/rollout.jsonl');
    expect(codex.parseSessionFile).toHaveBeenCalledWith('/home/user/.codex/sessions/rollout.jsonl');
  });

  it('should list all 3 supported providers', () => {
    const factory = new SessionReaderAdapterFactory();
    factory.registerAdapter(makeMockAdapter('claude', []));
    factory.registerAdapter(makeMockAdapter('codex', []));
    factory.registerAdapter(makeMockAdapter('gemini', []));

    const providers = factory.getSupportedProviders();
    expect(providers).toHaveLength(3);
    expect(providers).toEqual(expect.arrayContaining(['claude', 'codex', 'gemini']));
  });

  it('should return undefined for unsupported provider', () => {
    const factory = new SessionReaderAdapterFactory();
    expect(factory.getAdapter('unknown-provider')).toBeUndefined();
    expect(factory.getAdapterForPath('/home/user/.unknown/file.json')).toBeUndefined();
  });
});
