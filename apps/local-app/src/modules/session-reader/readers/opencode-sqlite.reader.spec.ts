import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpencodeSqliteReader } from './opencode-sqlite.reader';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { coalesceAssistantTurns } from '../adapters/utils/coalesce-turns';

// ---------------------------------------------------------------------------
// Fixture DB helpers — reproduce the opencode 1.15.x relational layout
// ---------------------------------------------------------------------------

type DatabaseInstance = Database.Database;

const SCHEMA_SQL = `
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
  CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, model TEXT, agent TEXT, parent_id TEXT,
    directory TEXT, project_id TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
  CREATE INDEX part_session_idx ON part (session_id);
  CREATE INDEX part_message_id_id_idx ON part (message_id, id);
`;

interface SeedPart {
  data: Record<string, unknown>;
  timeUpdated?: number;
}
interface SeedMessage {
  id: string;
  timeCreated: number;
  timeUpdated?: number;
  data: Record<string, unknown>;
  parts: SeedPart[];
}

let tmpDir: string;
let partSeq = 0;

function newDbPath(name = 'opencode.db'): string {
  return path.join(tmpDir, `${name}-${Math.floor(Math.random() * 1e9)}.db`);
}

function withWritable(dbPath: string, fn: (db: DatabaseInstance) => void): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL'); // verify the reader (NOT immutable) reads WAL DBs
    fn(db);
  } finally {
    db.close();
  }
}

