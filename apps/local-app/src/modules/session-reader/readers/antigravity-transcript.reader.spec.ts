import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravityTranscriptReader } from './antigravity-transcript.reader';

const CONV_ID = '10d533ea-3b1b-4b56-817e-7da6fc19c6cb';

describe('AntigravityTranscriptReader', () => {
  let root: string;
  let dbPath: string;
  let jsonlPath: string;
  let reader: AntigravityTranscriptReader;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-reader-'));
    dbPath = path.join(root, 'conversations', `${CONV_ID}.db`);
    jsonlPath = path.join(
      root,
      'brain',
      CONV_ID,
      '.system_generated',
      'logs',
      'transcript_full.jsonl',
    );
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
    reader = new AntigravityTranscriptReader();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves the JSONL path by convention from the .db path', () => {
    expect(reader.resolveJsonlPath(dbPath, CONV_ID)).toBe(jsonlPath);
  });

  it('reads the session, keying id on the conversation id and filePath on the .db', async () => {
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    const content =
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>hi</USER_REQUEST>' }) +
      '\n' +
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'hello' }) +
      '\n';
    await fs.writeFile(jsonlPath, content, 'utf8');

    const { session, sizeBytes } = await reader.readSession(dbPath, CONV_ID);
    expect(session.id).toBe(CONV_ID);
    expect(session.providerName).toBe('agy');
    expect(session.filePath).toBe(dbPath);
    expect(session.messages).toHaveLength(2);
    expect(sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('freshness maxUpdated is the max of jsonl and db mtimes', async () => {
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    await fs.writeFile(jsonlPath, '{}', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(jsonlPath, future, future);

    const freshness = await reader.getFreshness(dbPath, CONV_ID);
    expect(freshness.jsonl.mtimeMs).toBeGreaterThan(freshness.db.mtimeMs);
    expect(freshness.maxUpdated).toBe(freshness.jsonl.mtimeMs);
  });

  it('reports zeros for a missing file rather than throwing', async () => {
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    // jsonl intentionally absent
    const freshness = await reader.getFreshness(dbPath, CONV_ID);
    expect(freshness.jsonl).toEqual({ mtimeMs: 0, size: 0 });
    expect(freshness.db.mtimeMs).toBeGreaterThan(0);
    expect(freshness.maxUpdated).toBe(freshness.db.mtimeMs);
  });

  // ⭐ KEYSTONE (deferred from P1-3): a same-message-count / same-SIZE rewrite of
  // transcript_full.jsonl MUST advance the freshness `maxUpdated`. `maxUpdated` is the
  // numeric the cache keys its DB `sourceVersion` on (SessionCacheService.dbSourceVersion),
  // so an advancing value is what makes the transcript cursor re-derive on an in-place
  // edit that does NOT change byte size — a byte-size version would freeze here (stale read).
  it('⭐ advances maxUpdated on a SAME-SIZE jsonl rewrite (cursor advance, no stale read)', async () => {
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    const content =
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>hi</USER_REQUEST>' }) + '\n';
    await fs.writeFile(jsonlPath, content, 'utf8');

    const before = await reader.getFreshness(dbPath, CONV_ID);
    const sizeBefore = before.jsonl.size;

    // Identical bytes rewritten later → mtime advances, byte size unchanged.
    const later = new Date(Date.now() + 60_000);
    await fs.writeFile(jsonlPath, content, 'utf8');
    await fs.utimes(jsonlPath, later, later);

    const after = await reader.getFreshness(dbPath, CONV_ID);
    expect(after.jsonl.size).toBe(sizeBefore); // identical byte size (same message count)
    expect(after.maxUpdated).toBeGreaterThan(before.maxUpdated); // cursor advances anyway
  });

  it('reads the sanitized fixture transcript and maps the event types to unified messages', async () => {
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    const fixture = await fs.readFile(
      path.join(__dirname, '..', '__fixtures__', 'antigravity-transcript_full.jsonl'),
      'utf8',
    );
    await fs.writeFile(jsonlPath, fixture, 'utf8');

    const { session } = await reader.readSession(dbPath, CONV_ID);
    // USER_INPUT(user) + GENERIC(system) + PLANNER_RESPONSE tool_use→VIEW_FILE folded(assistant)
    // + PLANNER_RESPONSE end_turn(assistant) + CHECKPOINT(system). CONVERSATION_HISTORY skipped.
    expect(session.messages).toHaveLength(5);
    expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(session.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(session.messages.filter((m) => m.role === 'system')).toHaveLength(2);
    const toolTurn = session.messages.find((m) => m.stopReason === 'tool_use');
    expect(toolTurn?.toolCalls).toHaveLength(1);
    expect(toolTurn?.toolResults).toHaveLength(1); // VIEW_FILE result folded onto the call
  });
});
