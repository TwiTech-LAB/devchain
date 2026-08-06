/**
 * Cross-provider message-count parity (parent epic 907caa00 DoD).
 *
 * Invariant under test: a single user prompt followed by an assistant turn that
 * uses N tool rounds (calls + results) and ends with a final text counts as
 * EXACTLY 2 conversational messages on EVERY in-scope provider — Claude, Codex,
 * OpenCode — regardless of how many tool steps happened inside the turn.
 *
 * Each provider is driven through its OWN parser/reader with an equivalent
 * N=2 tool turn (read → write → final text), then the parity invariant is
 * asserted in one place. Per-provider parser specs cover provider-specific
 * edge cases; this spec locks the cross-provider AGREEMENT (the load-bearing
 * product decision that `messageCount` counts turns, not tool calls).
 *
 * Test layer: parser/reader unit (the cheapest layer that proves messageCount
 * for each provider's native format; chunk rendering is covered separately in
 * chunk-builder.spec.ts).
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockLoggerWarn = jest.fn();
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

// Import parsers AFTER the logger mock is declared (mirrors the per-parser specs).
/* eslint-disable @typescript-eslint/no-require-imports */
const { parseClaudeJsonl } =
  require('../parsers/claude-jsonl.parser') as typeof import('../parsers/claude-jsonl.parser');
const { parseCodexJsonl } =
  require('../parsers/codex-jsonl.parser') as typeof import('../parsers/codex-jsonl.parser');
const { OpencodeSqliteReader } =
  require('../readers/opencode-sqlite.reader') as typeof import('../readers/opencode-sqlite.reader');
const { coalesceAssistantTurns } =
  require('../adapters/utils/coalesce-turns') as typeof import('../adapters/utils/coalesce-turns');
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Shared expectations (the parity contract)
// ---------------------------------------------------------------------------

const ROUNDS = 2; // N tool rounds in the single assistant turn
const EXPECTED_MESSAGE_COUNT = 2; // 1 user + 1 coalesced/row-embedded assistant

/**
 * Asserts the parity contract on a parsed assistant turn: messageCount === 2,
 * roles are [user, assistant], the assistant carries N ordered tool calls +
 * results, and the final emitted content block is the assistant's closing text.
 */
function assertParityTurn(
  messages: {
    role: string;
    toolCalls: { id: string }[];
    toolResults: { toolCallId: string }[];
    content: { type: string }[];
  }[],
  messageCount: number,
  expectedCallIds: string[],
): void {
  expect(messageCount).toBe(EXPECTED_MESSAGE_COUNT);
  expect(messages).toHaveLength(EXPECTED_MESSAGE_COUNT);
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);

  const asst = messages[1];
  expect(asst.toolCalls.map((c) => c.id)).toEqual(expectedCallIds);
  expect(asst.toolResults.map((r) => r.toolCallId)).toEqual(expectedCallIds);

  // The trailing content block is the assistant's final text (rendering endpoint).
  expect(asst.content[asst.content.length - 1].type).toBe('text');
  // Each tool round contributes one tool_call AND one tool_result to the render order.
  const callBlocks = asst.content.filter((b) => b.type === 'tool_call');
  const resultBlocks = asst.content.filter((b) => b.type === 'tool_result');
  expect(callBlocks).toHaveLength(ROUNDS);
  expect(resultBlocks).toHaveLength(ROUNDS);
}

// ---------------------------------------------------------------------------
// Claude fixture (JSONL: tool turn split across lines → parser folds)
// ---------------------------------------------------------------------------

function writeClaudeJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parity-'));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return filePath;
}

function claudeParityFixture(): string {
  // user → tool_use#1 (paused) → tool_result#1 → tool_use#2 (paused) → tool_result#2
  // → final text (end_turn). The parser folds the tool_results and coalesces the
  // continuation assistants into ONE assistant turn.
  const user = {
    type: 'user',
    uuid: 'user-1',
    parentUuid: null,
    isSidechain: false,
    timestamp: '2026-01-01T10:00:00.000Z',
    message: { role: 'user', content: 'Check and fix the bug' },
  };
  const toolUse = (id: string, name: string, parent: string, ts: string) => ({
    type: 'assistant',
    uuid: `asst-${id}`,
    parentUuid: parent,
    isSidechain: false,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id, name, input: { path: '/src/auth.ts' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  });
  const toolResult = (id: string, parent: string, ts: string, output: string) => ({
    type: 'user',
    uuid: `user-${id}`,
    parentUuid: parent,
    isSidechain: false,
    isMeta: true,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }],
    },
  });
  const finalAsst = {
    type: 'assistant',
    uuid: 'asst-final',
    parentUuid: 'user-tool-2',
    isSidechain: false,
    timestamp: '2026-01-01T10:00:30.000Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'All done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 40 },
    },
  };
  return writeClaudeJsonl([
    user,
    toolUse('tool-1', 'read', 'user-1', '2026-01-01T10:00:05.000Z'),
    toolResult('tool-1', 'asst-tool-1', '2026-01-01T10:00:06.000Z', 'file contents'),
    toolUse('tool-2', 'write', 'user-tool-1', '2026-01-01T10:00:20.000Z'),
    toolResult('tool-2', 'asst-tool-2', '2026-01-01T10:00:21.000Z', 'ok'),
    finalAsst,
  ]);
}

