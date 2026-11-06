import { join } from 'node:path';
import {
  parseDevinAtif,
  extractAtifSessionId,
  extractAtifFirstTimestamp,
} from './devin-atif.parser';
import type { PricingServiceInterface } from '../services/pricing.interface';

const FIX = join(__dirname, '..', '__fixtures__');
const pricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.01),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(null),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

describe('parseDevinAtif', () => {
  it('parses a single-turn session (user + coalesced assistant)', async () => {
    const r = await parseDevinAtif(join(FIX, 'devin-atif-singleturn.json'), {
      pricingService: pricing,
    });
    expect(r.sessionId).toBe('functional-share');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('user');
    const a = r.messages[1];
    expect(a.role).toBe('assistant');
    expect(a.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    // prompt_tokens(176189) - cached(175872) - cacheCreation(25993) → input is clamped at 0? no: 176189-175872-25993 <0 → 0? Actually 176189-175872-25993 = -25676 → 0
    expect(a.usage).toEqual({ input: 0, output: 936, cacheRead: 175872, cacheCreation: 25993 });
    expect(r.metrics.isOngoing).toBe(false);
    expect(r.metrics.outputTokens).toBe(936);
    expect(r.metrics.compactionCount).toBe(0);
  });

  it('parses a multi-turn file: tool call + observation, compaction marker, models per step', async () => {
    const r = await parseDevinAtif(join(FIX, 'devin-atif-multiturn.json'), {
      pricingService: pricing,
    });
    expect(r.metrics.compactionCount).toBe(1);
    expect(r.messages).toHaveLength(3); // user, assistant(tool turn), user
    const a = r.messages[1];
    expect(a.toolCalls).toEqual([
      { id: 'exec:0#f45c', name: 'exec', input: { command: 'ls' }, isTask: false },
    ]);
    expect(a.toolResults).toEqual([
      { toolCallId: 'exec:0#f45c', content: 'Output from command: file1.ts', isError: false },
    ]);
    // two agent steps coalesced into one assistant message; model = last step's
    expect(a.model).toBe('claude-fable-5-1-xhigh');
    // Header `agent.model_name` ("SWE-2 Flash Max") is a display label, NOT a
    // uid — it must not appear in modelsUsed (step uids only).
    expect(r.metrics.modelsUsed).toEqual(['swe-2-max', 'claude-fable-5-1-xhigh']);
    // last step's usage: prompt 2000, out 10 → totalContextTokens = 2010
    expect(r.metrics.totalContextTokens).toBe(2010);
    // contextWindow looks up the FAMILY key (effort suffix stripped).
    expect(pricing.getContextWindowSize).toHaveBeenCalledWith('claude-fable-5-1');
    // last conversational step is user → ongoing
    expect(r.metrics.isOngoing).toBe(true);
  });

  it('uses the header model label only as a fallback primaryModel', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'devin-atif-hdr-'));
    const p = join(dir, 'hdr.json');
    writeFileSync(
      p,
      JSON.stringify({
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
      }),
    );
    const r = await parseDevinAtif(p, { pricingService: pricing });
    expect(r.metrics.primaryModel).toBe('SWE-2 Flash Max');
    expect(r.metrics.modelsUsed).toBeUndefined();
  });

  it('returns empty result + warning on malformed JSON (never throws)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'devin-atif-'));
    const p = join(dir, 'partial.json');
    writeFileSync(p, '{"schema_version": "ATIF', 'utf8');
    const r = await parseDevinAtif(p);
    expect(r.messages).toEqual([]);
    expect(r.warnings?.length).toBeGreaterThan(0);
  });
});

describe('extract helpers', () => {
  it('extractAtifSessionId from content and partial content', () => {
    expect(extractAtifSessionId('{"session_id":"abc-1","steps":[]}')).toBe('abc-1');
    // Mid-write truncation AFTER a complete session_id still extracts.
    expect(
      extractAtifSessionId('{"schema_version":"ATIF-v1.7","session_id":"xy","steps":[{"step_'),
    ).toBe('xy');
    expect(extractAtifSessionId('no id here')).toBeUndefined();
  });
  it('extractAtifFirstTimestamp parses 9-digit fraction', () => {
    const d = extractAtifFirstTimestamp(
      '{"steps":[{"timestamp":"2026-11-05T20:26:54.537344600+00:00"}]}',
    );
    expect(d?.getUTCFullYear()).toBe(2026);
  });
});
