import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCodexJsonl } from '../parsers/codex-jsonl.parser';
import { parseCopilotJsonl } from '../parsers/copilot-jsonl.parser';
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import { CodexSessionReaderAdapter } from '../adapters/codex-session-reader.adapter';
import { CopilotSessionReaderAdapter } from '../adapters/copilot-session-reader.adapter';
import { AntigravitySessionReaderAdapter } from '../adapters/antigravity-session-reader.adapter';
import { createAntigravityFixtureDb } from '../__fixtures__/antigravity-fixture-db';

/**
 * End-to-end integration tests for the multi-provider session reader pipeline.
 * Tests the full flow: fixture file → parser → UnifiedSession/UnifiedMetrics.
 * Adapter summaries are compared with full fixture parsing.
 */

const FIXTURES_DIR = path.join(__dirname, '..', '__fixtures__');

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.005),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

describe('Adapter getSummary parity: file providers', () => {
  it.each([
    ['claude', ClaudeSessionReaderAdapter, 'simple-session.jsonl'],
    ['codex', CodexSessionReaderAdapter, 'codex-rollout.jsonl'],
    ['copilot', CopilotSessionReaderAdapter, 'copilot-events-multiturn.jsonl'],
  ] as const)(
    '%s summary metrics match a full fixture parse',
    async (providerName, Adapter, file) => {
      const adapter: SessionReaderAdapter = new Adapter(mockPricing);
      const filePath = path.join(FIXTURES_DIR, file);
      const full = await adapter.parseFullSession(filePath);
      const summary = await adapter.getSummary?.({
        filePath,
        providerName,
        kind: 'file',
      });

      expect(summary?.metrics).toEqual(full.metrics);
      expect(summary?.approximateFields).toBeUndefined();
    },
  );
});

describe('Adapter getSummary parity: Antigravity DB fixture', () => {
  it('matches every field declared exact without reading transcript messages for the summary', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-summary-parity-'));
    const convId = 'conv_summary_fixture';
    const dbPath = path.join(tmpDir, 'conversations', `${convId}.db`);
    const transcriptPath = path.join(
      tmpDir,
      'brain',
      convId,
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );

    try {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      createAntigravityFixtureDb(dbPath, convId, [
        { input: 120, output: 30 },
        { input: 80, output: 20 },
      ]);
      await fs.copyFile(
        path.join(FIXTURES_DIR, 'antigravity-transcript_full.jsonl'),
        transcriptPath,
      );

      const adapter = new AntigravitySessionReaderAdapter(mockPricing);
      const sourceRef = {
        filePath: dbPath,
        providerName: 'agy',
        providerSessionId: convId,
        kind: 'db' as const,
      };
      const full = await adapter.parseFullSession(dbPath, sourceRef);
      const summary = await adapter.getSummary(sourceRef);

      for (const field of summary.exactFields) {
        expect(summary.metrics[field]).toEqual(full.metrics[field]);
      }
      expect(summary.approximateFields).toContain('messageCount');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

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

  it('should extract cumulative token metrics', async () => {
    const result = await parseCodexJsonl(filePath);

    expect(result.metrics.inputTokens).toBe(650);
    // output + reasoning: 120 + 45 = 165
    expect(result.metrics.outputTokens).toBe(165);
    expect(result.metrics.cacheReadTokens).toBe(200);
  });

  it.each([
    ['claude', parseClaudeJsonl, 'simple-session.jsonl'],
    ['codex', parseCodexJsonl, 'codex-rollout.jsonl'],
    ['copilot', parseCopilotJsonl, 'copilot-events-multiturn.jsonl'],
  ] as const)('%s metrics-only scan retains no messages', async (_provider, parse, file) => {
    const filePath = path.join(FIXTURES_DIR, file);
    const full = await parse(filePath, { pricingService: mockPricing });
    const summaryOnly = await parse(filePath, {
      pricingService: mockPricing,
      retainMessages: false,
    });

    expect(summaryOnly.messages).toEqual([]);
    expect(summaryOnly.metrics).toEqual(full.metrics);
  });
});
