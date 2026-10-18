import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpencodeSqliteV2Reader } from './opencode-sqlite.v2.reader';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { EXACT_SUMMARY_FIELDS } from '../adapters/session-reader-adapter.interface';
import type { PricingServiceInterface } from '../services/pricing.interface';
import {
  V2_FIXTURE_PROJECT,
  createOpencodeV2FixtureDb,
  updateV2Catalog,
  updateV2MessageInPlace,
  type V2SeedSession,
} from '../__fixtures__/opencode-v2-fixture-db';

// Real temp SQLite: the reader's contract is its SQL over the v2 tables, which a
// mocked connection would not exercise.

function makePricing(): PricingServiceInterface {
  return {
    calculateMessageCost: jest.fn().mockReturnValue(0.42),
    getCatalogContextWindowSize: jest.fn().mockReturnValue(1_000_000),
    getContextWindowSize: jest.fn().mockReturnValue(1_000_000),
  };
}

/** One session that holds every v2 row type the reader maps or skips. */
function richSession(): V2SeedSession {
  const asst = (seq: number, data: Record<string, unknown>): V2SeedSession['messages'][number] => ({
    id: `msg_${seq}`,
    type: 'assistant',
    seq,
    timeCreated: 1_000 + seq * 100,
    data: { agent: 'build', model: { id: 'demo-model', providerID: 'demo' }, ...data },
  });
  const row = (
    seq: number,
    type: string,
    data: Record<string, unknown>,
  ): V2SeedSession['messages'][number] => ({
    id: `msg_${seq}`,
    type,
    seq,
    timeCreated: 1_000 + seq * 100,
    data,
  });
  return {
    id: 'ses_rich',
    projectId: V2_FIXTURE_PROJECT.id,
    directory: '/workspace/demo',
    model: { id: 'session-model', providerID: 'demo' },
    tokens: { input: 2205, output: 432, reasoning: 170, cacheRead: 1300, cacheWrite: 0 },
    timeCreated: 1_000,
    timeUpdated: 9_000,
    messages: [
      row(1, 'user', { text: '  read a.txt \n', files: [] }),
      asst(2, {
        content: [
          { type: 'reasoning', text: 'I should read it.' },
          {
            type: 'tool',
            id: 'call_1',
            name: 'read',
            state: {
              status: 'completed',
              input: { path: 'a.txt' },
              content: [{ type: 'text', text: '1: hello' }, { type: 'file' }],
            },
          },
        ],
        finish: 'tool-calls',
        tokens: { input: 700, output: 150, reasoning: 50, cache: { read: 300, write: 0 } },
      }),
      asst(3, {
        model: { id: 'other-model', providerID: 'demo' },
        content: [
          {
            type: 'tool',
            id: 'call_2',
            name: 'bash',
            state: {
              status: 'error',
              input: { command: 'false' },
              error: { type: 'ToolError', message: 'exit code 1' },
            },
          },
          { type: 'text', text: '  It failed. ' },
        ],
        finish: 'stop',
        tokens: { input: 1500, output: 280, reasoning: 120, cache: { read: 1000, write: 0 } },
      }),
      row(4, 'idle', { outcome: 'succeeded' }),
      row(5, 'model-switched', { model: { id: 'demo-model', providerID: 'demo' } }),
      row(6, 'synthetic', { text: 'The server restarted while you were working.' }),
      row(7, 'system', { text: 'Stay in the repo.' }),
      row(8, 'shell', { command: 'ls', status: 'completed', output: { output: 'a.txt' } }),
      row(9, 'shell', { command: 'watch', metadata: { background: true } }),
      row(10, 'compaction', { status: 'completed', reason: 'manual', summary: 's', recent: 'r' }),
      row(11, 'compaction', { status: 'running', reason: 'auto', summary: '', recent: '' }),
      row(12, 'user', { text: ' \n\t' }),
      // Still streaming: no `tokens`, no `finish`, the tool has not returned.
      asst(13, {
        content: [
          { type: 'tool', id: 'call_3', name: 'grep', state: { status: 'running', input: {} } },
        ],
      }),
    ],
  };
}

