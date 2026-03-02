import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { buildChunks } from '../builders/chunk-builder';
import { getHeaderTokens } from '../../../ui/utils/ai-group-enhancer';

const mockLoggerWarn = jest.fn();
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

// Must import parser after mock is set up (jest.mock is hoisted but this makes intent clear)
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { parseCodexJsonl } =
  require('./codex-jsonl.parser') as typeof import('./codex-jsonl.parser');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpFile(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function sessionMeta(id = 'test-session-id'): object {
  return {
    timestamp: '2026-02-24T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      cwd: '/home/user/project',
      cli_version: '0.77.0',
      source: 'Cli',
      model_provider: 'openai',
    },
  };
}

function turnContext(model = 'o3'): object {
  return {
    timestamp: '2026-02-24T10:00:01.000Z',
    type: 'turn_context',
    payload: { model, approval_policy: 'on-request' },
  };
}

function taskStarted(turnId = 'turn_001'): object {
  return {
    timestamp: '2026-02-24T10:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId },
  };
}

function turnStarted(turnId = 'turn_002', ts = '2026-02-24T10:00:02.500Z'): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'turn_started', turn_id: turnId },
  };
}

function userMessage(text: string, ts = '2026-02-24T10:00:03.000Z'): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantMessage(text: string, ts = '2026-02-24T10:00:05.000Z'): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
}

function reasoning(text: string, ts = '2026-02-24T10:00:04.000Z'): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text }],
    },
  };
}

function functionCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  ts = '2026-02-24T10:00:06.000Z',
): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function functionCallOutput(
  callId: string,
  output: string,
  ts = '2026-02-24T10:00:07.000Z',
): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  };
}

function shellCall(callId: string, command: string[], ts = '2026-02-24T10:00:06.000Z'): object {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'local_shell_call',
      call_id: callId,
      status: 'completed',
      action: { type: 'exec', command },
    },
  };
}

/**
 * Build a Codex token_count event.
 * In real Codex format, input_tokens INCLUDES cached_input_tokens.
 * @param input - total input tokens (includes cached)
 * @param cached - cached input tokens (subset of input)
 * @param output - output tokens (excluding reasoning)
 */
function tokenCount(
  input: number,
  cached: number,
  output: number,
  ts = '2026-02-24T10:00:08.000Z',
): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
        model_context_window: 128000,
      },
    },
  };
}

function taskComplete(turnId = 'turn_001', ts = '2026-02-24T10:00:09.000Z'): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId },
  };
}

function turnComplete(turnId = 'turn_002', ts = '2026-02-24T10:00:09.500Z'): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'turn_complete', turn_id: turnId },
  };
}

function compacted(message = 'Compacted context summary'): object {
  return {
    timestamp: '2026-02-24T10:01:00.000Z',
    type: 'compacted',
    payload: { message },
  };
}

function compactedNoMessage(ts = '2026-02-24T10:01:00.000Z'): object {
  return {
    timestamp: ts,
    type: 'compacted',
    payload: {},
  };
}

