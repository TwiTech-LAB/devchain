import * as os from 'node:os';
import * as path from 'node:path';
import { parseGeminiJson } from './gemini-json.parser';
import type { PricingServiceInterface } from '../services/pricing.interface';

// Mock fs/promises with readFile as a jest.fn() that delegates to real implementation by default.
// This allows us to override readFile for specific tests (e.g. memory allocation failure).
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn().mockImplementation(actual.readFile),
  };
});

// Import fs AFTER mock setup (jest.mock is hoisted, but this makes intent clear)
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Test helpers — build Gemini ConversationRecord fixtures
// ---------------------------------------------------------------------------

function baseSession(
  overrides: Record<string, unknown> = {},
  messages: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    sessionId: 'test-session-id',
    projectHash: 'abc123hash',
    startTime: '2026-02-24T10:00:00.000Z',
    lastUpdated: '2026-02-24T10:05:00.000Z',
    messages,
    ...overrides,
  };
}

function userMessage(
  text: string,
  ts = '2026-02-24T10:00:10.000Z',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id: `user-${Date.now()}`, timestamp: ts, type: 'user', content: text, ...overrides };
}

function geminiMessage(
  text: string,
  ts = '2026-02-24T10:00:15.000Z',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `gemini-${Date.now()}`,
    timestamp: ts,
    type: 'gemini',
    content: text,
    model: 'gemini-2.5-pro',
    ...overrides,
  };
}

function geminiWithTokens(
  text: string,
  tokens: Record<string, number>,
  ts = '2026-02-24T10:00:15.000Z',
): Record<string, unknown> {
  return geminiMessage(text, ts, { tokens });
}

function geminiWithToolCalls(
  text: string,
  toolCalls: Record<string, unknown>[],
  ts = '2026-02-24T10:00:15.000Z',
): Record<string, unknown> {
  return geminiMessage(text, ts, { toolCalls });
}

function geminiWithThoughts(
  text: string,
  thoughts: Record<string, unknown>[],
  ts = '2026-02-24T10:00:15.000Z',
): Record<string, unknown> {
  return geminiMessage(text, ts, { thoughts });
}

function infoMessage(text: string, ts = '2026-02-24T10:00:20.000Z'): Record<string, unknown> {
  return { id: `info-${Date.now()}`, timestamp: ts, type: 'info', content: text };
}