// ---------------------------------------------------------------------------
// Codex fixture (JSONL: tool turn across response items → parser coalesces)
// ---------------------------------------------------------------------------

function writeCodexJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parity-'));
  const filePath = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return filePath;
}

function codexParityFixture(): string {
  const line = (timestamp: string, type: string, payload: object) => ({ timestamp, type, payload });
  const responseItem = (timestamp: string, payload: object) =>
    line(timestamp, 'response_item', payload);
  return writeCodexJsonl([
    line('2026-02-24T10:00:00.000Z', 'session_meta', {
      id: 'codex-parity',
      cwd: '/proj',
      cli_version: '0.77.0',
      source: 'Cli',
      model_provider: 'openai',
    }),
    line('2026-02-24T10:00:01.000Z', 'turn_context', {
      model: 'o3',
      approval_policy: 'on-request',
    }),
    line('2026-02-24T10:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn_001' }),
    responseItem('2026-02-24T10:00:03.000Z', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Check and fix the bug' }],
    }),
    responseItem('2026-02-24T10:00:05.000Z', {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: JSON.stringify({ path: '/src/auth.ts' }),
    }),
    responseItem('2026-02-24T10:00:06.000Z', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file contents',
    }),
    responseItem('2026-02-24T10:00:08.000Z', {
      type: 'function_call',
      call_id: 'call_2',
      name: 'write_file',
      arguments: JSON.stringify({ path: '/src/auth.ts' }),
    }),
    responseItem('2026-02-24T10:00:09.000Z', {
      type: 'function_call_output',
      call_id: 'call_2',
      output: 'ok',
    }),
    responseItem('2026-02-24T10:00:10.000Z', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'All done.' }],
    }),
    line('2026-02-24T10:00:11.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn_001' }),
  ]);
}

// ---------------------------------------------------------------------------
// OpenCode fixture (SQLite: one assistant ROW per STEP → coalescer folds)
// ---------------------------------------------------------------------------

