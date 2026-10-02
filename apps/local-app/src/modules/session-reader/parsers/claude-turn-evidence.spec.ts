import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseClaudeJsonl } from './claude-jsonl.parser';
import { claudeTurnFromMessages, readClaudeContinuation } from './claude-turn-evidence';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import { SessionCacheService } from '../services/session-cache.service';
import { serializeMessage } from '../services/transcript-serialization';
import { transcriptTurnState } from '../services/transcript-turn-state';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { TerminalActivityService } from '../../terminal/services/terminal-activity.service';
import { PendingAskUserQuestionService } from '../../hooks/services/pending-ask-user-question.service';

// Real JSONL files through the real parser, adapter and cache: turn evidence is ordered across
// byte offsets and parse kinds, which only whole-pipeline reads exercise.

const pricing = {
  calculateMessageCost: jest.fn().mockReturnValue(0),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
} as unknown as PricingServiceInterface;

let second = 0;
function at(): string {
  second += 1;
  return new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();
}

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify({ isSidechain: false, timestamp: at(), ...entry })}\n`;
}

const prompt = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', uuid: `u-${second}`, message: { role: 'user', content: text }, ...extra });
const assistant = (stopReason: string | null, extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    uuid: `a-${second}`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Working on it' }],
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    ...extra,
  });
const toolUse = (extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    uuid: `a-${second}`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    ...extra,
  });
const toolResult = (extra: Record<string, unknown> = {}) =>
  line({
    type: 'user',
    uuid: `r-${second}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
    },
    ...extra,
  });
const interrupt = (forToolUse = false) =>
  line({
    type: 'user',
    uuid: `i-${second}`,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: forToolUse
            ? '[Request interrupted by user for tool use]'
            : '[Request interrupted by user]',
        },
      ],
    },
  });
const metadata = () =>
  [
    line({ type: 'system', uuid: `s-${second}`, content: 'Hook output' }),
    line({ type: 'file-history-snapshot', messageId: 'm', snapshot: {} }),
    line({
      type: 'user',
      uuid: `m-${second}`,
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' },
    }),
    prompt('<command-name>/effort</command-name>\n<command-args></command-args>'),
    assistant('tool_use', { isSidechain: true }),
  ].join('');
const localCommandResult = () =>
  prompt('<local-command-stdout>Set effort to high</local-command-stdout>');