function seedDb(
  dbPath: string,
  opts: {
    session?: Partial<{
      id: string;
      title: string;
      model: string | null;
      agent: string;
      parentId: string | null;
      timeCreated: number;
      timeUpdated: number;
    }>;
    messages: SeedMessage[];
  },
): string {
  withWritable(dbPath, (db) => {
    db.exec(SCHEMA_SQL);
    const s = {
      id: 'ses_test',
      title: 'Test session',
      model: 'glm-5.1',
      agent: 'build',
      parentId: null,
      timeCreated: 1_000,
      timeUpdated: 9_999,
      ...opts.session,
    };
    db.prepare(
      `INSERT INTO session (id, title, model, agent, parent_id, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.title, s.model, s.agent, s.parentId, s.timeCreated, s.timeUpdated);

    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const m of opts.messages) {
      insMsg.run(m.id, s.id, m.timeCreated, m.timeUpdated ?? m.timeCreated, JSON.stringify(m.data));
      for (const p of m.parts) {
        const id = `prt_${String(++partSeq).padStart(6, '0')}`;
        insPart.run(
          id,
          m.id,
          s.id,
          m.timeCreated,
          p.timeUpdated ?? m.timeCreated,
          JSON.stringify(p.data),
        );
      }
    }
  });
  return dbPath;
}

function makePricing(): jest.Mocked<PricingServiceInterface> {
  return {
    calculateMessageCost: jest.fn().mockReturnValue(0.4242),
    getContextWindowSize: jest.fn().mockReturnValue(256_000),
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-reader-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  partSeq = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpencodeSqliteReader', () => {
  describe('readSummary — native aggregate parity', () => {
    it('matches every exact full-parse metric without constructing message graphs', () => {
      const pricing = makePricing();
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_user',
            timeCreated: 1_000,
            data: { role: 'user' },
            parts: [{ data: { type: 'text', text: 'Hello' } }],
          },
          {
            id: 'msg_assistant',
            timeCreated: 2_000,
            data: {
              role: 'assistant',
              modelID: 'glm-5.1',
              tokens: { input: 10, output: 3, cache: { read: 2, write: 1 } },
            },
            parts: [
              { data: { type: 'text', text: 'Hi' } },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
                },
              },
            ],
          },
        ],
      });
      const reader = new OpencodeSqliteReader(pricing);

      const full = reader.readSession(dbPath, 'ses_test').session.metrics;
      const summary = reader.readSummary(dbPath, 'ses_test').metrics;

      for (const field of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheCreationTokens',
        'totalTokens',
        'compactionCount',
        'totalContextTokens',
        'contextWindowTokens',
        'costUsd',
        'primaryModel',
        'modelsUsed',
        'durationMs',
        'messageCount',
        'isOngoing',
      ] as const) {
        expect(summary[field]).toEqual(full[field]);
      }
    });
  });

  describe('readSession — normalization', () => {
    it('reconstructs roles, thinking, tool calls/results, tokens, model, timestamps', () => {
      const pricing = makePricing();
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_001',
            timeCreated: 1_000,
            data: { role: 'user' },
            parts: [{ data: { type: 'text', text: 'Hi' } }],
          },
          {
            id: 'msg_002',
            timeCreated: 2_000,
            data: {
              role: 'assistant',
              modelID: 'glm-5.1',
              providerID: 'zai',
              parentID: 'msg_001',
              tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
            },
            parts: [
              { data: { type: 'reasoning', text: 'thinking about it' } },
              {
                data: {
                  type: 'tool',
                  callID: 'call_1',
                  tool: 'read',
                  state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'file body' },
                },
              },
              { data: { type: 'text', text: 'Done.' } },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
                },
              },
            ],
          },
        ],
      });

      const reader = new OpencodeSqliteReader(pricing);
      const { session, sizeBytes, freshness } = reader.readSession(dbPath, 'ses_test');

      expect(session.id).toBe('ses_test');
      expect(session.providerName).toBe('opencode');
      expect(session.filePath).toBe(dbPath);
      expect(session.messages).toHaveLength(2);

      const [user, assistant] = session.messages;
      expect(user.role).toBe('user');
      expect(user.content).toEqual([{ type: 'text', text: 'Hi' }]);
      expect(user.timestamp).toEqual(new Date(1_000));

      expect(assistant.role).toBe('assistant');
      expect(assistant.parentId).toBe('msg_001');
      expect(assistant.model).toBe('glm-5.1');
      expect(assistant.timestamp).toEqual(new Date(2_000));
      // thinking → tool_call → tool_result → text, in part order
      expect(assistant.content.map((b) => b.type)).toEqual([
        'thinking',
        'tool_call',
        'tool_result',
        'text',
      ]);
      expect(assistant.toolCalls).toEqual([
        { id: 'call_1', name: 'read', input: { filePath: '/a.ts' }, isTask: false },
      ]);
      expect(assistant.toolResults).toEqual([
        { toolCallId: 'call_1', content: 'file body', isError: false },
      ]);
      expect(assistant.usage).toEqual({ input: 100, output: 25, cacheRead: 7, cacheCreation: 3 });

      // Metrics: token totals from step-finish (output includes reasoning).
      expect(session.metrics.inputTokens).toBe(100);
      expect(session.metrics.outputTokens).toBe(25);
      expect(session.metrics.cacheReadTokens).toBe(7);
      expect(session.metrics.cacheCreationTokens).toBe(3);
      expect(session.metrics.totalTokens).toBe(135);
      expect(session.metrics.primaryModel).toBe('glm-5.1');
      expect(session.metrics.durationMs).toBe(1_000);

      // Cost via the token-only pricing service (not session.cost / step.cost).
      expect(pricing.calculateMessageCost).toHaveBeenCalledWith('glm-5.1', 100, 25, 7, 3);
      expect(session.metrics.costUsd).toBe(0.4242);
      expect(session.metrics.contextWindowTokens).toBe(256_000);

      // Session-specific size = sum of this session's part-blob byte sizes.
      const expectedSize = countSeededPartBytes(dbPath, 'ses_test');
      expect(sizeBytes).toBe(expectedSize);

      // Freshness: part count (1 user text + 4 assistant parts) + max(time_updated).
      expect(freshness.count).toBe(5);
      expect(freshness.maxUpdated).toBe(9_999); // session.time_updated dominates here
    });

    it('maps a tool error to an errored tool_result using state.error', () => {
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_001',
            timeCreated: 1,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [
              {
                data: {
                  type: 'tool',
                  callID: 'call_err',
                  tool: 'read',
                  state: {
                    status: 'error',
                    input: { filePath: '/missing' },
                    error: 'File not found',
                  },
                },
              },
            ],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
      const result = session.messages[0].toolResults[0];
      expect(result.isError).toBe(true);
      expect(result.content).toBe('File not found');
    });

    it('caps large tool outputs and flags truncation', () => {
      const big = 'X'.repeat(5_000);
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_001',
            timeCreated: 1,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [
              {
                data: {
                  type: 'tool',
                  callID: 'c1',
                  tool: 'read',
                  state: { status: 'completed', input: {}, output: big },
                },
              },
            ],
          },
        ],
      });

      const reader = new OpencodeSqliteReader(undefined, { maxToolOutputChars: 1_000 });
      const { session } = reader.readSession(dbPath, 'ses_test');
      const result = session.messages[0].toolResults[0];
      expect((result.content as string).length).toBe(1_000);
      expect(result.isTruncated).toBe(true);
      expect(result.fullLength).toBe(5_000);
    });

    it('emits finish→stopReason so a multi-row turn coalesces to messageCount 2 (regression target)', () => {
      // OpenCode writes ONE message row per agent STEP. A tool turn spans several
      // assistant rows, each carrying `data.finish`: 'tool-calls' (continuation —
      // another assistant step follows) or 'stop' (turn boundary). The reader maps
      // finish → stopReason ('tool-calls'→'tool_use', everything else→'end_turn') so
      // the shared coalescer (`coalesceAssistantTurns`, applied centrally in
      // getOrParse) folds the step-rows into ONE assistant turn → 1 user + 1 = 2.
      //
      // Real DB (~/.local/share/opencode/opencode.db) confirms the signal contract:
      // 'tool-calls' is the ONLY continuation value; 'stop'/'\u200B'/'other'/null are
      // always followed by a user row or are trailing — never another assistant — so
      // mapping them to end_turn is fail-safe (verified: 0 ''/other → assistant cases).
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_user',
            timeCreated: 1_000,
            data: { role: 'user' },
            parts: [{ data: { type: 'text', text: 'Check and fix the bug' } }],
          },
          {
            id: 'msg_asst_1',
            timeCreated: 2_000,
            data: {
              role: 'assistant',
              modelID: 'glm-5.1',
              parentID: 'msg_user',
              finish: 'tool-calls',
              tokens: { input: 200, output: 60, reasoning: 10, cache: { read: 5, write: 5 } },
            },
            parts: [
              { data: { type: 'text', text: 'Let me investigate.' } },
              {
                data: {
                  type: 'tool',
                  callID: 'call_1',
                  tool: 'read',
                  state: {
                    status: 'completed',
                    input: { filePath: '/src/auth.ts' },
                    output: 'file contents',
                  },
                },
              },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 200, output: 60, reasoning: 10, cache: { read: 5, write: 5 } },
                },
              },
            ],
          },
          {
            id: 'msg_asst_2',
            timeCreated: 3_000,
            data: {
              role: 'assistant',
              modelID: 'glm-5.1',
              parentID: 'msg_asst_1',
              finish: 'tool-calls',
              tokens: { input: 300, output: 40, cache: { read: 10 } },
            },
            parts: [
              { data: { type: 'text', text: 'Found it, applying the fix.' } },
              {
                data: {
                  type: 'tool',
                  callID: 'call_2',
                  tool: 'write',
                  state: {
                    status: 'completed',
                    input: { filePath: '/src/auth.ts' },
                    output: 'ok',
                  },
                },
              },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 300, output: 40, cache: { read: 10 } },
                },
              },
            ],
          },
          {
            id: 'msg_asst_3',
            timeCreated: 4_000,
            data: {
              role: 'assistant',
              modelID: 'glm-5.1',
              parentID: 'msg_asst_2',
              finish: 'stop',
              tokens: { input: 400, output: 20, cache: { read: 15 } },
            },
            parts: [
              { data: { type: 'text', text: 'All done.' } },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 400, output: 20, cache: { read: 15 } },
                },
              },
            ],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');

      // RAW reader output: one message per row — NO coalescing in the reader (the
      // shared coalescer runs centrally in getOrParse). 1 user + 3 assistant steps.
      expect(session.messages).toHaveLength(4);
      expect(session.metrics.messageCount).toBe(4);
      expect(session.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'assistant',
      ]);

      // The reader emits the turn-boundary signal on each assistant step.
      expect(session.messages[0].stopReason).toBeUndefined(); // user — no signal
      expect(session.messages[1].stopReason).toBe('tool_use'); // finish: 'tool-calls'
      expect(session.messages[2].stopReason).toBe('tool_use'); // finish: 'tool-calls'
      expect(session.messages[3].stopReason).toBe('end_turn'); // finish: 'stop'

      // Apply the shared coalescer (the central pass in getOrParse) → step-rows
      // collapse into ONE assistant turn.
      const coalesced = coalesceAssistantTurns(session);
      expect(coalesced.messages).toHaveLength(2);
      expect(coalesced.metrics.messageCount).toBe(2);
      expect(coalesced.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

      const asst = coalesced.messages[1];
      // Both rounds' tool calls + results preserved on the single assistant (no data loss).
      expect(asst.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
      expect(asst.toolResults.map((r) => r.toolCallId)).toEqual(['call_1', 'call_2']);
      // Semantic-step order preserved across the folded rows:
      // text → tool_call → tool_result → text → tool_call → tool_result → text.
      expect(asst.content.map((b) => b.type)).toEqual([
        'text',
        'tool_call',
        'tool_result',
        'text',
        'tool_call',
        'tool_result',
        'text',
      ]);
      // The coalesced turn adopts the LAST step's boundary signal.
      expect(asst.stopReason).toBe('end_turn');
      // Per-message usage is summed across the folded steps (output includes reasoning).
      expect(asst.usage).toEqual({
        input: 200 + 300 + 400,
        output: 60 + 10 + 40 + 20,
        cacheRead: 5 + 10 + 15,
        cacheCreation: 5,
      });
      // isSidechain stays false (subagents are child sessions — not in a parent read).
      expect(asst.isSidechain).toBe(false);
    });

    it('maps every non-tool-calls finish value to end_turn (boundary), never tool_use', () => {
      // Fail-safe contract: only 'tool-calls' is a continuation. 'stop', '',
      // 'other', and a missing finish key are all boundaries → end_turn.
      for (const finish of ['stop', '', 'other', undefined]) {
        const dbPath = seedDb(newDbPath(), {
          messages: [
            {
              id: 'msg_u',
              timeCreated: 1,
              data: { role: 'user' },
              parts: [{ data: { type: 'text', text: 'q' } }],
            },
            {
              id: 'msg_a',
              timeCreated: 2,
              data:
                finish === undefined
                  ? { role: 'assistant', modelID: 'm' }
                  : { role: 'assistant', modelID: 'm', finish },
              parts: [{ data: { type: 'text', text: 'a' } }],
            },
          ],
        });
        const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
        expect(session.messages[1].stopReason).toBe('end_turn');
      }
    });

    it('marks compaction (isCompactSummary + compactionCount) and renders patch markers', () => {
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_001',
            timeCreated: 1,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [{ data: { type: 'compaction', auto: true, overflow: false } }],
          },
          {
            id: 'msg_002',
            timeCreated: 2,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [{ data: { type: 'patch', hash: 'h', files: ['/a.ts', '/b.ts'] } }],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
      expect(session.metrics.compactionCount).toBe(1);
      expect(session.messages[0].isCompactSummary).toBe(true);
      const patchText = session.messages[1].content[0];
      expect(patchText).toEqual({
        type: 'text',
        text: '📝 Updated 2 file(s):\n- /a.ts\n- /b.ts',
      });
    });

    it('drops empty messages (pure step boundaries) but still counts their tokens', () => {
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'msg_001',
            timeCreated: 1,
            data: { role: 'user' },
            parts: [{ data: { type: 'text', text: 'hi' } }],
          },
          {
            id: 'msg_002',
            timeCreated: 2,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [
              { data: { type: 'step-start', snapshot: 's' } },
              {
                data: {
                  type: 'step-finish',
                  tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                },
              },
            ],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
      // Empty assistant message dropped → only the user message remains.
      expect(session.messages).toHaveLength(1);
      // But its step-finish tokens are still in the totals.
      expect(session.metrics.inputTokens).toBe(50);
      expect(session.metrics.outputTokens).toBe(10);
    });

    it('collects modelsUsed when more than one model appears', () => {
      const dbPath = seedDb(newDbPath(), {
        session: { model: null },
        messages: [
          {
            id: 'm1',
            timeCreated: 1,
            data: { role: 'assistant', modelID: 'glm-5.1' },
            parts: [{ data: { type: 'text', text: 'a' } }],
          },
          {
            id: 'm2',
            timeCreated: 2,
            data: { role: 'assistant', modelID: 'glm-4.6' },
            parts: [{ data: { type: 'text', text: 'b' } }],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
      expect(session.metrics.primaryModel).toBe('glm-5.1'); // first observed
      expect(session.metrics.modelsUsed).toEqual(expect.arrayContaining(['glm-5.1', 'glm-4.6']));
    });

    it('extracts primaryModel id from the JSON session.model column when messages lack modelID', () => {
      const dbPath = seedDb(newDbPath(), {
        session: { model: JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }) },
        messages: [
          {
            id: 'm1',
            timeCreated: 1,
            data: { role: 'user' }, // no modelID anywhere in messages
            parts: [{ data: { type: 'text', text: 'hi' } }],
          },
        ],
      });

      const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
      expect(session.metrics.primaryModel).toBe('claude-sonnet-4-6');
    });
  });

  describe('getFreshness', () => {
    it('returns part count and max time_updated for the session', () => {
      const dbPath = seedDb(newDbPath(), {
        session: { timeUpdated: 100 },
        messages: [
          {
            id: 'm1',
            timeCreated: 10,
            timeUpdated: 500,
            data: { role: 'user' },
            parts: [
              { data: { type: 'text', text: 'a' }, timeUpdated: 300 },
              { data: { type: 'text', text: 'b' }, timeUpdated: 800 },
            ],
          },
        ],
      });

      const fresh = new OpencodeSqliteReader().getFreshness(dbPath, 'ses_test');
      expect(fresh.count).toBe(2);
      expect(fresh.maxUpdated).toBe(800); // max across part/message/session time_updated
    });
  });

  describe('findSessionCandidates', () => {
    function seedCandidate(
      db: DatabaseInstance,
      id: string,
      directory: string,
      timeCreated: number,
    ): void {
      db.prepare(
        `INSERT INTO session (id, title, model, agent, parent_id, directory, time_created, time_updated)
         VALUES (?, '', NULL, '', NULL, ?, ?, ?)`,
      ).run(id, directory, timeCreated, timeCreated);
    }

    it('matches by directory within the launch window, ranked by closeness', () => {
      const dbPath = newDbPath('disc');
      withWritable(dbPath, (db) => {
        db.exec(SCHEMA_SQL);
        seedCandidate(db, 'ses_close', '/home/me/proj', 10_000);
        seedCandidate(db, 'ses_near', '/home/me/proj', 10_500);
        seedCandidate(db, 'ses_other_dir', '/home/me/elsewhere', 10_050);
        seedCandidate(db, 'ses_out_of_window', '/home/me/proj', 999_999);
      });

      const candidates = new OpencodeSqliteReader().findSessionCandidates(dbPath, {
        directory: '/home/me/proj',
        startedAtMs: 10_100,
        windowMs: 2_000,
      });

      // out-of-window and other-directory excluded; closest first.
      expect(candidates.map((c) => c.providerSessionId)).toEqual(['ses_close', 'ses_near']);
    });

    it('also matches via the owning project.worktree', () => {
      const dbPath = newDbPath('disc-wt');
      withWritable(dbPath, (db) => {
        db.exec(SCHEMA_SQL);
        db.prepare(`INSERT INTO project (id, worktree) VALUES ('p1', '/home/me/wt')`).run();
        // directory does NOT match; only the owning project's worktree does.
        db.prepare(
          `INSERT INTO session (id, title, model, agent, parent_id, directory, project_id, time_created, time_updated)
           VALUES ('ses_wt', '', NULL, '', NULL, '/somewhere/else', 'p1', 10000, 10000)`,
        ).run();
      });

      const candidates = new OpencodeSqliteReader().findSessionCandidates(dbPath, {
        directory: '/home/me/wt',
        startedAtMs: 10_000,
        windowMs: 1_000,
      });
      expect(candidates.map((c) => c.providerSessionId)).toEqual(['ses_wt']);
    });
  });

  describe('error handling', () => {
    it('throws NotFoundError for an unknown session id', () => {
      const dbPath = seedDb(newDbPath(), {
        messages: [
          {
            id: 'm1',
            timeCreated: 1,
            data: { role: 'user' },
            parts: [{ data: { type: 'text', text: 'x' } }],
          },
        ],
      });
      expect(() => new OpencodeSqliteReader().readSession(dbPath, 'ses_missing')).toThrow(
        NotFoundError,
      );
    });

    it('throws ValidationError when the DB file does not exist (fileMustExist)', () => {
      const missing = newDbPath('does-not-exist');
      expect(() => new OpencodeSqliteReader().readSession(missing, 'ses_test')).toThrow(
        ValidationError,
      );
    });

    it('fails gracefully (ValidationError) on schema drift — missing table', () => {
      const dbPath = newDbPath('drift');
      withWritable(dbPath, (db) => {
        db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);`);
        // no message / part tables
      });
      expect(() => new OpencodeSqliteReader().readSession(dbPath, 'ses_test')).toThrow(
        ValidationError,
      );
    });

    it('fails gracefully (ValidationError) on schema drift — missing column', () => {
      const dbPath = newDbPath('drift-col');
      withWritable(dbPath, (db) => {
        db.exec(`
          CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
          CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);  -- missing 'data'
          CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
        `);
      });
      expect(() => new OpencodeSqliteReader().getFreshness(dbPath, 'ses_test')).toThrow(
        /schema drift/i,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Local helper: exact UTF-8 byte size of a session's part blobs (oracle)
// ---------------------------------------------------------------------------

function countSeededPartBytes(dbPath: string, sessionId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT data FROM part WHERE session_id = ?').all(sessionId) as {
      data: string;
    }[];
    return rows.reduce((sum, r) => sum + Buffer.byteLength(r.data, 'utf8'), 0);
  } finally {
    db.close();
  }
}