describe('OpencodeSqliteV2Reader', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc2-reader-'));
    dbPath = path.join(dir, 'opencode.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(sessions: V2SeedSession[] = [richSession()]): void {
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT, { id: 'p2', worktree: '/elsewhere' }],
      sessions,
    });
  }

  it('maps each row type to unified messages and skips rows without transcript content', () => {
    seed();
    const { session } = new OpencodeSqliteV2Reader().readSession(dbPath, 'ses_rich');

    expect(
      session.messages.map(({ id, role, isMeta, isCompactSummary, content, stopReason }) => ({
        id,
        role,
        isMeta,
        isCompactSummary,
        content,
        stopReason,
      })),
    ).toEqual([
      {
        id: 'msg_1',
        role: 'user',
        isMeta: false,
        isCompactSummary: undefined,
        content: [{ type: 'text', text: 'read a.txt' }],
        stopReason: undefined,
      },
      {
        id: 'msg_2',
        role: 'assistant',
        isMeta: false,
        isCompactSummary: undefined,
        content: [
          { type: 'thinking', thinking: 'I should read it.' },
          { type: 'tool_call', toolCallId: 'call_1', toolName: 'read', input: { path: 'a.txt' } },
          {
            type: 'tool_result',
            toolCallId: 'call_1',
            content: '1: hello\n[file]',
            isError: false,
          },
        ],
        stopReason: 'tool_use',
      },
      {
        id: 'msg_3',
        role: 'assistant',
        isMeta: false,
        isCompactSummary: undefined,
        content: [
          {
            type: 'tool_call',
            toolCallId: 'call_2',
            toolName: 'bash',
            input: { command: 'false' },
          },
          { type: 'tool_result', toolCallId: 'call_2', content: 'exit code 1', isError: true },
          { type: 'text', text: 'It failed.' },
        ],
        stopReason: 'end_turn',
      },
      {
        id: 'msg_6',
        role: 'user',
        isMeta: true,
        isCompactSummary: undefined,
        content: [{ type: 'text', text: 'The server restarted while you were working.' }],
        stopReason: undefined,
      },
      {
        id: 'msg_7',
        role: 'system',
        isMeta: true,
        isCompactSummary: undefined,
        content: [{ type: 'text', text: 'Stay in the repo.' }],
        stopReason: undefined,
      },
      {
        id: 'msg_8',
        role: 'user',
        isMeta: false,
        isCompactSummary: undefined,
        content: [{ type: 'text', text: '$ ls\na.txt' }],
        stopReason: undefined,
      },
      {
        id: 'msg_10',
        role: 'user',
        isMeta: false,
        isCompactSummary: true,
        content: [{ type: 'text', text: '[Conversation compacted]' }],
        stopReason: undefined,
      },
      {
        id: 'msg_13',
        role: 'assistant',
        isMeta: false,
        isCompactSummary: undefined,
        content: [{ type: 'tool_call', toolCallId: 'call_3', toolName: 'grep', input: {} }],
        stopReason: 'end_turn',
      },
    ]);
  });

  it('takes totals from session_v2, context from the last finished step, and the summary matches the full read', () => {
    seed();
    const reader = new OpencodeSqliteV2Reader(makePricing());

    const full = reader.readSession(dbPath, 'ses_rich').session.metrics;
    const summary = reader.readSummary(dbPath, 'ses_rich').metrics;

    expect(full).toMatchObject({
      inputTokens: 2205,
      outputTokens: 602,
      cacheReadTokens: 1300,
      cacheCreationTokens: 0,
      totalTokens: 4107,
      totalContextTokens: 2900,
      compactionCount: 1,
      primaryModel: 'demo-model',
      modelsUsed: ['demo-model', 'other-model'],
      messageCount: 8,
      durationMs: 1_200,
      costUsd: 0.42,
      contextWindowTokens: 1_000_000,
    });
    for (const field of EXACT_SUMMARY_FIELDS) {
      if (field === 'visibleContextTokens' || field === 'totalContextConsumption') continue;
      if (field === 'phaseBreakdowns') continue;
      expect([field, summary[field]]).toEqual([field, full[field]]);
    }
  });

  /** A GLM session whose step rows carry OpenCode's recorded cost and (optionally) tokens. */
  function glmSession(steps: { tokens?: Record<string, unknown>; cost?: number }[]): V2SeedSession {
    return {
      id: 'ses_glm',
      projectId: V2_FIXTURE_PROJECT.id,
      directory: '/workspace/demo',
      timeCreated: 1_000,
      messages: steps.map((step, i) => ({
        id: `msg_${i + 1}`,
        type: 'assistant',
        seq: i + 1,
        timeCreated: 1_000 + i * 100,
        data: {
          model: { id: 'glm-5.3', providerID: 'zai-coding-plan' },
          content: [{ type: 'text', text: `step ${i + 1}` }],
          finish: 'stop',
          ...step,
        },
      })),
    };
  }

  /** Full read and SQL summary must agree on every value a test asserts. */
  function readBoth(sessionId: string, pricing?: PricingServiceInterface) {
    const reader = new OpencodeSqliteV2Reader(pricing);
    const full = reader.readSession(dbPath, sessionId).session.metrics;
    const summary = reader.readSummary(dbPath, sessionId).metrics;
    expect(summary).toMatchObject({
      contextWindowTokens: full.contextWindowTokens,
      totalContextTokens: full.totalContextTokens,
      costUsd: full.costUsd,
    });
    return full;
  }

  it('takes the context window from the OpenCode catalog by provider and model, and re-reads it when the catalog changes', () => {
    const catalog = (zai: number) => ({
      'zai-coding-plan': { models: { 'glm-5.3': { limit: { context: zai } } } },
      other: { models: { 'glm-5.3': { limit: { context: 128_000 } } } },
    });
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [glmSession([{}])],
      catalog: catalog(1_000_000),
    });
    const pricing = { ...makePricing(), getContextWindowSize: jest.fn().mockReturnValue(300_000) };

    expect(readBoth('ses_glm', pricing).contextWindowTokens).toBe(1_000_000);

    updateV2Catalog(dbPath, catalog(2_000_000), 2_000);
    expect(readBoth('ses_glm', pricing).contextWindowTokens).toBe(2_000_000);
  });

  it.each([
    { name: 'the catalog row is missing', catalog: undefined },
    { name: 'the model is not in the catalog', catalog: { 'zai-coding-plan': { models: {} } } },
  ])('falls back to the pricing window, then 200,000, when $name', ({ catalog }) => {
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [glmSession([{}])],
      catalog,
    });

    expect(readBoth('ses_glm', makePricing()).contextWindowTokens).toBe(1_000_000);
    expect(readBoth('ses_glm').contextWindowTokens).toBe(200_000);
  });

  it('falls back instead of throwing when the catalog body is not JSON', () => {
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [glmSession([{}])],
      catalog: {},
    });
    const db = new Database(dbPath);
    db.prepare(`UPDATE kv SET value = '{"body":"not json"}'`).run();
    db.close();

    expect(readBoth('ses_glm').contextWindowTokens).toBe(200_000);
  });

  it('reports the last non-zero assistant total as context usage, skipping streaming and zero-token rows', () => {
    const tokens = (input: number, output = 0) => ({
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [glmSession([tokens(1_000, 200), tokens(0), {}])],
    });

    expect(readBoth('ses_glm').totalContextTokens).toBe(1_200);
  });

  it('uses the cost OpenCode recorded only when pricing.json lacks the model', () => {
    createOpencodeV2FixtureDb(dbPath, {
      projects: [V2_FIXTURE_PROJECT],
      sessions: [glmSession([{ cost: 0.25 }, { cost: 0.5 }, {}])],
    });
    const unpriced = { ...makePricing(), hasPricing: jest.fn().mockReturnValue(false) };
    const priced = { ...makePricing(), hasPricing: jest.fn().mockReturnValue(true) };

    expect(readBoth('ses_glm', unpriced).costUsd).toBe(0.75);
    expect(unpriced.calculateMessageCost).not.toHaveBeenCalled();
    expect(readBoth('ses_glm', priced).costUsd).toBe(0.42);
  });

  it('reports message-row count and the newest row time as freshness, including in-place edits', () => {
    seed();
    const reader = new OpencodeSqliteV2Reader();
    updateV2MessageInPlace(dbPath, {
      messageId: 'msg_13',
      data: { content: [{ type: 'text', text: 'done' }] },
      timeUpdated: 50_000,
    });

    const freshness = reader.getFreshness(dbPath, 'ses_rich');

    expect(freshness).toEqual({ count: 13, maxUpdated: 50_000 });
    expect(reader.readSession(dbPath, 'ses_rich').freshness).toEqual(freshness);
  });

  it('finds sessions by directory or project worktree within the launch window, closest first', () => {
    const base = { projectId: V2_FIXTURE_PROJECT.id, messages: [] };
    seed([
      { ...base, id: 'ses_far', directory: '/workspace/demo', timeCreated: 100_000 },
      { ...base, id: 'ses_dir', directory: '/workspace/demo', timeCreated: 10_050 },
      { ...base, id: 'ses_sub', directory: '/workspace/demo/pkg', timeCreated: 10_010 },
      { ...base, id: 'ses_other', directory: '/elsewhere', projectId: 'p2', timeCreated: 10_000 },
    ]);
    const candidates = new OpencodeSqliteV2Reader().findSessionCandidates(dbPath, {
      directory: '/workspace/demo',
      startedAtMs: 10_000,
      windowMs: 1_000,
    });

    expect(candidates.map((c) => c.providerSessionId)).toEqual(['ses_sub', 'ses_dir']);
  });

  it('throws NotFoundError for an id that session_v2 does not hold', () => {
    seed();
    expect(() => new OpencodeSqliteV2Reader().readSession(dbPath, 'ses_missing')).toThrow(
      NotFoundError,
    );
  });

  it('fails with a schema-drift ValidationError when a v2 table is missing', () => {
    seed();
    const db = new Database(dbPath);
    db.exec('DROP TABLE session_message');
    db.close();

    expect(() => new OpencodeSqliteV2Reader().getFreshness(dbPath, 'ses_rich')).toThrow(
      ValidationError,
    );
  });
});