describe('Claude turn evidence', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devchain-claude-turn-'));
    filePath = join(directory, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function turnOf(content: string) {
    await writeFile(filePath, content);
    const result = await parseClaudeJsonl(filePath, { pricingService: pricing });
    return { turn: result.turn, isOngoing: result.metrics.isOngoing };
  }

  describe('restart fixtures (full parse)', () => {
    it.each([
      ['an ended transcript', () => prompt('Fix the bug') + assistant('end_turn'), false],
      ['an ongoing transcript', () => prompt('Fix the bug') + toolUse(), true],
      [
        'end_turn followed by a new prompt',
        () => prompt('One') + assistant('end_turn') + prompt('Two'),
        true,
      ],
      [
        'tool_use followed by an interruption',
        () => prompt('Fix it') + toolUse() + toolResult() + interrupt(true),
        false,
      ],
      ['a plain interruption', () => prompt('Fix it') + assistant(null) + interrupt(), false],
      ['a finished local command', () => assistant('end_turn') + localCommandResult(), false],
    ])('reads %s', async (_label, build, open) => {
      const { turn, isOngoing } = await turnOf(build());
      expect(turn?.open).toBe(open);
      expect(isOngoing).toBe(open);
    });

    it('ignores sidechain, metadata and slash-command echo entries', async () => {
      const { turn } = await turnOf(prompt('Fix it') + assistant('end_turn') + metadata());
      expect(turn?.open).toBe(false);
    });

    it('opens a turn for a queued human prompt', async () => {
      const queued = line({
        type: 'attachment',
        uuid: `q-${second}`,
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          prompt: 'Also update the docs',
        },
      });
      const { turn } = await turnOf(prompt('Fix it') + assistant('end_turn') + queued);
      expect(turn?.open).toBe(true);
    });

    it('reports no evidence for a transcript without turns', async () => {
      const { turn } = await turnOf(line({ type: 'summary', summary: 'Earlier session' }));
      expect(turn).toBeNull();
    });
  });

  describe('incremental parses', () => {
    const adapter = new ClaudeSessionReaderAdapter(pricing);

    async function appendAndParse(base: string, append: string) {
      await writeFile(filePath, base);
      const byteOffset = (await stat(filePath)).size;
      const seed = await adapter.getSummary({ filePath, providerName: 'claude', kind: 'file' });
      await appendFile(filePath, append);
      return adapter.parseIncremental(filePath, {
        byteOffset,
        continuationState: seed?.laneSeed?.continuationState,
      });
    }

    it.each([
      ['a tool_result-only append', () => toolResult()],
      ['a metadata-only append', () => metadata()],
    ])('keeps an ended turn ended after %s', async (_label, append) => {
      const slice = await appendAndParse(prompt('Fix it') + assistant('end_turn'), append());
      expect(readClaudeContinuation(slice.continuationState)?.turn?.open).toBe(false);
      expect(slice.metrics?.isOngoing).toBe(false);
    });

    it('keeps an open turn open when the slice has no assistant line', async () => {
      const slice = await appendAndParse(prompt('Fix it') + toolUse(), toolResult());
      expect(slice.metrics?.isOngoing).toBe(true);
      expect(readClaudeContinuation(slice.continuationState)?.turn?.open).toBe(true);
    });

    it('opens the next turn from a new prompt in the slice', async () => {
      const slice = await appendAndParse(prompt('One') + assistant('end_turn'), prompt('Two'));
      expect(slice.metrics?.isOngoing).toBe(true);
    });

    it('carries the turn across an empty slice', async () => {
      await writeFile(filePath, prompt('Fix it') + assistant('end_turn'));
      const continuationState = { turn: { open: false, atMs: 1 } };
      const slice = await adapter.parseIncremental(filePath, {
        byteOffset: (await stat(filePath)).size,
        continuationState,
      });
      expect(slice.continuationState).toBe(continuationState);
    });
  });

  it('resumes from a full parse in the parsed cache (the continuation survives it)', async () => {
    const cache = new SessionCacheService({
      registerCacheStatsProvider: jest.fn(),
      registerStatsProvider: jest.fn(),
    } as never);
    const adapter = new ClaudeSessionReaderAdapter(pricing);
    await writeFile(filePath, prompt('Fix it') + assistant('end_turn'));
    const full = await cache.getOrParseWithMeta('s1', filePath, adapter);
    expect(readClaudeContinuation(full.continuationState)?.turn?.open).toBe(false);

    await appendFile(filePath, metadata());
    const appended = await cache.getOrParseWithMeta('s1', filePath, adapter);

    expect(appended.sourceChangeKind).toBe('same-file-append');
    expect(appended.session.metrics.isOngoing).toBe(false);
    expect(readClaudeContinuation(appended.continuationState)?.turn?.open).toBe(false);
    cache.onModuleDestroy();
  });

  describe('the time of a folded turn', () => {
    const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const atSecond = (offset: number) => ({
      timestamp: new Date(T0 + offset * 1000).toISOString(),
    });
    const adapter = new ClaudeSessionReaderAdapter(pricing);
    const caches: SessionCacheService[] = [];
    let db: Database.Database;
    let activity: TerminalActivityService;

    function newCache(): SessionCacheService {
      const cache = new SessionCacheService({
        registerCacheStatsProvider: jest.fn(),
        registerStatsProvider: jest.fn(),
      } as never);
      caches.push(cache);
      return cache;
    }

    /** What the watcher reports to the activity service for one cache read. */
    async function report(cache: SessionCacheService) {
      const result = await cache.getOrParseWithMeta('c1', filePath, adapter);
      activity.handleTranscriptTurn({
        sessionId: 'c1',
        providerName: 'claude',
        turn: transcriptTurnState('claude', result.session.metrics, result.continuationState),
        grew: true,
      });
      return result;
    }

    const activityState = () =>
      (
        db.prepare(`SELECT activity_state FROM sessions WHERE id = 'c1'`).get() as {
          activity_state: string | null;
        }
      ).activity_state;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, activity_state TEXT, busy_since TEXT,
        last_activity_at TEXT, updated_at TEXT, provider_name_at_launch TEXT
      )`);
      db.prepare(
        `INSERT INTO sessions (id, status, provider_name_at_launch) VALUES ('c1', 'running', 'claude')`,
      ).run();
      activity = new TerminalActivityService(
        db as never,
        { emit: jest.fn() } as never,
        { getSetting: jest.fn() } as never,
        { get: jest.fn() } as never,
        new PendingAskUserQuestionService() as never,
      );
    });

    afterEach(() => {
      activity.onModuleDestroy();
      caches.splice(0).forEach((cache) => cache.onModuleDestroy());
      db.close();
    });

    it('ends the turn when the closing pass is a full parse (no Stop hook)', async () => {
      // Prompt at 0 s, assistant text at 1 s, tool_use at 30 s: the incremental pass stamps the
      // open turn at 30 s, after the first assistant entry of the folded message.
      await writeFile(filePath, prompt('Fix it', atSecond(0)) + assistant(null, atSecond(1)));
      const live = newCache();
      await report(live);
      await appendFile(filePath, toolUse(atSecond(30)));
      const incremental = await report(live);
      expect(incremental.sourceChangeKind).toBe('same-file-append');
      expect(readClaudeContinuation(incremental.continuationState)?.turn).toEqual({
        open: true,
        atMs: T0 + 30_000,
      });
      expect(activityState()).toBe('busy');

      // The turn ends at 50 s and the next read is a full parse (the entry was evicted).
      await appendFile(filePath, toolResult(atSecond(31)) + assistant('end_turn', atSecond(50)));
      const full = await report(newCache());

      expect(full.session.messages.at(-1)?.timestamp.getTime()).toBe(T0 + 1_000);
      expect(readClaudeContinuation(full.continuationState)?.turn).toEqual({
        open: false,
        atMs: T0 + 50_000,
      });
      expect(activityState()).toBe('idle');
    });

    describe('a previous end_turn read after a new prompt hook', () => {
      const previousTurn = () =>
        prompt('One', atSecond(0)) +
        assistant(null, atSecond(1)) +
        toolUse(atSecond(5)) +
        toolResult(atSecond(6)) +
        assistant('end_turn', atSecond(10));
      // Written after the end_turn and after the new prompt hook fired at 20 s.
      const trailingEntries = () =>
        line({ type: 'system', uuid: 's-late', content: 'Hook output', ...atSecond(25) }) +
        line({ type: 'file-history-snapshot', messageId: 'm', snapshot: {}, ...atSecond(26) });

      function newPromptHook(): void {
        activity.handleTurnHook({
          sessionId: 'c1',
          providerName: 'claude',
          kind: 'prompt-submitted',
          firedAtMs: T0 + 20_000,
        });
      }

      it('keeps the new turn busy in a full parse', async () => {
        await writeFile(filePath, previousTurn() + trailingEntries());
        newPromptHook();
        const full = await report(newCache());

        expect(readClaudeContinuation(full.continuationState)?.turn).toEqual({
          open: false,
          atMs: T0 + 10_000,
        });
        expect(activityState()).toBe('busy');
      });

      it('keeps the new turn busy in an incremental parse', async () => {
        await writeFile(filePath, prompt('One', atSecond(0)) + assistant(null, atSecond(1)));
        const live = newCache();
        await report(live);
        await appendFile(
          filePath,
          toolUse(atSecond(5)) +
            toolResult(atSecond(6)) +
            assistant('end_turn', atSecond(10)) +
            trailingEntries(),
        );
        newPromptHook();
        const incremental = await report(live);

        expect(incremental.sourceChangeKind).toBe('same-file-append');
        expect(readClaudeContinuation(incremental.continuationState)?.turn).toEqual({
          open: false,
          atMs: T0 + 10_000,
        });
        expect(activityState()).toBe('busy');
      });
    });

    it('keeps the last entry time when a continuation folds into the cached tail', async () => {
      await writeFile(filePath, prompt('Fix it', atSecond(0)) + toolUse(atSecond(30)));
      const cache = newCache();
      await cache.getOrParseWithMeta('c1', filePath, adapter);
      await appendFile(filePath, toolResult(atSecond(31)) + assistant('end_turn', atSecond(50)));
      const appended = await cache.getOrParseWithMeta('c1', filePath, adapter);

      expect(appended.sourceChangeKind).toBe('same-file-append');
      const tail = appended.session.messages.at(-1)!;
      expect(appended.session.messages).toHaveLength(2);
      expect(tail.timestamp.getTime()).toBe(T0 + 30_000);
      expect(tail.lastEntryAtMs).toBe(T0 + 50_000);
      expect(claudeTurnFromMessages(appended.session.messages)).toEqual({
        open: false,
        atMs: T0 + 50_000,
      });
      expect(serializeMessage(tail)).not.toHaveProperty('lastEntryAtMs');
    });
  });
});