function contextCompacted(ts = '2026-02-24T10:01:00.000Z'): object {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexJsonlParser', () => {
  afterEach(() => {
    // Clean up temp files is handled by OS
  });

  it('parses session metadata and extracts session ID', async () => {
    const file = tmpFile([sessionMeta('my-session-uuid'), turnContext()]);
    const result = await parseCodexJsonl(file);

    expect(result.sessionId).toBe('my-session-uuid');
  });

  it('parses a simple user → assistant exchange', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello Codex'),
      assistantMessage('Hi! How can I help?'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello Codex' });
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'Hi! How can I help?' });
  });

  it('coalesces reasoning into assistant message', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Fix the bug'),
      reasoning('Let me think about this...'),
      assistantMessage('I found the issue.'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.messages).toHaveLength(2);
    const assistant = result.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Let me think about this...',
    });
    expect(assistant.content[1]).toEqual({ type: 'text', text: 'I found the issue.' });
  });

  it('maps function_call and function_call_output to tool calls/results', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Read the file'),
      functionCall('call_1', 'read_file', { path: '/tmp/test.txt' }),
      functionCallOutput('call_1', 'file contents here'),
      assistantMessage('The file contains...'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    // user, assistant (with tool call), user (tool result), assistant (text)
    expect(result.messages.length).toBeGreaterThanOrEqual(3);

    // Find the assistant message with tool calls
    const assistantWithTools = result.messages.find(
      (m) => m.role === 'assistant' && m.toolCalls.length > 0,
    );
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.toolCalls[0].name).toBe('read_file');
    expect(assistantWithTools!.toolCalls[0].id).toBe('call_1');

    // Find the tool result message
    const toolResultMsg = result.messages.find((m) => m.toolResults.length > 0);
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.toolResults[0].toolCallId).toBe('call_1');
    expect(toolResultMsg!.toolResults[0].content).toBe('file contents here');
  });

  it('maps local_shell_call to tool call', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('List files'),
      shellCall('call_shell', ['bash', '-lc', 'ls -la']),
      assistantMessage('Here are the files'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    const assistantWithTools = result.messages.find(
      (m) => m.role === 'assistant' && m.toolCalls.length > 0,
    );
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.toolCalls[0].name).toBe('shell');
    expect(assistantWithTools!.toolCalls[0].input).toEqual({ command: 'bash -lc ls -la' });
  });

  it('extracts token metrics from token_count events (cumulative)', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(1000, 500, 200),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.inputTokens).toBe(500);
    expect(result.metrics.cacheReadTokens).toBe(500);
    expect(result.metrics.outputTokens).toBe(200);
    expect(result.metrics.totalTokens).toBe(1200);
    expect(result.metrics.totalContextTokens).toBe(1200); // single snapshot fallback
    expect(result.metrics.contextWindowTokens).toBe(128000);
  });

  it('attaches per-turn usage to the last assistant message in a turn', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      userMessage('Start'),
      assistantMessage('First assistant response', '2026-02-24T10:00:04.000Z'),
      functionCall('call_1', 'read_file', { path: 'README.md' }, '2026-02-24T10:00:05.000Z'),
      functionCallOutput('call_1', 'ok', '2026-02-24T10:00:06.000Z'),
      assistantMessage('Final assistant response', '2026-02-24T10:00:07.000Z'),
      tokenCount(220, 20, 80, '2026-02-24T10:00:08.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:09.000Z'),
    ]);

    const result = await parseCodexJsonl(file);
    const firstAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some((block) => block.type === 'text' && block.text.includes('First assistant')),
    );
    const finalAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some((block) => block.type === 'text' && block.text.includes('Final assistant')),
    );

    expect(firstAssistant).toBeDefined();
    expect(firstAssistant!.usage).toBeUndefined();
    expect(finalAssistant).toBeDefined();
    expect(finalAssistant!.usage).toEqual({
      input: 200,
      output: 80,
      cacheRead: 20,
      cacheCreation: 0,
    });
  });

  it('computes per-turn usage deltas correctly across multiple turns', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      assistantMessage('Turn 1 assistant', '2026-02-24T10:00:03.000Z'),
      tokenCount(120, 20, 40, '2026-02-24T10:00:04.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:05.000Z'),
      taskStarted('turn_002'),
      assistantMessage('Turn 2 assistant', '2026-02-24T10:01:00.000Z'),
      tokenCount(300, 80, 95, '2026-02-24T10:01:01.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:02.000Z'),
    ]);

    const result = await parseCodexJsonl(file);
    const assistants = result.messages.filter((m) => m.role === 'assistant');

    expect(assistants).toHaveLength(2);
    expect(assistants[0].usage).toEqual({
      input: 100,
      output: 40,
      cacheRead: 20,
      cacheCreation: 0,
    });
    expect(assistants[1].usage).toEqual({
      input: 120,
      output: 55,
      cacheRead: 60,
      cacheCreation: 0,
    });
  });

  it('attaches usage during EOF drain when a turn remains open', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      assistantMessage('Still working', '2026-02-24T10:00:03.000Z'),
      tokenCount(180, 30, 70, '2026-02-24T10:00:04.000Z'),
      // no task_complete (open turn)
    ]);

    const result = await parseCodexJsonl(file);
    const assistant = result.messages.find((m) => m.role === 'assistant');

    expect(assistant).toBeDefined();
    expect(assistant!.usage).toEqual({
      input: 150,
      output: 70,
      cacheRead: 30,
      cacheCreation: 0,
    });
    expect(result.metrics.isOngoing).toBe(true);
  });

  it('keeps usage on the last assistant only when a turn flushes mid-stream', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      assistantMessage('Pre-tool assistant', '2026-02-24T10:00:03.000Z'),
      functionCall('call_mid', 'run', { cmd: 'ls' }, '2026-02-24T10:00:04.000Z'),
      functionCallOutput('call_mid', 'ok', '2026-02-24T10:00:05.000Z'),
      assistantMessage('Post-tool assistant', '2026-02-24T10:00:06.000Z'),
      tokenCount(260, 60, 90, '2026-02-24T10:00:07.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:08.000Z'),
    ]);

    const result = await parseCodexJsonl(file);
    const preToolAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some((block) => block.type === 'text' && block.text.includes('Pre-tool')),
    );
    const postToolAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.content.some((block) => block.type === 'text' && block.text.includes('Post-tool')),
    );

    expect(preToolAssistant).toBeDefined();
    expect(preToolAssistant!.usage).toBeUndefined();
    expect(postToolAssistant).toBeDefined();
    expect(postToolAssistant!.usage).toEqual({
      input: 200,
      output: 90,
      cacheRead: 60,
      cacheCreation: 0,
    });
  });

  it('per-turn usage reflects last API call (not cumulative turn consumption) when multiple token_count events fire', async () => {
    // Simulates a turn with 3 tool-call round-trips, each producing a token_count event.
    // Cumulative totals grow: 50k → 101k → 153k input.
    // The header should show ~52k (last API call), not ~153k (total consumption).
    const file = tmpFile([
      sessionMeta(),
      turnContext('gpt-5.3-codex'),
      taskStarted('turn_001'),
      userMessage('Fix the bug'),
      assistantMessage('Let me check', '2026-02-24T10:00:04.000Z'),
      functionCall('call_1', 'read_file', { path: 'src/index.ts' }, '2026-02-24T10:00:05.000Z'),
      functionCallOutput('call_1', 'file contents', '2026-02-24T10:00:06.000Z'),
      // After 1st API call: cumulative input=50k (cache=5k)
      tokenCount(50000, 5000, 2000, '2026-02-24T10:00:06.500Z'),
      assistantMessage('Found it, applying fix', '2026-02-24T10:00:07.000Z'),
      functionCall('call_2', 'write_file', { path: 'src/index.ts' }, '2026-02-24T10:00:08.000Z'),
      functionCallOutput('call_2', 'ok', '2026-02-24T10:00:09.000Z'),
      // After 2nd API call: cumulative input=101k (cache=10k)
      tokenCount(101000, 10000, 5000, '2026-02-24T10:00:09.500Z'),
      assistantMessage('Fix applied, running tests', '2026-02-24T10:00:10.000Z'),
      functionCall('call_3', 'run_tests', {}, '2026-02-24T10:00:11.000Z'),
      functionCallOutput('call_3', 'all pass', '2026-02-24T10:00:12.000Z'),
      // After 3rd API call: cumulative input=153k (cache=15k)
      tokenCount(153000, 15000, 8000, '2026-02-24T10:00:12.500Z'),
      assistantMessage('All tests pass', '2026-02-24T10:00:13.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:14.000Z'),
    ]);

    const result = await parseCodexJsonl(file);
    // Find the LAST assistant message (usage is attached to it)
    const assistants = result.messages.filter((m) => m.role === 'assistant');
    const lastAssistant = assistants[assistants.length - 1];

    expect(lastAssistant.usage).toBeDefined();
    // Should reflect last API call delta (153k→101k), NOT total turn (153k→0).
    // input: (153000-15000) - (101000-10000) = 138000 - 91000 = 47000
    // output: 8000 - 5000 = 3000
    // cacheRead: 15000 - 10000 = 5000
    expect(lastAssistant.usage!.input).toBe(47000);
    expect(lastAssistant.usage!.output).toBe(3000);
    expect(lastAssistant.usage!.cacheRead).toBe(5000);
  });

  it('does not mutate prior assistant usage when a later turn has no assistant', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      assistantMessage('Turn 1 response', '2026-02-24T10:00:03.000Z'),
      tokenCount(110, 10, 30, '2026-02-24T10:00:04.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:05.000Z'),
      taskStarted('turn_002'),
      userMessage('Turn 2 user only', '2026-02-24T10:01:00.000Z'),
      tokenCount(200, 50, 45, '2026-02-24T10:01:01.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:02.000Z'),
    ]);

    const result = await parseCodexJsonl(file);
    const assistants = result.messages.filter((m) => m.role === 'assistant');

    expect(assistants).toHaveLength(1);
    expect(assistants[0].usage).toEqual({
      input: 100,
      output: 30,
      cacheRead: 10,
      cacheCreation: 0,
    });
  });

  it('surfaces non-zero header tokens through parse -> buildChunks -> getHeaderTokens', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      userMessage('Summarize'),
      assistantMessage('Summary ready', '2026-02-24T10:00:03.000Z'),
      tokenCount(160, 20, 50, '2026-02-24T10:00:04.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:05.000Z'),
    ]);

    const parsed = await parseCodexJsonl(file);
    const chunks = buildChunks(parsed.messages);
    const aiChunk = chunks.find((chunk) => chunk.type === 'ai');
    expect(aiChunk).toBeDefined();

    if (!aiChunk || aiChunk.type !== 'ai') {
      throw new Error('Expected an AI chunk from parsed Codex messages');
    }

    const header = getHeaderTokens(aiChunk);
    expect(header).toEqual({
      input: 140,
      output: 50,
      cacheRead: 20,
      cacheCreation: 0,
    });
    expect((header?.input ?? 0) + (header?.output ?? 0) + (header?.cacheRead ?? 0)).toBeGreaterThan(
      0,
    );
  });

  it('uses last token_count for final metrics (cumulative)', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(500, 200, 100),
      taskComplete(),
      taskStarted('turn_002'),
      userMessage('More', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Sure', '2026-02-24T10:01:01.000Z'),
      tokenCount(1200, 800, 300, '2026-02-24T10:01:02.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:03.000Z'),
    ]);

    const result = await parseCodexJsonl(file);

    // Should use the LAST cumulative token_count
    expect(result.metrics.inputTokens).toBe(400);
    expect(result.metrics.cacheReadTokens).toBe(800);
    expect(result.metrics.outputTokens).toBe(300);
    expect(result.metrics.totalContextTokens).toBe(900); // (400+800+300) - (300+200+100)
  });

  it('emits delta token metrics for incremental parse with byteOffset', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(1000, 500, 200),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      taskStarted('turn_002'),
      userMessage('More work', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Done', '2026-02-24T10:01:01.000Z'),
      tokenCount(1300, 650, 260, '2026-02-24T10:01:02.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:03.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });

    expect(incremental.metrics.inputTokens).toBe(150);
    expect(incremental.metrics.cacheReadTokens).toBe(150);
    expect(incremental.metrics.outputTokens).toBe(60);
    expect(incremental.metrics.totalTokens).toBe(360);
    expect(incremental.metrics.totalContextTokens).toBe(360);
    expect(incremental.metrics.visibleContextTokens).toBe(4); // "More work"(3) + "Done"(1)
  });

  it('incremental parse attaches usage when turn started before offset', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      userMessage('Start'),
    ]);
    const initial = await parseCodexJsonl(file);
    const byteOffset = initial.bytesRead;

    const appendedLines = [
      assistantMessage('Split-turn response', '2026-02-24T10:01:00.000Z'),
      tokenCount(1000, 500, 200, '2026-02-24T10:01:01.000Z'),
      taskComplete('turn_001', '2026-02-24T10:01:02.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    const assistant = incremental.messages.find((m) => m.role === 'assistant');

    expect(assistant).toBeDefined();
    expect(assistant!.usage).toEqual({
      input: 500,
      output: 200,
      cacheRead: 500,
      cacheCreation: 0,
    });
  });

  it('incremental parse with nested open turns seeds correct stack depth', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_outer'),
      turnStarted('turn_inner'),
    ]);
    const initial = await parseCodexJsonl(file);
    const byteOffset = initial.bytesRead;

    const appendedLines = [
      assistantMessage('Nested inner response', '2026-02-24T10:01:00.000Z'),
      tokenCount(400, 100, 80, '2026-02-24T10:01:01.000Z'),
      turnComplete('turn_inner', '2026-02-24T10:01:02.000Z'),
      tokenCount(700, 250, 120, '2026-02-24T10:01:03.000Z'),
      taskComplete('turn_outer', '2026-02-24T10:01:04.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    const assistant = incremental.messages.find((m) => m.role === 'assistant');

    expect(assistant).toBeDefined();
    expect(assistant!.usage).toEqual({
      input: 300,
      output: 80,
      cacheRead: 100,
      cacheCreation: 0,
    });
    expect(incremental.metrics.isOngoing).toBe(false);
  });

  it('incremental split-turn parse -> buildChunks -> getHeaderTokens non-zero', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted('turn_001'),
      userMessage('Start'),
    ]);
    const initial = await parseCodexJsonl(file);
    const byteOffset = initial.bytesRead;

    const appendedLines = [
      assistantMessage('Split-turn summary', '2026-02-24T10:01:00.000Z'),
      tokenCount(1000, 500, 200, '2026-02-24T10:01:01.000Z'),
      taskComplete('turn_001', '2026-02-24T10:01:02.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    const assistant = incremental.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.usage).toEqual({
      input: 500,
      output: 200,
      cacheRead: 500,
      cacheCreation: 0,
    });

    const chunks = buildChunks(incremental.messages);
    const aiChunk = chunks.find((chunk) => chunk.type === 'ai');
    expect(aiChunk).toBeDefined();

    if (!aiChunk || aiChunk.type !== 'ai') {
      throw new Error('Expected an AI chunk from incremental split-turn parse');
    }

    const header = getHeaderTokens(aiChunk);
    expect(header).toEqual({
      input: 500,
      output: 200,
      cacheRead: 500,
      cacheCreation: 0,
    });
    expect(header).not.toBeNull();
    expect((header?.input ?? 0) + (header?.output ?? 0)).toBeGreaterThan(0);
  });

  it('returns totalContextTokens=0 when incremental slice has no token_count events', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(100, 20, 30),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      taskStarted('turn_002'),
      userMessage('User-only delta', '2026-02-24T10:01:00.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:01.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });

    expect(incremental.metrics.inputTokens).toBe(0);
    expect(incremental.metrics.cacheReadTokens).toBe(0);
    expect(incremental.metrics.outputTokens).toBe(0);
    expect(incremental.metrics.totalTokens).toBe(0);
    expect(incremental.metrics.totalContextTokens).toBe(0);
  });

  it('computes net delta when incremental section contains multiple cumulative token_count events', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(100, 20, 30),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      taskStarted('turn_002'),
      userMessage('Continue', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Working', '2026-02-24T10:01:01.000Z'),
      tokenCount(120, 25, 35, '2026-02-24T10:01:02.000Z'),
      tokenCount(150, 40, 50, '2026-02-24T10:01:03.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:04.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });

    expect(incremental.metrics.inputTokens).toBe(30); // (150-40) - (100-20)
    expect(incremental.metrics.cacheReadTokens).toBe(20); // 40 - 20
    expect(incremental.metrics.outputTokens).toBe(20); // 50 - 30
    expect(incremental.metrics.totalTokens).toBe(70);
    expect(incremental.metrics.totalContextTokens).toBe(45); // (110+40+50) - (95+25+35)
  });

  it('full parse plus incremental deltas matches latest cumulative totals', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Start'),
      assistantMessage('Ack'),
      tokenCount(1000, 500, 200),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const baseline = await parseCodexJsonl(file);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      taskStarted('turn_002'),
      userMessage('Next', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Done', '2026-02-24T10:01:01.000Z'),
      tokenCount(1500, 700, 320, '2026-02-24T10:01:02.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:03.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });

    expect(baseline.metrics.inputTokens + incremental.metrics.inputTokens).toBe(800);
    expect(baseline.metrics.cacheReadTokens + incremental.metrics.cacheReadTokens).toBe(700);
    expect(baseline.metrics.outputTokens + incremental.metrics.outputTokens).toBe(320);
  });

  it('uses baseline model for incremental cost when slice has no turn_context', async () => {
    const mockPricing: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(0.0123),
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
    };

    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Start'),
      assistantMessage('Ack'),
      tokenCount(100, 20, 30),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      assistantMessage('Continuing', '2026-02-24T10:01:00.000Z'),
      tokenCount(150, 30, 40, '2026-02-24T10:01:01.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset, pricingService: mockPricing });

    expect(incremental.metrics.primaryModel).toBe('o3');
    expect(incremental.metrics.costUsd).toBe(0.0123);
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith('o3', 40, 10, 10, 0);
  });

  it('keeps incremental isOngoing=true when turn started before offset and not completed in slice', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Start'),
      assistantMessage('Working'),
      tokenCount(100, 20, 30),
      // no taskComplete before offset
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      assistantMessage('Still working', '2026-02-24T10:01:00.000Z'),
      tokenCount(110, 25, 34, '2026-02-24T10:01:01.000Z'),
      // still no taskComplete in slice
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    expect(incremental.metrics.isOngoing).toBe(true);
  });

  it('closes baseline-open turn when incremental slice contains task_complete only', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Start'),
      assistantMessage('Working'),
      tokenCount(100, 20, 30),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      tokenCount(120, 25, 38, '2026-02-24T10:01:00.000Z'),
      taskComplete('turn_001', '2026-02-24T10:01:01.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    expect(incremental.metrics.isOngoing).toBe(false);
  });

  it('keeps isOngoing=false when turn completed before offset and no new task_started after offset', async () => {
    const initialLines = [
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Start'),
      assistantMessage('Done'),
      tokenCount(100, 20, 30),
      taskComplete(),
    ];
    const file = tmpFile(initialLines);
    const byteOffset = fs.statSync(file).size;

    const appendedLines = [
      assistantMessage('Post-turn output', '2026-02-24T10:01:00.000Z'),
      tokenCount(120, 25, 38, '2026-02-24T10:01:01.000Z'),
    ];
    fs.appendFileSync(file, appendedLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const incremental = await parseCodexJsonl(file, { byteOffset });
    expect(incremental.metrics.isOngoing).toBe(false);
  });

  it('preserves full-parse behavior with byteOffset=0 after baseline-state enhancements', async () => {
    const mockPricing: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(0.02),
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
    };

    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(200, 50, 80),
      taskComplete(),
    ]);

    const full = await parseCodexJsonl(file, {
      byteOffset: 0,
      pricingService: mockPricing,
    });

    expect(full.metrics.primaryModel).toBe('o3');
    expect(full.metrics.isOngoing).toBe(false);
    expect(full.metrics.inputTokens).toBe(150);
    expect(full.metrics.cacheReadTokens).toBe(50);
    expect(full.metrics.outputTokens).toBe(80);
    expect(full.metrics.costUsd).toBe(0.02);
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith('o3', 150, 80, 50, 0);
  });

  it('tracks model from turn_context', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.primaryModel).toBe('o3');
  });

  it('tracks multiple models across turns', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      taskComplete(),
      turnContext('gpt-4o'),
      taskStarted('turn_002'),
      userMessage('More', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Sure', '2026-02-24T10:01:01.000Z'),
      taskComplete('turn_002', '2026-02-24T10:01:02.000Z'),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.primaryModel).toBe('gpt-4o');
    expect(result.metrics.modelsUsed).toEqual(expect.arrayContaining(['o3', 'gpt-4o']));
  });

  it('detects ongoing session when turn not completed', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      // No task_complete — session is ongoing
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.isOngoing).toBe(true);
  });

  it('detects completed session when all turns complete', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.isOngoing).toBe(false);
  });

  it('handles compacted events as compact summary messages', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      compacted('Summary of prior context'),
      userMessage('Continue', '2026-02-24T10:02:00.000Z'),
      assistantMessage('OK', '2026-02-24T10:02:01.000Z'),
      taskComplete('turn_001', '2026-02-24T10:02:02.000Z'),
    ]);

    const result = await parseCodexJsonl(file);

    const compactMsg = result.messages.find((m) => m.isCompactSummary);
    expect(compactMsg).toBeDefined();
    expect(compactMsg!.content[0]).toEqual({
      type: 'text',
      text: 'Summary of prior context',
    });
    expect(result.metrics.compactionCount).toBe(1);
    expect(result.metrics.visibleContextTokens).toBe(9); // summary(6) + continue(2) + ok(1)
  });

  it('resets visible context on context_compacted event', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Before'),
      assistantMessage('Answer'),
      contextCompacted('2026-02-24T10:00:30.000Z'),
      userMessage('After', '2026-02-24T10:00:31.000Z'),
      assistantMessage('Ok', '2026-02-24T10:00:32.000Z'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);
    expect(result.metrics.visibleContextTokens).toBe(3); // after(2) + ok(1)
  });

  it('resets visible context on compacted event with explicit summary message', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Longer before'),
      assistantMessage('Also long before'),
      compacted('Summary'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);
    expect(result.metrics.visibleContextTokens).toBe(2); // summary only
  });

  it('resets visible context on compacted event with fallback message shape', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Longer before'),
      assistantMessage('Also long before'),
      compactedNoMessage(),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);
    expect(result.metrics.visibleContextTokens).toBe(5); // "Context compacted"
  });

  it('calculates duration from first to last timestamp', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      {
        timestamp: '2026-02-24T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started' },
      },
      userMessage('Hello', '2026-02-24T10:00:01.000Z'),
      assistantMessage('Hi', '2026-02-24T10:00:10.000Z'),
      taskComplete('turn_001', '2026-02-24T10:00:15.000Z'),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.metrics.durationMs).toBe(15_000);
  });

  it('chains parentId across messages', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.messages[0].parentId).toBeNull();
    expect(result.messages[1].parentId).toBe(result.messages[0].id);
  });

  it('skips developer/system role messages', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      {
        timestamp: '2026-02-24T10:00:02.500Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'System prompt' }],
        },
      },
      userMessage('Hello'),
      assistantMessage('Hi'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    // developer message should be skipped
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('skips malformed lines gracefully', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-'));
    const filePath = path.join(dir, 'rollout-test.jsonl');
    const lines = [
      JSON.stringify(sessionMeta()),
      'not valid json {{{',
      JSON.stringify(turnContext()),
      JSON.stringify(taskStarted()),
      '',
      JSON.stringify(userMessage('Hello')),
      JSON.stringify(assistantMessage('Hi')),
      JSON.stringify(taskComplete()),
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const result = await parseCodexJsonl(filePath);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
  });

  it('skips unknown rollout line types gracefully', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      {
        timestamp: '2026-02-24T10:00:04.000Z',
        type: 'future_unknown_type',
        payload: { data: 123 },
      },
      assistantMessage('Hi'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file);

    expect(result.messages).toHaveLength(2);
  });

  it('respects maxMessages option (stops reading after limit reached)', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      userMessage('More', '2026-02-24T10:01:00.000Z'),
      assistantMessage('Sure', '2026-02-24T10:01:01.000Z'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file, { maxMessages: 2 });

    // maxMessages stops after processing the line that reaches the limit;
    // flushing may push multiple messages per line, so result is >= limit
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeLessThan(4); // but not all 4
  });

  it('excludes tool calls when includeToolCalls is false', async () => {
    const file = tmpFile([
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Read file'),
      functionCall('call_1', 'read_file', { path: '/tmp/test.txt' }),
      functionCallOutput('call_1', 'file contents here'),
      assistantMessage('Done'),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file, { includeToolCalls: false });

    const toolCallBlocks = result.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_call'),
    );
    const toolResultBlocks = result.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'tool_result'),
    );
    const toolCalls = result.messages.flatMap((m) => m.toolCalls);
    const toolResults = result.messages.flatMap((m) => m.toolResults);

    expect(toolCallBlocks).toHaveLength(0);
    expect(toolResultBlocks).toHaveLength(0);
    expect(toolCalls).toHaveLength(0);
    expect(toolResults).toHaveLength(0);
  });

  it('calculates cost using pricing service', async () => {
    const mockPricing: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(0.05),
      getContextWindowSize: jest.fn().mockReturnValue(128000),
    };

    const file = tmpFile([
      sessionMeta(),
      turnContext('o3'),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage('Hi'),
      tokenCount(1000, 500, 200),
      taskComplete(),
    ]);

    const result = await parseCodexJsonl(file, { pricingService: mockPricing });

    expect(result.metrics.costUsd).toBe(0.05);
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith('o3', 500, 200, 500, 0);
  });

  it('returns empty messages and zero metrics for empty file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-'));
    const filePath = path.join(dir, 'rollout-empty.jsonl');
    fs.writeFileSync(filePath, '');

    const result = await parseCodexJsonl(filePath);

    expect(result.messages).toHaveLength(0);
    expect(result.metrics.totalTokens).toBe(0);
    expect(result.metrics.durationMs).toBe(0);
    expect(result.metrics.isOngoing).toBe(false);
  });

  describe('warnings', () => {
    it('returns no warnings when all lines are under the size limit', async () => {
      const lines = [
        sessionMeta(),
        turnContext(),
        taskStarted(),
        userMessage('Hello'),
        assistantMessage('World'),
        taskComplete(),
      ];
      const filePath = tmpFile(lines);
      const result = await parseCodexJsonl(filePath);
      expect(result.warnings).toBeUndefined();
    });

    it('returns a warning when oversized lines are skipped', async () => {
      const hugeText = 'X'.repeat(11 * 1024 * 1024);
      const lines = [
        sessionMeta(),
        turnContext(),
        taskStarted(),
        userMessage('Hello'),
        assistantMessage(hugeText),
        taskComplete(),
      ];
      const filePath = tmpFile(lines);
      const result = await parseCodexJsonl(filePath);
      // The oversized assistant line is skipped
      const assistantMsgs = result.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toMatch(/Skipped 1 oversized line/);
    });
  });

  describe('oversized line logging', () => {
    beforeEach(() => {
      mockLoggerWarn.mockClear();
    });

    it('logs byte offset and content snippet for >10MB lines', async () => {
      const hugeText = 'Z'.repeat(11 * 1024 * 1024);
      const lines = [
        sessionMeta(),
        turnContext(),
        taskStarted(),
        userMessage('Hello'),
        assistantMessage(hugeText, '2026-02-24T10:00:06.000Z'),
        taskComplete(),
      ];

      const filePath = tmpFile(lines);
      await parseCodexJsonl(filePath);

      // Find the oversized line warn call
      const warnCall = mockLoggerWarn.mock.calls.find(
        (call: unknown[]) => call[1] === 'Skipping oversized JSONL line (>10MB)',
      );
      expect(warnCall).toBeDefined();

      // Assert log includes byte offset + snippet
      expect(warnCall![0]).toEqual(
        expect.objectContaining({
          filePath,
          lineBytes: expect.any(Number),
          byteOffset: expect.any(Number),
          snippet: expect.any(String),
        }),
      );
      expect(warnCall![0].byteOffset).toBeGreaterThan(0);
      expect(warnCall![0].snippet.length).toBeLessThanOrEqual(200);
      expect(warnCall![0].snippet.length).toBeGreaterThan(0);
    });
  });

  it('parses lines >1MB but <10MB (previously skipped)', async () => {
    // Create a response_item with a ~2MB text block
    const largeText = 'B'.repeat(2 * 1024 * 1024);
    const lines = [
      sessionMeta(),
      turnContext(),
      taskStarted(),
      userMessage('Hello'),
      assistantMessage(largeText, '2026-02-24T10:00:06.000Z'),
      taskComplete(),
    ];

    const filePath = tmpFile(lines);
    const result = await parseCodexJsonl(filePath);

    // Should have both user and assistant messages
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // Verify the large content was actually parsed
    const textBlock = assistantMsg!.content.find((c) => c.type === 'text');
    expect(textBlock).toBeDefined();
    if (textBlock?.type === 'text') {
      expect(textBlock.text.length).toBeGreaterThan(2 * 1024 * 1024 - 1);
    }
  });
});
