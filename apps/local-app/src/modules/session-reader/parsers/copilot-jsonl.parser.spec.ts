import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PricingServiceInterface } from '../services/pricing.interface';

const mockLoggerWarn = jest.fn();
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { parseCopilotJsonl } =
  require('./copilot-jsonl.parser') as typeof import('./copilot-jsonl.parser');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

const FIXTURE_MULTITURN = path.join(__dirname, '../__fixtures__/copilot-events-multiturn.jsonl');
const FIXTURE_SINGLTURN = path.join(__dirname, '../__fixtures__/copilot-events-singleturn.jsonl');

function writeTempJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
  const filePath = path.join(dir, 'events.jsonl');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function cleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // ignore
  }
}

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.01),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

// --- Synthetic event builders (mirror the real events.jsonl schema) ----------
function ev(
  type: string,
  data: Record<string, unknown>,
  opts: { ts?: string; id?: string } = {},
): object {
  return {
    type,
    data,
    id: opts.id ?? `${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.ts ?? '2026-06-27T10:00:00.000Z',
    parentId: null,
  };
}

const sessionStart = ev('session.start', { sessionId: 'sid-1', version: 1 });
const modelChange = (m: string) => ev('session.model_change', { newModel: m });
const userMessage = (text: string, ts = '2026-06-27T10:00:01.000Z') =>
  ev('user.message', { content: text, messageId: `u-${text.slice(0, 3)}` }, { ts });
const turnStart = (ts = '2026-06-27T10:00:02.000Z') =>
  ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, { ts });
const turnEnd = (ts = '2026-06-27T10:00:03.000Z') =>
  ev('assistant.turn_end', { turnId: '0' }, { ts });
const assistantMessage = (
  content: string,
  opts: {
    model?: string;
    out?: number;
    toolRequests?: object[];
    reasoningText?: string;
    ts?: string;
  } = {},
) =>
  ev(
    'assistant.message',
    {
      messageId: 'm-1',
      model: opts.model ?? 'claude-haiku-4.5',
      content,
      toolRequests: opts.toolRequests ?? [],
      outputTokens: opts.out ?? 10,
      interactionId: 'i-1',
      turnId: '0',
      reasoningText: opts.reasoningText,
    },
    { ts: opts.ts ?? '2026-06-27T10:00:02.500Z' },
  );
const toolComplete = (
  callId: string,
  result: string,
  opts: { success?: boolean; ts?: string } = {},
) =>
  ev(
    'tool.execution_complete',
    {
      toolCallId: callId,
      interactionId: 'i-1',
      model: 'claude-haiku-4.5',
      success: opts.success ?? true,
      result: { content: result },
    },
    { ts: opts.ts ?? '2026-06-27T10:00:02.700Z' },
  );
const shutdown = (usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
  model?: string;
  /** Multiple model entries (overrides `model` for multi-model aggregation tests). */
  models?: Record<
    string,
    {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      reasoning?: number;
      cost?: number;
    }
  >;
  currentTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
}) => {
  const primary = usage.model ?? 'claude-haiku-4.5';
  const modelMetrics = usage.models
    ? Object.fromEntries(
        Object.entries(usage.models).map(([m, u]) => [
          m,
          {
            requests: { count: 1, cost: u.cost ?? 0.33 },
            usage: {
              inputTokens: u.input ?? 0,
              outputTokens: u.output ?? 0,
              cacheReadTokens: u.cacheRead ?? 0,
              cacheWriteTokens: u.cacheWrite ?? 0,
              reasoningTokens: u.reasoning ?? 0,
            },
          },
        ]),
      )
    : {
        [primary]: {
          requests: { count: 1, cost: usage.cost ?? 0.33 },
          usage: {
            inputTokens: usage.input ?? 100,
            outputTokens: usage.output ?? 50,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheWriteTokens: usage.cacheWrite ?? 0,
            reasoningTokens: usage.reasoning ?? 0,
          },
        },
      };
  return ev('session.shutdown', {
    shutdownType: 'routine',
    currentModel: primary,
    modelMetrics,
    currentTokens: usage.currentTokens,
    systemTokens: usage.systemTokens,
    conversationTokens: usage.conversationTokens,
    toolDefinitionsTokens: usage.toolDefinitionsTokens,
  });
};

describe('CopilotJsonlParser', () => {
  describe('basic parsing', () => {
    it('parses a user + assistant turn into 2 messages', async () => {
      const filePath = writeTempJsonl([
        sessionStart,
        modelChange('auto'),
        ev('system.message', { role: 'system', content: 'sys-prompt' }),
        userMessage('Hello'),
        turnStart(),
        assistantMessage('Hi there', { out: 12 }),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages).toHaveLength(2);
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(result.messages[0].content[0]).toMatchObject({ type: 'text', text: 'Hello' });
        expect(
          result.messages[1].content.some((b) => b.type === 'text' && b.text === 'Hi there'),
        ).toBe(true);
        // System prompt is skipped (Claude/Codex precedent) — not counted as a turn.
        expect(result.messages.some((m) => m.role === 'system')).toBe(false);
      } finally {
        cleanup(filePath);
      }
    });

    it('chains parentId across conversational messages', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a'),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages[0].parentId).toBeNull();
        expect(result.messages[1].parentId).toBe(result.messages[0].id);
      } finally {
        cleanup(filePath);
      }
    });

    it('captures reasoningText as a thinking block before the answer', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('Answer', { reasoningText: 'Let me think…', out: 5 }),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        const asst = result.messages[1];
        const kinds = asst.content.map((b) => b.type);
        expect(kinds).toEqual(['thinking', 'text']);
        expect(asst.content[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think…' });
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('tool calls and results', () => {
    const toolReq = {
      toolCallId: 'tc-1',
      name: 'bash',
      arguments: { command: 'ls' },
      type: 'function',
    };

    it('coalesces a tool turn into ONE assistant (call + result + final text)', async () => {
      const filePath = writeTempJsonl([
        userMessage('list files'),
        turnStart(),
        assistantMessage('', { out: 30, toolRequests: [toolReq] }),
        ev('tool.execution_start', {
          toolCallId: 'tc-1',
          toolName: 'bash',
          arguments: { command: 'ls' },
        }),
        toolComplete('tc-1', 'file1\nfile2'),
        turnEnd(),
        ev('assistant.turn_start', { turnId: '1', interactionId: 'i-1' }),
        assistantMessage('Done', { out: 8 }),
        ev('assistant.turn_end', { turnId: '1' }, { ts: '2026-06-27T10:00:04.000Z' }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        // user + ONE coalesced assistant (the whole tool interaction) = 2.
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(result.metrics.messageCount).toBe(2);
        const asst = result.messages[1];
        expect(asst.toolCalls.map((c) => c.id)).toEqual(['tc-1']);
        expect(asst.toolResults.map((r) => r.toolCallId)).toEqual(['tc-1']);
        // Per-turn usage sums outputTokens across the coalesced messages.
        expect(asst.usage).toEqual({ input: 0, output: 38, cacheRead: 0, cacheCreation: 0 });
      } finally {
        cleanup(filePath);
      }
    });

    it('marks tool results as error when success=false', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('', { toolRequests: [toolReq] }),
        toolComplete('tc-1', 'boom', { success: false }),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages[1].toolResults[0].isError).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('metrics (authoritative shutdown)', () => {
    it('uses session.shutdown.modelMetrics as authoritative totals', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { out: 50 }),
        turnEnd(),
        shutdown({
          input: 1000,
          output: 50,
          cacheRead: 20,
          cacheWrite: 5,
          reasoning: 7,
          cost: 0.33,
          currentTokens: 1075,
          systemTokens: 500,
          conversationTokens: 60,
          toolDefinitionsTokens: 515,
        }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        expect(result.metrics.inputTokens).toBe(1000);
        expect(result.metrics.outputTokens).toBe(50); // does NOT add reasoning (⊂ output)
        expect(result.metrics.cacheReadTokens).toBe(20);
        expect(result.metrics.cacheCreationTokens).toBe(5);
        expect(result.metrics.isOngoing).toBe(false);
        expect(result.metrics.primaryModel).toBe('claude-haiku-4.5');
        // Context-window breakdown captured.
        expect(result.metrics.totalContextTokens).toBe(1075);
        expect(result.metrics.contextBreakdown).toEqual({
          system: 500,
          conversation: 60,
          toolDefinitions: 515,
        });
        // Copilot native AI-Credits cost preserved alongside USD.
        expect(result.metrics.nativeCost).toBe(0.33);
      } finally {
        cleanup(filePath);
      }
    });

    it('prices PER MODEL across a mixed-model shutdown (no single collapsed call)', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { model: 'claude-haiku-4.5' }),
        turnEnd(),
        shutdown({
          model: 'claude-haiku-4.5',
          models: {
            'claude-haiku-4.5': { input: 100, output: 10, cost: 0.1 },
            'gpt-5-mini': { input: 200, output: 20, cost: 0.2 },
          },
        }),
      ]);
      (mockPricing.calculateMessageCost as jest.Mock).mockClear();
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        // Aggregated across both models.
        expect(result.metrics.inputTokens).toBe(300);
        expect(result.metrics.outputTokens).toBe(30);
        expect(result.metrics.modelsUsed).toEqual(
          expect.arrayContaining(['claude-haiku-4.5', 'gpt-5-mini']),
        );
        // Priced once per model key (mapped via copilot-model-pricing), not collapsed into one call.
        expect(mockPricing.calculateMessageCost).toHaveBeenCalledTimes(2);
        const pricedModels = (mockPricing.calculateMessageCost as jest.Mock).mock.calls.map(
          (c) => c[0],
        );
        expect(pricedModels).toEqual(expect.arrayContaining(['claude-haiku-4-5', 'gpt-5-mini']));
        // Σ per-model USD cost (mock returns 0.01 each → 0.02); native credits summed (0.1+0.2).
        expect(result.metrics.costUsd).toBeCloseTo(0.02, 5);
        expect(result.metrics.nativeCost).toBeCloseTo(0.3, 5);
      } finally {
        cleanup(filePath);
      }
    });

    it('authoritative USD cost comes from the per-model PricingService map', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a'),
        turnEnd(),
        shutdown({ cost: 0.33 }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        // mockPricing returns 0.01 (USD) → authoritative costUsd; nativeCost keeps 0.33 (AI Credits).
        expect(result.metrics.costUsd).toBe(0.01);
        expect(result.metrics.nativeCost).toBe(0.33);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('metrics (partial / live, no shutdown)', () => {
    it('exposes per-turn outputTokens only and warns while running', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { out: 42 }),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        expect(result.metrics.isOngoing).toBe(true);
        expect(result.metrics.outputTokens).toBe(42);
        // input/cache unknown mid-session → 0 WITH an explicit partial warning (honest).
        expect(result.metrics.inputTokens).toBe(0);
        expect(result.metrics.cacheReadTokens).toBe(0);
        expect(result.warnings?.some((w) => /Partial metrics/.test(w))).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });

    it('NEVER reports a misleading $0 cost while running (output-only non-zero lower bound)', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { out: 42 }),
        turnEnd(),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        // Output-only lower-bound cost (mockPricing → 0.01); never $0 while there is output.
        expect(result.metrics.costUsd).toBeGreaterThan(0);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('resume / multi-shutdown (SUM across runs)', () => {
    it('SUMS per-run shutdowns (each run is separately billed) — not final-wins', async () => {
      const filePath = writeTempJsonl([
        userMessage('q1'),
        turnStart(),
        assistantMessage('a1', { out: 10 }),
        turnEnd(),
        shutdown({ input: 100, output: 10, cost: 0.1 }),
        ev('session.resume', { resumeTime: '2026-06-27T11:00:00.000Z' }),
        ev('system.message', { role: 'system', content: 'sys' }),
        userMessage('q2', '2026-06-27T11:00:01.000Z'),
        ev(
          'assistant.turn_start',
          { turnId: '0', interactionId: 'i-2' },
          { ts: '2026-06-27T11:00:02.000Z' },
        ),
        assistantMessage('a2', { out: 20 }, { ts: '2026-06-27T11:00:03.000Z' }),
        ev('assistant.turn_end', { turnId: '0' }, { ts: '2026-06-27T11:00:04.000Z' }),
        shutdown({ input: 500, output: 20, cost: 0.2 }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { pricingService: mockPricing });
        // Both user turns present; system prompt skipped.
        expect(result.messages.map((m) => m.role)).toEqual([
          'user',
          'assistant',
          'user',
          'assistant',
        ]);
        // SUM across runs (600/30), NOT final-wins (500/20).
        expect(result.metrics.inputTokens).toBe(600);
        expect(result.metrics.outputTokens).toBe(30);
        // Native credits also summed across runs (0.1 + 0.2).
        expect(result.metrics.nativeCost).toBeCloseTo(0.3, 5);
      } finally {
        cleanup(filePath);
      }
    });

    it('replaces live partials once a shutdown arrives', async () => {
      // Live parse (no shutdown): output-only partial.
      const livePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { out: 40 }),
        turnEnd(),
      ]);
      // Same stream + authoritative shutdown.
      const donePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a', { out: 40 }),
        turnEnd(),
        shutdown({ input: 900, output: 40, cacheRead: 100 }),
      ]);
      try {
        const live = await parseCopilotJsonl(livePath, { pricingService: mockPricing });
        const done = await parseCopilotJsonl(donePath, { pricingService: mockPricing });
        expect(live.metrics.isOngoing).toBe(true);
        expect(live.metrics.inputTokens).toBe(0);
        expect(live.warnings?.some((w) => /Partial/.test(w))).toBe(true);
        // Shutdown replaces partial: authoritative input/cache now present, no partial warning.
        expect(done.metrics.isOngoing).toBe(false);
        expect(done.metrics.inputTokens).toBe(900);
        expect(done.metrics.cacheReadTokens).toBe(100);
        expect(done.warnings ?? []).not.toContain(expect.stringMatching(/Partial/));
      } finally {
        cleanup(livePath);
        cleanup(donePath);
      }
    });
  });

  describe('real fixtures from S3', () => {
    it('parses the multi-turn fixture (2 user + coalesced assistants + tools + resume)', async () => {
      const result = await parseCopilotJsonl(FIXTURE_MULTITURN);
      // Turn 1: user + assistant("4"). Turn 2: user + coalesced assistant(tool call + result + "Count: 19").
      expect(result.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(result.metrics.messageCount).toBe(4);
      // Authoritative (both shutdowns summed across the resume): isOngoing false, model tracked.
      expect(result.metrics.isOngoing).toBe(false);
      expect(result.metrics.primaryModel).toBe('claude-haiku-4.5');
      // SUM across the two shutdowns (run1 input 15148 + run2 input 30769 = 45917).
      expect(result.metrics.inputTokens).toBe(15148 + 30769);
      expect(result.metrics.outputTokens).toBe(63 + 271);
      // Native AI-Credits summed across runs (0.33 + 0.33).
      expect(result.metrics.nativeCost).toBeCloseTo(0.66, 5);
      // Tool call + result landed on turn 2's coalesced assistant.
      const turn2 = result.messages[3];
      expect(turn2.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(turn2.toolResults.length).toBeGreaterThanOrEqual(1);
    });

    it('parses the single-turn fixture with a clean shutdown', async () => {
      const result = await parseCopilotJsonl(FIXTURE_SINGLTURN);
      expect(result.metrics.isOngoing).toBe(false);
      expect(result.metrics.primaryModel).toBeTruthy();
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error handling', () => {
    it('skips malformed JSON lines gracefully', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const filePath = path.join(dir, 'events.jsonl');
      const content =
        [
          JSON.stringify(userMessage('hi')),
          'not-valid-json{{{',
          JSON.stringify(assistantMessage('hey')),
        ].join('\n') + '\n';
      fs.writeFileSync(filePath, content, 'utf8');
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        cleanup(filePath);
      }
    });

    it('skips empty lines', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
      const filePath = path.join(dir, 'events.jsonl');
      const content =
        [JSON.stringify(userMessage('hi')), '', '  ', JSON.stringify(assistantMessage('hey'))].join(
          '\n',
        ) + '\n';
      fs.writeFileSync(filePath, content, 'utf8');
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        cleanup(filePath);
      }
    });

    it('skips unknown event types gracefully', async () => {
      const filePath = writeTempJsonl([
        userMessage('hi'),
        ev('some.future.event', { foo: 'bar' }),
        assistantMessage('hey'),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('incremental parsing', () => {
    it('parses from a byte offset (delta)', async () => {
      const filePath = writeTempJsonl([
        userMessage('q'),
        turnStart(),
        assistantMessage('a'),
        turnEnd(),
      ]);
      try {
        const full = await parseCopilotJsonl(filePath);
        expect(full.bytesRead).toBeGreaterThan(0);
        const inc = await parseCopilotJsonl(filePath, { byteOffset: full.bytesRead });
        expect(inc.messages).toHaveLength(0);
      } finally {
        cleanup(filePath);
      }
    });

    it('respects maxMessages limit', async () => {
      const filePath = writeTempJsonl([
        userMessage('q1'),
        turnStart(),
        assistantMessage('a1'),
        turnEnd(),
        userMessage('q2', '2026-06-27T10:00:10.000Z'),
        ev(
          'assistant.turn_start',
          { turnId: '0', interactionId: 'i-2' },
          { ts: '2026-06-27T10:00:11.000Z' },
        ),
        assistantMessage('a2', { ts: '2026-06-27T10:00:12.000Z' }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath, { maxMessages: 1 });
        expect(result.messages).toHaveLength(1);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('oversized lines', () => {
    it('returns a warning when oversized lines are skipped', async () => {
      const huge = 'X'.repeat(11 * 1024 * 1024);
      const filePath = writeTempJsonl([
        userMessage('hi'),
        ev('assistant.message', {
          model: 'claude-haiku-4.5',
          content: huge,
          outputTokens: 1,
          toolRequests: [],
        }),
      ]);
      try {
        const result = await parseCopilotJsonl(filePath);
        expect(result.warnings).toBeDefined();
        expect(result.warnings?.some((w) => /oversized line/.test(w))).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });
  });
});
