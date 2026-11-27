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
import { OpenCodeSessionReaderAdapter } from '../adapters/opencode-session-reader.adapter';
import { createOpencodeFixtureDb } from '../__fixtures__/opencode-fixture-db';
import {
  V2_FIXTURE_PROJECT,
  createOpencodeV2FixtureDb,
} from '../__fixtures__/opencode-v2-fixture-db';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { SessionCacheService } from '../services/session-cache.service';
import { SessionReaderService } from '../services/session-reader.service';
import type { TranscriptPathValidator } from '../services/transcript-path-validator.service';
import type { SessionsService } from '../../sessions/services/sessions.service';

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

describe('Tool result beyond the parse-time output cap', () => {
  const CAPPED_RESULT = `${'r'.repeat(100_000)}TAIL`;
  const TOOL_CALL_ID = 'call_capped';

  interface CappedSource {
    adapter: SessionReaderAdapter;
    dbPath: string;
    providerSessionId: string;
    toolCallId: string;
  }

  async function seedAgy(tmpDir: string): Promise<CappedSource> {
    const convId = 'conv_capped';
    const dbPath = path.join(tmpDir, 'conversations', `${convId}.db`);
    const logsDir = path.join(tmpDir, 'brain', convId, '.system_generated', 'logs');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    createAntigravityFixtureDb(dbPath, convId, [{ input: 10, output: 5 }]);
    const steps = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>run it</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: {} }] },
      { step_index: 2, type: 'RUN_COMMAND', status: 'DONE', content: CAPPED_RESULT },
    ];
    await fs.writeFile(
      path.join(logsDir, 'transcript_full.jsonl'),
      steps.map((step) => JSON.stringify(step)).join('\n'),
    );
    return {
      adapter: new AntigravitySessionReaderAdapter(mockPricing),
      dbPath,
      providerSessionId: convId,
      toolCallId: 'agy-tc-1-0',
    };
  }

  async function seedOpencodeV1(tmpDir: string): Promise<CappedSource> {
    const dbPath = path.join(tmpDir, 'opencode.db');
    createOpencodeFixtureDb(dbPath, [
      {
        id: 'ses_capped',
        messages: [
          {
            id: 'm_user',
            data: { role: 'user' },
            timeCreated: 1_000,
            parts: [{ id: 'p1', data: { type: 'text', text: 'run it' } }],
          },
          {
            id: 'm_asst',
            data: { role: 'assistant', modelID: 'glm-5.1' },
            timeCreated: 2_000,
            parts: [
              {
                id: 'p2',
                data: {
                  type: 'tool',
                  callID: TOOL_CALL_ID,
                  tool: 'bash',
                  state: { status: 'completed', input: {}, output: CAPPED_RESULT },
                },
              },
            ],
          },
        ],
      },
    ]);
    return {
      adapter: new OpenCodeSessionReaderAdapter(mockPricing),
      dbPath,
      providerSessionId: 'ses_capped',
      toolCallId: TOOL_CALL_ID,
    };
  }

  async function seedOpencodeV2(tmpDir: string): Promise<CappedSource> {
    const dbPath = path.join(tmpDir, 'opencode.db');
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [
        {
          id: 'ses_capped_v2',
          projectId: V2_FIXTURE_PROJECT.id,
          directory: V2_FIXTURE_PROJECT.worktree,
          timeCreated: 1_000,
          messages: [
            { id: 'm_user', type: 'user', seq: 1, timeCreated: 1_000, data: { text: 'run it' } },
            {
              id: 'm_asst',
              type: 'assistant',
              seq: 2,
              timeCreated: 2_000,
              data: {
                content: [
                  // The reader skips a non-object entry; the source lookup must too.
                  'stray text',
                  {
                    type: 'tool',
                    id: TOOL_CALL_ID,
                    name: 'bash',
                    state: {
                      status: 'completed',
                      input: {},
                      content: [{ type: 'text', text: CAPPED_RESULT }],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    return {
      adapter: new OpenCodeSessionReaderAdapter(mockPricing),
      dbPath,
      providerSessionId: 'ses_capped_v2',
      toolCallId: TOOL_CALL_ID,
    };
  }

  it.each([
    ['agy', seedAgy],
    ['opencode v1', seedOpencodeV1],
    ['opencode v2', seedOpencodeV2],
  ] as const)(
    '%s: Show full reads the whole result from its source; chunks stay capped',
    async (_label, seed) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capped-tool-result-'));
      const cache = new SessionCacheService({
        registerCacheStatsProvider: jest.fn(),
        registerStatsProvider: jest.fn(),
      } as never);
      try {
        const { adapter, dbPath, providerSessionId, toolCallId } = await seed(tmpDir);
        const factory = new SessionReaderAdapterFactory();
        factory.registerAdapter(adapter);
        const sessionsService = {
          getSession: () => ({
            id: 'sess-1',
            providerNameAtLaunch: adapter.providerName,
            transcriptPath: dbPath,
            providerSessionId,
            status: 'stopped',
          }),
        };
        const pathValidator = { validateForRead: async (p: string) => p };
        const service = new SessionReaderService(
          factory,
          pathValidator as unknown as TranscriptPathValidator,
          cache,
          sessionsService as unknown as SessionsService,
        );

        const full = await service.getToolResult('sess-1', toolCallId);
        expect(full).toMatchObject({ fullLength: 100_004, isComplete: true });
        expect(full.content).toBe(CAPPED_RESULT);

        const { chunks } = await service.getUnifiedTranscriptChunks('sess-1', undefined, 50);
        const listed = chunks
          .flatMap((chunk) => chunk.messages)
          .flatMap((message) => message.toolResults)
          .find((result) => result.toolCallId === toolCallId);
        expect(listed).toMatchObject({ isTruncated: true, fullLength: 100_004 });
        expect((listed?.content as string).length).toBeLessThan(100_000);
        const parsed = await adapter.parseFullSession(dbPath, {
          filePath: dbPath,
          providerName: adapter.providerName,
          providerSessionId,
          kind: 'db',
        });
        const parsedResult = parsed.messages
          .flatMap((message) => message.toolResults)
          .find((result) => result.toolCallId === toolCallId);
        expect(parsedResult?.content).toHaveLength(100_000);
      } finally {
        cache.onModuleDestroy();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
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