const OPENCODE_SCHEMA = `
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

function opencodeParityDbPath(): string {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parity-')),
    `opencode-${Math.floor(Math.random() * 1e9)}.db`,
  );
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(OPENCODE_SCHEMA);
    db.prepare(
      `INSERT INTO session (id, title, model, agent, parent_id, time_created, time_updated)
       VALUES ('ses_test', 'Parity', 'glm-5.1', 'build', NULL, 1000, 9999)`,
    ).run();
    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses_test', ?, ?, ?)`,
    );
    const insPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'ses_test', ?, ?, ?)`,
    );

    // Real OpenCode shape: ONE assistant ROW per agent STEP. A tool turn spans
    // several rows; each carries `data.finish` ('tool-calls' = continuation,
    // 'stop' = boundary). The reader maps finish → stopReason and the shared
    // coalescer folds the step-rows into one assistant (same logical turn as
    // the Claude/Codex fixtures above).
    insMsg.run('msg_user', 1000, 1000, JSON.stringify({ role: 'user' }));
    insPart.run(
      'p_u_1',
      'msg_user',
      1000,
      1000,
      JSON.stringify({ type: 'text', text: 'Check and fix the bug' }),
    );

    // Step 1 — tool read (continuation: finish 'tool-calls').
    insMsg.run(
      'msg_asst_1',
      2000,
      2000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'glm-5.1',
        parentID: 'msg_user',
        finish: 'tool-calls',
        tokens: { input: 200, output: 60, reasoning: 10, cache: { read: 5, write: 5 } },
      }),
    );
    const step1Parts: object[] = [
      { type: 'text', text: 'Let me investigate.' },
      {
        type: 'tool',
        callID: 'call_1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/src/auth.ts' },
          output: 'file contents',
        },
      },
      {
        type: 'step-finish',
        tokens: { input: 200, output: 60, reasoning: 10, cache: { read: 5, write: 5 } },
      },
    ];
    step1Parts.forEach((p, i) =>
      insPart.run(`p_a1_${i}`, 'msg_asst_1', 2000, 2000, JSON.stringify(p)),
    );

    // Step 2 — tool write (continuation: finish 'tool-calls').
    insMsg.run(
      'msg_asst_2',
      3000,
      3000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'glm-5.1',
        parentID: 'msg_asst_1',
        finish: 'tool-calls',
        tokens: { input: 300, output: 40, cache: { read: 10 } },
      }),
    );
    const step2Parts: object[] = [
      { type: 'text', text: 'Found it, applying the fix.' },
      {
        type: 'tool',
        callID: 'call_2',
        tool: 'write',
        state: { status: 'completed', input: { filePath: '/src/auth.ts' }, output: 'ok' },
      },
      { type: 'step-finish', tokens: { input: 300, output: 40, cache: { read: 10 } } },
    ];
    step2Parts.forEach((p, i) =>
      insPart.run(`p_a2_${i}`, 'msg_asst_2', 3000, 3000, JSON.stringify(p)),
    );

    // Step 3 — final text (boundary: finish 'stop').
    insMsg.run(
      'msg_asst_3',
      4000,
      4000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'glm-5.1',
        parentID: 'msg_asst_2',
        finish: 'stop',
        tokens: { input: 400, output: 20, cache: { read: 15 } },
      }),
    );
    const step3Parts: object[] = [
      { type: 'text', text: 'All done.' },
      { type: 'step-finish', tokens: { input: 400, output: 20, cache: { read: 15 } } },
    ];
    step3Parts.forEach((p, i) =>
      insPart.run(`p_a3_${i}`, 'msg_asst_3', 4000, 4000, JSON.stringify(p)),
    );
  } finally {
    db.close();
  }
  return dbPath;
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe('cross-provider message-count parity (parent epic 907caa00)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Claude: an N=2 tool turn yields messageCount 2', async () => {
    const filePath = claudeParityFixture();
    try {
      const result = await parseClaudeJsonl(filePath);
      assertParityTurn(result.messages as never, result.metrics.messageCount, ['tool-1', 'tool-2']);
    } finally {
      fs.unlinkSync(filePath);
      fs.rmdirSync(path.dirname(filePath));
    }
  });

  it('Codex: an N=2 tool turn yields messageCount 2', async () => {
    const filePath = codexParityFixture();
    try {
      const result = await parseCodexJsonl(filePath);
      assertParityTurn(result.messages as never, result.metrics.messageCount, ['call_1', 'call_2']);
    } finally {
      fs.unlinkSync(filePath);
      fs.rmdirSync(path.dirname(filePath));
    }
  });

  it('OpenCode: a multi-row N=2 tool turn coalesces to messageCount 2', () => {
    const dbPath = opencodeParityDbPath();
    const { session } = new OpencodeSqliteReader().readSession(dbPath, 'ses_test');
    // The reader emits finish→stopReason per step-row; the shared coalescer
    // (applied centrally in getOrParse) folds the step-rows into one assistant.
    const coalesced = coalesceAssistantTurns(session);
    assertParityTurn(coalesced.messages as never, coalesced.metrics.messageCount, [
      'call_1',
      'call_2',
    ]);
  });

  it('PARITY INVARIANT: Claude == Codex == OpenCode == 2 for an equivalent N-tool turn', async () => {
    // Drive all three providers and lock the agreement: every provider reports
    // exactly 2 messages for the same logical turn. A regression on ANY provider
    // that re-introduces per-tool-call inflation fails here.
    const claudePath = claudeParityFixture();
    const codexPath = codexParityFixture();
    const opencodePath = opencodeParityDbPath();
    try {
      const [claude, codex] = await Promise.all([
        parseClaudeJsonl(claudePath),
        parseCodexJsonl(codexPath),
      ]);
      const opencodeRaw = new OpencodeSqliteReader().readSession(opencodePath, 'ses_test');
      const opencode = coalesceAssistantTurns(opencodeRaw.session);

      const counts = [
        claude.metrics.messageCount,
        codex.metrics.messageCount,
        opencode.metrics.messageCount,
      ];
      expect(counts).toEqual([2, 2, 2]);
      expect(new Set(counts).size).toBe(1); // all identical
    } finally {
      fs.unlinkSync(claudePath);
      fs.rmdirSync(path.dirname(claudePath));
      fs.unlinkSync(codexPath);
      fs.rmdirSync(path.dirname(codexPath));
    }
  });
});
