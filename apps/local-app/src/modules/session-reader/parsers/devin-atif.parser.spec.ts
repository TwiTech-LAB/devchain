import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDevinAtif, extractAtifSessionId } from './devin-atif.parser';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { PricingService } from '../services/pricing.service';
import {
  estimateMessageTokens,
  estimateVisibleFromMessages,
} from '../adapters/utils/estimate-content-tokens';

const FIX = join(__dirname, '..', '__fixtures__');
const pricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.01),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(null),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

/** Writes `content` to a temp export file, runs `fn` on its path, then removes the folder. */
async function withAtifFile(
  content: string,
  fn: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devin-atif-'));
  try {
    const filePath = join(dir, 'export.json');
    writeFileSync(filePath, content, 'utf8');
    await fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseDevinAtif', () => {
  it('parses a single-turn session (user + coalesced assistant)', async () => {
    const r = await parseDevinAtif(join(FIX, 'devin-atif-singleturn.json'), {
      pricingService: pricing,
    });
    expect(r.sessionId).toBe('full-witness');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('user');
    const a = r.messages[1];
    expect(a.role).toBe('assistant');
    expect(a.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    // input = prompt(12030) - cached(5248); SWE steps report no cache creation.
    expect(a.usage).toEqual({ input: 6782, output: 11, cacheRead: 5248, cacheCreation: 0 });
    // Visible = the message content only; the prompt also carries the system prompt and tools.
    expect(r.metrics.visibleContextTokens).toBe(estimateVisibleFromMessages(r.messages));
    expect(r.metrics.visibleContextTokens).toBeLessThan(1000);
    expect(r.metrics.totalContextTokens).toBe(12041);
    expect(r.metrics.primaryModel).toBe('swe-2-flash-medium');
    expect(r.metrics.isOngoing).toBe(false);
    expect(r.metrics.compactionCount).toBe(0);
  });

  it.each([
    // Two agent steps (a `read` tool call, then the answer) in one turn.
    { fixture: 'devin-atif-multiturn.json', agentSteps: 2, messages: 2 },
    // Restored session: the export holds both user turns.
    { fixture: 'devin-atif-restored.json', agentSteps: 3, messages: 4 },
  ])(
    '$fixture: context use = last agent step prompt; visible = message content; totals and cost = sums',
    async ({ fixture, agentSteps, messages }) => {
      const path = join(FIX, fixture);
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        steps: Array<{ source: string; metrics?: { prompt_tokens: number } }>;
        final_metrics: {
          total_prompt_tokens: number;
          total_completion_tokens: number;
          total_cached_tokens: number;
        };
      };
      const lastPrompt = doc.steps.filter((st) => st.metrics).at(-1)!.metrics!.prompt_tokens;
      const final = doc.final_metrics;

      const r = await parseDevinAtif(path, { pricingService: pricing });
      const m = r.metrics;

      expect(r.messages).toHaveLength(messages);
      expect(m.visibleContextTokens).toBe(estimateVisibleFromMessages(r.messages));
      expect(m.visibleContextTokens).toBeLessThan(lastPrompt / 10);
      expect(m.phaseBreakdowns).toEqual([
        { phaseNumber: 1, contribution: lastPrompt, peakTokens: lastPrompt },
      ]);
      expect(m.totalContextConsumption).toBe(lastPrompt);
      expect(m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens).toBe(
        final.total_prompt_tokens,
      );
      expect(m.outputTokens).toBe(final.total_completion_tokens);
      expect(m.cacheReadTokens).toBe(final.total_cached_tokens);
      expect(m.costUsd).toBeCloseTo(0.01 * agentSteps);
      expect(m.isOngoing).toBe(false);
    },
  );

  it('coalesces the tool loop into one assistant message (multi-step fixture)', async () => {
    const r = await parseDevinAtif(join(FIX, 'devin-atif-multiturn.json'), {
      pricingService: pricing,
    });
    const a = r.messages[1];
    expect(a.content.map((b) => b.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'text']);
    expect(a.toolCalls).toEqual([
      {
        id: 'call_84f5ab3d5bbab351',
        name: 'read',
        input: { file_path: '/work/probe/README.md' },
        isTask: false,
      },
    ]);
    expect(a.toolResults).toEqual([
      expect.objectContaining({ toolCallId: 'call_84f5ab3d5bbab351', isError: false }),
    ]);
    expect(r.metrics.modelsUsed).toBeUndefined();
  });

  it('counts compaction markers, model switches and cache creation (synthetic)', async () => {
    // The real exports have none of these: no compaction ran, and SWE steps
    // carry no `extra.cache_creation_input_tokens`.
    const doc = JSON.stringify({
      session_id: 's1',
      agent: { model_name: 'SWE-2 Flash Max' },
      steps: [
        {
          source: 'system',
          message: 'You are continuing work from a previous conversation thread. Summary.',
        },
        { source: 'user', message: 'List the files' },
        {
          source: 'agent',
          model_name: 'swe-2-max',
          message: 'Let me check.',
          metrics: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            cached_tokens: 600,
            extra: { cache_creation_input_tokens: 300 },
          },
        },
        {
          source: 'agent',
          model_name: 'claude-fable-5-1-xhigh',
          message: 'There is file1.ts',
          metrics: { prompt_tokens: 1100, completion_tokens: 10 },
        },
        { source: 'user', message: 'thanks' },
      ],
    });
    await withAtifFile(doc, async (p) => {
      const r = await parseDevinAtif(p, { pricingService: pricing });
      expect(r.metrics.compactionCount).toBe(1);
      expect(r.messages[1].usage).toEqual({
        input: 100 + 1100,
        output: 15,
        cacheRead: 600,
        cacheCreation: 300,
      });
      // Header `agent.model_name` is a display label, never a step uid.
      expect(r.metrics.modelsUsed).toEqual(['swe-2-max', 'claude-fable-5-1-xhigh']);
      expect(r.messages[1].model).toBe('claude-fable-5-1-xhigh');
      // The context-window lookup uses the family key (effort suffix stripped).
      expect(pricing.getContextWindowSize).toHaveBeenCalledWith('claude-fable-5-1');
      expect(r.metrics.visibleContextTokens).toBe(
        r.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg.content), 0),
      );
      expect(r.metrics.isOngoing).toBe(true);
    });
  });

  it("uses Devin's own context size and price for a swe-2-flash-medium session", async () => {
    const doc = JSON.stringify({
      schema_version: 'ATIF-v1.7',
      session_id: 's-flash',
      steps: [
        { step_id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'user', message: 'hi' },
        {
          step_id: 2,
          timestamp: '2026-01-01T00:00:01Z',
          source: 'agent',
          model_name: 'swe-2-flash-medium',
          message: 'hello',
          metrics: { prompt_tokens: 1000, completion_tokens: 10 },
        },
      ],
    });
    await withAtifFile(doc, async (p) => {
      const r = await parseDevinAtif(p, { pricingService: new PricingService() });
      expect(r.metrics.contextWindowTokens).toBe(262_144);
      expect(r.metrics.costUsd).toBe(0);
    });
  });

  it('uses the header model label only as a fallback primaryModel', async () => {
    const doc = JSON.stringify({
      schema_version: 'ATIF-v1.7',
      session_id: 's1',
      agent: { model_name: 'SWE-2 Flash Max' },
      steps: [
        {
          step_id: 1,
          timestamp: '2026-01-01T00:00:00.000000000+00:00',
          source: 'user',
          message: 'hi',
        },
      ],
    });
    await withAtifFile(doc, async (p) => {
      const r = await parseDevinAtif(p, { pricingService: pricing });
      expect(r.metrics.primaryModel).toBe('SWE-2 Flash Max');
      expect(r.metrics.modelsUsed).toBeUndefined();
    });
  });

  it('returns empty result + warning on malformed JSON (never throws)', async () => {
    await withAtifFile('{"schema_version": "ATIF', async (p) => {
      const r = await parseDevinAtif(p);
      expect(r.messages).toEqual([]);
      expect(r.warnings?.length).toBeGreaterThan(0);
    });
  });
});

describe('extract helpers', () => {
  it('extractAtifSessionId from content and partial content', () => {
    expect(extractAtifSessionId('{"session_id":"abc-1","steps":[]}')).toBe('abc-1');
    // Truncated content AFTER a complete session_id still extracts.
    expect(
      extractAtifSessionId('{"schema_version":"ATIF-v1.7","session_id":"xy","steps":[{"step_'),
    ).toBe('xy');
    expect(extractAtifSessionId('no id here')).toBeUndefined();
  });
});