function errorMessage(text: string, ts = '2026-02-24T10:00:20.000Z'): Record<string, unknown> {
  return { id: `error-${Date.now()}`, timestamp: ts, type: 'error', content: text };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-parser-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSessionFile(
  session: Record<string, unknown>,
  filename = 'session.json',
): Promise<string> {
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, JSON.stringify(session), 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseGeminiJson', () => {
  it('extracts sessionId from the session file', async () => {
    const fp = await writeSessionFile(
      baseSession({ sessionId: 'my-session-uuid' }, []),
      'session-id.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.sessionId).toBe('my-session-uuid');
  });

  it('parses user and assistant messages', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [userMessage('Hello'), geminiMessage('Hi there!')]),
      'user-assistant.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'Hi there!' });
  });

  it('chains parentId across messages', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        userMessage('First', '2026-02-24T10:00:01.000Z', { id: 'msg-1' }),
        geminiMessage('Second', '2026-02-24T10:00:02.000Z', { id: 'msg-2' }),
        userMessage('Third', '2026-02-24T10:00:03.000Z', { id: 'msg-3' }),
      ]),
      'parent-chain.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages[0].parentId).toBeNull();
    expect(result.messages[1].parentId).toBe('msg-1');
    expect(result.messages[2].parentId).toBe('msg-2');
  });

  it('parses thinking/thoughts from gemini messages', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithThoughts('Here is my answer', [
          { subject: 'Analyzing request', description: 'The user wants auth help' },
          { subject: 'Planning', description: 'Will check login.ts first' },
        ]),
      ]),
      'thoughts.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    const thinkingBlock = result.messages[0].content.find((c) => c.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.type).toBe('thinking');
    if (thinkingBlock!.type === 'thinking') {
      expect(thinkingBlock!.thinking).toContain('Analyzing request');
      expect(thinkingBlock!.thinking).toContain('Planning');
    }
  });

  it('maps tool calls and tool results', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithToolCalls('Let me read that file', [
          {
            id: 'call-1',
            name: 'read_file',
            args: { target: 'src/login.ts' },
            status: 'success',
            timestamp: '2026-02-24T10:00:16.000Z',
            result: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'read_file',
                  response: { output: 'file contents here' },
                },
              },
            ],
          },
        ]),
      ]),
      'tool-calls.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];

    // Tool call content block
    const tcBlock = msg.content.find((c) => c.type === 'tool_call');
    expect(tcBlock).toBeDefined();
    if (tcBlock?.type === 'tool_call') {
      expect(tcBlock.toolName).toBe('read_file');
      expect(tcBlock.input).toEqual({ target: 'src/login.ts' });
    }

    // Tool result content block
    const trBlock = msg.content.find((c) => c.type === 'tool_result');
    expect(trBlock).toBeDefined();
    if (trBlock?.type === 'tool_result') {
      expect(trBlock.content).toBe('file contents here');
      expect(trBlock.isError).toBe(false);
    }

    // Structured tool calls/results
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0].name).toBe('read_file');
    expect(msg.toolResults).toHaveLength(1);
    expect(msg.toolResults[0].content).toBe('file contents here');
  });

  it('extracts tools encoded in content/displayContent parts', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiMessage('', '2026-02-24T10:00:15.000Z', {
          id: 'gemini-parts-tools',
          content: [
            {
              functionCall: {
                id: 'part-call-1',
                name: 'read_file',
                args: { target: 'src/app.ts' },
              },
            },
          ],
          displayContent: [
            {
              functionResponse: {
                id: 'part-call-1',
                name: 'read_file',
                response: { output: 'export const x = 1;' },
              },
            },
          ],
        }),
      ]),
      'tools-in-parts.json',
    );

    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];

    const toolCallBlocks = msg.content.filter((c) => c.type === 'tool_call');
    const toolResultBlocks = msg.content.filter((c) => c.type === 'tool_result');
    const textBlocks = msg.content.filter((c) => c.type === 'text');

    expect(textBlocks).toHaveLength(0);
    expect(toolCallBlocks).toHaveLength(1);
    expect(toolResultBlocks).toHaveLength(1);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolResults).toHaveLength(1);
    expect(msg.toolCalls[0].id).toBe('part-call-1');
    expect(msg.toolResults[0].toolCallId).toBe('part-call-1');
    expect(msg.toolResults[0].content).toBe('export const x = 1;');
  });

  it('deduplicates tools when present in both toolCalls[] and parts', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiMessage('Analyzing file', '2026-02-24T10:00:15.000Z', {
          id: 'gemini-dedup-tools',
          content: [
            {
              functionCall: {
                id: 'dup-call-1',
                name: 'read_file',
                args: { target: 'src/auth.ts' },
              },
            },
          ],
          displayContent: [
            {
              functionResponse: {
                id: 'dup-call-1',
                name: 'read_file',
                response: { output: 'same output' },
              },
            },
          ],
          toolCalls: [
            {
              id: 'dup-call-1',
              name: 'read_file',
              args: { target: 'src/auth.ts' },
              status: 'success',
              result: [
                {
                  functionResponse: {
                    id: 'dup-call-1',
                    name: 'read_file',
                    response: { output: 'same output' },
                  },
                },
              ],
            },
          ],
        }),
      ]),
      'tools-dedup.json',
    );

    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];

    expect(msg.content.filter((c) => c.type === 'tool_call')).toHaveLength(1);
    expect(msg.content.filter((c) => c.type === 'tool_result')).toHaveLength(1);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolResults).toHaveLength(1);
  });

  it('marks error tool results', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithToolCalls('Trying to read', [
          {
            id: 'call-err',
            name: 'read_file',
            args: { target: 'missing.ts' },
            status: 'error',
            result: [
              {
                functionResponse: {
                  id: 'call-err',
                  name: 'read_file',
                  response: { output: 'File not found' },
                },
              },
            ],
          },
        ]),
      ]),
      'tool-error.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages[0].toolResults[0].isError).toBe(true);
  });

  it('excludes tool calls when includeToolCalls is false', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiMessage('Read the file', '2026-02-24T10:00:15.000Z', {
          toolCalls: [
            {
              id: 'call-x',
              name: 'read_file',
              args: { target: 'file.ts' },
              status: 'success',
              result: [
                {
                  functionResponse: {
                    id: 'call-x',
                    name: 'read_file',
                    response: { output: 'data' },
                  },
                },
              ],
            },
          ],
          content: [
            { text: 'Read the file' },
            {
              functionCall: {
                id: 'call-x',
                name: 'read_file',
                args: { target: 'file.ts' },
              },
            },
          ],
          displayContent: [
            {
              functionResponse: {
                id: 'call-x',
                name: 'read_file',
                response: { output: 'data' },
              },
            },
          ],
        }),
      ]),
      'no-tools.json',
    );
    const result = await parseGeminiJson(fp, { includeToolCalls: false });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolCalls).toHaveLength(0);
    expect(result.messages[0].toolResults).toHaveLength(0);
    expect(result.messages[0].content.find((c) => c.type === 'tool_call')).toBeUndefined();
    expect(result.messages[0].content.find((c) => c.type === 'tool_result')).toBeUndefined();
  });

  it('aggregates token metrics across messages', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        userMessage('Q1'),
        geminiWithTokens(
          'A1',
          { input: 100, output: 50, cached: 0, total: 150 },
          '2026-02-24T10:00:11.000Z',
        ),
        userMessage('Q2', '2026-02-24T10:00:12.000Z'),
        geminiWithTokens(
          'A2',
          { input: 200, output: 80, cached: 50, thoughts: 20, total: 350 },
          '2026-02-24T10:00:13.000Z',
        ),
      ]),
      'tokens.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.metrics.inputTokens).toBe(300);
    // output includes thoughts: 50 + 80 + 20 = 150
    expect(result.metrics.outputTokens).toBe(150);
    expect(result.metrics.cacheReadTokens).toBe(50);
  });

  it('maps raw message tokens to assistant usage including thoughts', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithTokens(
          'Answer with reasoning',
          { input: 210, output: 70, cached: 25, thoughts: 15, total: 320 },
          '2026-02-24T10:00:11.000Z',
        ),
      ]),
      'assistant-usage-from-tokens.json',
    );

    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].usage).toEqual({
      input: 210,
      output: 85,
      cacheRead: 25,
      cacheCreation: 0,
    });
  });

  it('tracks totalContextTokens from the last assistant message', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithTokens(
          'A1',
          { input: 100, output: 50, cached: 10, thoughts: 5, total: 165 },
          '2026-02-24T10:00:11.000Z',
        ),
        geminiWithTokens(
          'A2',
          { input: 200, output: 80, cached: 20, thoughts: 30, total: 330 },
          '2026-02-24T10:00:13.000Z',
        ),
      ]),
      'total-context-last-assistant.json',
    );

    const result = await parseGeminiJson(fp);
    expect(result.metrics.totalContextTokens).toBe(330); // 200 + 80 + 30 + 20
  });

  it('estimates visibleContextTokens from user and assistant content', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [userMessage('Hello'), geminiMessage('Hi there!')]),
      'visible-context-estimate.json',
    );

    const result = await parseGeminiJson(fp);
    expect(result.metrics.visibleContextTokens).toBe(5); // hello(2) + hi there(3)
  });

  it('tracks single model', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiMessage('Hi', '2026-02-24T10:00:11.000Z', { model: 'gemini-2.5-pro' }),
      ]),
      'single-model.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.metrics.primaryModel).toBe('gemini-2.5-pro');
    expect(result.metrics.modelsUsed).toBeUndefined();
  });

  it('tracks multiple models', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        geminiMessage('A1', '2026-02-24T10:00:11.000Z', { model: 'gemini-2.5-pro' }),
        geminiMessage('A2', '2026-02-24T10:00:12.000Z', { model: 'gemini-2.5-flash' }),
      ]),
      'multi-model.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.metrics.primaryModel).toBe('gemini-2.5-pro');
    expect(result.metrics.modelsUsed).toEqual(
      expect.arrayContaining(['gemini-2.5-pro', 'gemini-2.5-flash']),
    );
  });

  it('maps info messages as system/meta', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [infoMessage('Session checkpoint created')]),
      'info-msg.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].isMeta).toBe(true);
  });

  it('maps error messages as system/meta', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [errorMessage('Something went wrong')]),
      'error-msg.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].isMeta).toBe(true);
  });

  it('calculates duration from startTime/lastUpdated', async () => {
    const fp = await writeSessionFile(
      baseSession(
        {
          startTime: '2026-02-24T10:00:00.000Z',
          lastUpdated: '2026-02-24T10:05:00.000Z',
        },
        [userMessage('Hello')],
      ),
      'duration.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.metrics.durationMs).toBe(300_000);
  });

  it('respects maxMessages option', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        userMessage('Q1', '2026-02-24T10:00:01.000Z'),
        geminiMessage('A1', '2026-02-24T10:00:02.000Z'),
        userMessage('Q2', '2026-02-24T10:00:03.000Z'),
        geminiMessage('A2', '2026-02-24T10:00:04.000Z'),
      ]),
      'max-messages.json',
    );
    const result = await parseGeminiJson(fp, { maxMessages: 2 });
    expect(result.messages).toHaveLength(2);
  });

  it('handles empty file gracefully', async () => {
    const fp = path.join(tmpDir, 'empty.json');
    await fs.writeFile(fp, '', 'utf8');
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(0);
    expect(result.metrics.messageCount).toBe(0);
    expect(result.metrics.totalContextTokens).toBe(0);
  });

  it('returns totalContextTokens as 0 for empty sessions', async () => {
    const fp = await writeSessionFile(baseSession({}, []), 'empty-session.json');
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(0);
    expect(result.metrics.totalContextTokens).toBe(0);
  });

  it('handles malformed JSON gracefully', async () => {
    const fp = path.join(tmpDir, 'malformed.json');
    await fs.writeFile(fp, '{ not valid json }}}', 'utf8');
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(0);
  });

  it('handles missing messages array gracefully', async () => {
    const fp = await writeSessionFile({ sessionId: 'no-messages' }, 'no-messages.json');
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(0);
    expect(result.sessionId).toBe('no-messages');
  });

  it('skips unknown message types gracefully', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        userMessage('Hello'),
        { id: 'unknown-1', type: 'custom_event', content: 'something' },
        geminiMessage('World'),
      ]),
      'unknown-type.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('skips messages without type field', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [userMessage('Hello'), { id: 'no-type', content: 'orphan' }]),
      'no-type.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(1);
  });

  it('handles Part[] content format (array of parts)', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        {
          id: 'user-parts',
          type: 'user',
          timestamp: '2026-02-24T10:00:10.000Z',
          content: [{ text: 'Hello from parts' }],
        },
        {
          id: 'gemini-parts',
          type: 'gemini',
          timestamp: '2026-02-24T10:00:11.000Z',
          model: 'gemini-2.5-pro',
          content: [{ text: 'Part 1' }, { text: 'Part 2' }],
        },
      ]),
      'parts-content.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello from parts' });
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'Part 1\nPart 2' });
  });

  it('integrates with pricing service', async () => {
    const mockPricing: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(0.005),
      getContextWindowSize: jest.fn().mockReturnValue(1_000_000),
    };

    const fp = await writeSessionFile(
      baseSession({}, [
        geminiWithTokens('Answer', { input: 1000, output: 500, cached: 200, total: 1700 }),
      ]),
      'pricing.json',
    );
    const result = await parseGeminiJson(fp, { pricingService: mockPricing });
    expect(result.metrics.costUsd).toBe(0.005);
    expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith(
      'gemini-2.5-pro',
      1000,
      500,
      200,
      0,
    );
  });

  it('sets isOngoing to false (Gemini JSON is written on completion)', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [userMessage('Hello'), geminiMessage('World')]),
      'ongoing.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.metrics.isOngoing).toBe(false);
  });

  it('preserves message IDs from the session file', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [
        userMessage('Hello', '2026-02-24T10:00:10.000Z', { id: 'custom-user-id' }),
        geminiMessage('Hi', '2026-02-24T10:00:11.000Z', { id: 'custom-gemini-id' }),
      ]),
      'preserve-ids.json',
    );
    const result = await parseGeminiJson(fp);
    expect(result.messages[0].id).toBe('custom-user-id');
    expect(result.messages[1].id).toBe('custom-gemini-id');
  });

  it('tracks bytesRead as file size', async () => {
    const session = baseSession({}, [userMessage('Hello')]);
    const fp = await writeSessionFile(session, 'bytes.json');
    const stat = await fs.stat(fp);
    const result = await parseGeminiJson(fp);
    expect(result.bytesRead).toBe(stat.size);
  });

  it('returns empty result with warnings for non-existent file', async () => {
    const result = await parseGeminiJson('/tmp/does-not-exist-gemini.json');
    expect(result.messages).toHaveLength(0);
    expect(result.bytesRead).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toMatch(/File could not be read/);
  });

  it('returns warnings when file read fails (memory allocation failure)', async () => {
    const fp = await writeSessionFile(
      baseSession({}, [userMessage('Hello')]),
      'mem-fail-test.json',
    );

    // Override readFile to simulate ENOMEM for the next call only
    (fs.readFile as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('Cannot allocate memory'), { code: 'ENOMEM' }),
    );

    const result = await parseGeminiJson(fp);

    expect(result.messages).toHaveLength(0);
    expect(result.bytesRead).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toMatch(/File could not be read/);
  });

  it('parses file larger than 10MB without size gate (no cap regression)', async () => {
    // Build a session with enough messages to exceed 10MB
    const bigText = 'x'.repeat(100_000); // ~100KB per message
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < 110; i++) {
      msgs.push(
        userMessage(`${bigText}-${i}`, `2026-02-24T10:${String(i).padStart(2, '0')}:00.000Z`, {
          id: `user-big-${i}`,
        }),
      );
      msgs.push(
        geminiMessage(
          `${bigText}-reply-${i}`,
          `2026-02-24T10:${String(i).padStart(2, '0')}:01.000Z`,
          { id: `gemini-big-${i}` },
        ),
      );
    }

    const fp = await writeSessionFile(baseSession({}, msgs), 'large-session.json');
    const stat = await fs.stat(fp);
    expect(stat.size).toBeGreaterThan(10 * 1024 * 1024); // confirm > 10MB

    const result = await parseGeminiJson(fp);
    expect(result.messages.length).toBe(220);
    expect(result.bytesRead).toBe(stat.size);
    expect(result.metrics.messageCount).toBe(220);
  });
});
