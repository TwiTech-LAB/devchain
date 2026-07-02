import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAntigravityJsonl, parseAntigravitySteps } from './antigravity-jsonl.parser';

function step(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe('parseAntigravitySteps', () => {
  it('maps USER_INPUT to a user message, unwrapping <USER_REQUEST>', () => {
    const { messages } = parseAntigravitySteps(
      [
        step({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-06-26T22:19:46Z',
          content:
            '<USER_REQUEST>\nReply with PING\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
        }),
      ],
      100,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].parentId).toBeNull();
    expect(messages[0].content).toEqual([{ type: 'text', text: 'Reply with PING' }]);
  });

  it('maps PLANNER_RESPONSE thinking + text into an assistant message (end_turn when no tools)', () => {
    const { messages } = parseAntigravitySteps(
      [
        step({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-06-26T22:19:46Z',
          content: 'PING',
          thinking: 'User asked for PING',
        }),
      ],
      100,
    );

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'User asked for PING' },
      { type: 'text', text: 'PING' },
    ]);
    expect(msg.stopReason).toBe('end_turn');
  });

  it('emits tool_call blocks and folds the following result step onto the same turn', () => {
    const { messages } = parseAntigravitySteps(
      [
        step({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-06-22T11:08:50Z',
          tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/x' } }],
        }),
        step({
          step_index: 3,
          source: 'MODEL',
          type: 'VIEW_FILE',
          status: 'DONE',
          created_at: '2026-06-22T11:09:15Z',
          content: 'File contents here',
        }),
      ],
      100,
    );

    // The result folds onto the assistant turn → still one message.
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.stopReason).toBe('tool_use');
    expect(msg.toolCalls).toEqual([
      { id: 'agy-tc-2-0', name: 'view_file', input: { AbsolutePath: '/tmp/x' }, isTask: false },
    ]);
    expect(msg.toolResults).toEqual([
      { toolCallId: 'agy-tc-2-0', content: 'File contents here', isError: false },
    ]);
    expect(msg.content).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'agy-tc-2-0',
        toolName: 'view_file',
        input: { AbsolutePath: '/tmp/x' },
      },
      {
        type: 'tool_result',
        toolCallId: 'agy-tc-2-0',
        content: 'File contents here',
        isError: false,
      },
    ]);
  });

  it('degrades an unmatched tool-result step to a system meta message', () => {
    const { messages } = parseAntigravitySteps(
      [
        step({
          step_index: 10,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-06-22T11:09:43Z',
          content: 'You have read and write access to the workspace.',
        }),
      ],
      100,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].isMeta).toBe(true);
    expect(messages[0].toolResults).toEqual([]);
  });

  it('maps CHECKPOINT to a compaction-summary system message and counts it', () => {
    const { messages, metrics } = parseAntigravitySteps(
      [
        step({
          step_index: 3,
          source: 'SYSTEM',
          type: 'CHECKPOINT',
          status: 'DONE',
          created_at: '2026-06-26T22:19:47Z',
          content: '{{ CHECKPOINT 0 }} truncated context',
        }),
      ],
      100,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].isCompactSummary).toBe(true);
    expect(messages[0].isMeta).toBe(true);
    expect(metrics.compactionCount).toBe(1);
  });

  it('skips CONVERSATION_HISTORY markers and empty planners', () => {
    const { messages } = parseAntigravitySteps(
      [
        step({ step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE' }),
        step({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' }),
      ],
      100,
    );
    expect(messages).toHaveLength(0);
  });

  it('chains parentId across messages and reports token totals as zero (P1-4 owns tokens)', () => {
    const { messages, metrics } = parseAntigravitySteps(
      [
        step({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-06-26T22:19:46Z',
          content: '<USER_REQUEST>hi</USER_REQUEST>',
        }),
        step({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-06-26T22:19:50Z',
          content: 'hello',
        }),
      ],
      100,
    );

    expect(messages).toHaveLength(2);
    expect(messages[1].parentId).toBe(messages[0].id);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.messageCount).toBe(2);
    expect(metrics.durationMs).toBe(4000);
  });

  it('respects maxMessages', () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      step({ step_index: i, type: 'USER_INPUT', content: `<USER_REQUEST>m${i}</USER_REQUEST>` }),
    );
    const { messages } = parseAntigravitySteps(lines, 100, { maxMessages: 2 });
    expect(messages).toHaveLength(2);
  });

  it('skips malformed JSON lines without throwing', () => {
    const { messages } = parseAntigravitySteps(
      ['not json', step({ type: 'USER_INPUT', content: '<USER_REQUEST>ok</USER_REQUEST>' })],
      100,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('parseAntigravityJsonl', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-parser-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads + parses a JSONL transcript from disk and reports bytesRead', async () => {
    const file = path.join(dir, 'transcript_full.jsonl');
    const content =
      step({ type: 'USER_INPUT', content: '<USER_REQUEST>hi</USER_REQUEST>' }) +
      '\n' +
      step({ type: 'PLANNER_RESPONSE', content: 'hello' }) +
      '\n';
    await fs.writeFile(file, content, 'utf8');

    const result = await parseAntigravityJsonl(file);
    expect(result.messages).toHaveLength(2);
    expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('returns a graceful warning result for a missing file', async () => {
    const result = await parseAntigravityJsonl(path.join(dir, 'nope.jsonl'));
    expect(result.messages).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/could not be read/i);
  });
});
