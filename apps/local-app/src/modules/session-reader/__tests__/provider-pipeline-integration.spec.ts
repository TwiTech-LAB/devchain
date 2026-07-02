import * as path from 'node:path';
import { parseCodexJsonl } from '../parsers/codex-jsonl.parser';
import { parseCopilotJsonl } from '../parsers/copilot-jsonl.parser';
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

  it('should parse the fixture and coalesce the tool turn into one assistant', async () => {
    const result = await parseCodexJsonl(filePath, { pricingService: mockPricing });

    // Fixture is ONE turn (task_started→task_complete) with 2 tool rounds. It coalesces to
    // user + a single assistant carrying both rounds (reasoning, texts, 2 calls, 2 results).
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // First message is the user prompt.
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'Fix the bug in auth.ts',
    });

    // The single assistant carries both rounds' tool calls + results (no data loss).
    const assistant = result.messages[1];
    expect(assistant.toolCalls.map((c) => c.id)).toEqual(['call_001', 'call_002']);
    expect(assistant.toolResults.map((r) => r.toolCallId)).toEqual(['call_001', 'call_002']);
    // No synthetic user-role tool-result message.
    expect(result.messages.filter((m) => m.role === 'user')).toHaveLength(1);
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
// Copilot pipeline integration (fixture captured in S3)
// ---------------------------------------------------------------------------

describe('Copilot pipeline: fixture → parser → unified model', () => {
  const filePath = path.join(FIXTURES_DIR, 'copilot-events-multiturn.jsonl');

  it('should parse the multi-turn fixture (2 user + 2 coalesced assistant turns)', async () => {
    const result = await parseCopilotJsonl(filePath);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(result.metrics.messageCount).toBe(4);
  });

  it('should coalesce the tool turn (call + result + final text) into one assistant', async () => {
    const result = await parseCopilotJsonl(filePath);
    const toolTurn = result.messages[3];
    expect(toolTurn.role).toBe('assistant');
    expect(toolTurn.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolTurn.toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolTurn.toolResults.every((r) => r.isError === false)).toBe(true);
  });

  it('should skip the system prompt (not counted as a conversational turn)', async () => {
    const result = await parseCopilotJsonl(filePath);
    expect(result.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('should track the model id from session.shutdown', async () => {
    const result = await parseCopilotJsonl(filePath);
    expect(result.metrics.primaryModel).toBe('claude-haiku-4.5');
  });

  it('should SUM session.shutdown totals across the resume (each run is separately billed)', async () => {
    const result = await parseCopilotJsonl(filePath);
    expect(result.metrics.isOngoing).toBe(false);
    // The fixture has two shutdowns (run1 + resumed run2); per-run usage is summed, not final-wins.
    expect(result.metrics.inputTokens).toBe(15148 + 30769);
    expect(result.metrics.outputTokens).toBe(63 + 271);
    // Native AI-Credits preserved alongside USD (0.33 + 0.33).
    expect(result.metrics.nativeCost).toBeCloseTo(0.66, 5);
  });

  it('should chain parentId across conversational messages', async () => {
    const result = await parseCopilotJsonl(filePath);
    expect(result.messages[0].parentId).toBeNull();
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].parentId).toBe(result.messages[i - 1].id);
    }
  });
});

// ---------------------------------------------------------------------------
// Factory selection → adapter pipeline
// ---------------------------------------------------------------------------

describe('Factory selection → adapter pipeline', () => {
  function makeMockAdapter(name: string, roots: string[]): SessionReaderAdapter {
    return {
      providerName: name,
      incrementalMode: name === 'copilot' ? 'snapshot' : 'delta',
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
    const copilot = makeMockAdapter('copilot', ['/home/user/.copilot/']);

    factory.registerAdapter(claude);
    factory.registerAdapter(codex);
    factory.registerAdapter(copilot);

    expect(factory.getAdapter('claude')).toBe(claude);
    expect(factory.getAdapter('codex')).toBe(codex);
    expect(factory.getAdapter('copilot')).toBe(copilot);
  });

  it('should resolve adapter by path when provider is unknown', () => {
    const factory = new SessionReaderAdapterFactory();
    const claude = makeMockAdapter('claude', ['/home/user/.claude/projects/']);
    const codex = makeMockAdapter('codex', ['/home/user/.codex/sessions/']);
    const copilot = makeMockAdapter('copilot', ['/home/user/.copilot/']);

    factory.registerAdapter(claude);
    factory.registerAdapter(codex);
    factory.registerAdapter(copilot);

    const claudePath = '/home/user/.claude/projects/abc/session.jsonl';
    const codexPath = '/home/user/.codex/sessions/2026/01/01/rollout.jsonl';
    const copilotPath = '/home/user/.copilot/session-state/abc/events.jsonl';

    expect(factory.getAdapterForPath(claudePath)?.providerName).toBe('claude');
    expect(factory.getAdapterForPath(codexPath)?.providerName).toBe('codex');
    expect(factory.getAdapterForPath(copilotPath)?.providerName).toBe('copilot');
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
    factory.registerAdapter(makeMockAdapter('copilot', []));

    const providers = factory.getSupportedProviders();
    expect(providers).toHaveLength(3);
    expect(providers).toEqual(expect.arrayContaining(['claude', 'codex', 'copilot']));
  });

  it('should return undefined for unsupported provider', () => {
    const factory = new SessionReaderAdapterFactory();
    expect(factory.getAdapter('unknown-provider')).toBeUndefined();
    expect(factory.getAdapterForPath('/home/user/.unknown/file.json')).toBeUndefined();
  });
});
