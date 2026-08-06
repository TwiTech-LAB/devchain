import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PricingServiceInterface } from '../services/pricing.interface';

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
/* eslint-disable @typescript-eslint/no-require-imports */
const { parseClaudeJsonl } =
  require('./claude-jsonl.parser') as typeof import('./claude-jsonl.parser');
/* eslint-enable @typescript-eslint/no-require-imports */

function writeTempJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  const filePath = path.join(dir, 'test-session.jsonl');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function cleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // ignore
  }
}

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.01),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

// Fixture entries
const userEntry = {
  type: 'user',
  uuid: 'user-1',
  parentUuid: null,
  isSidechain: false,
  timestamp: '2026-01-01T10:00:00.000Z',
  message: { role: 'user', content: 'Hello Claude' },
};

const assistantEntry = {
  type: 'assistant',
  uuid: 'asst-1',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:05.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'Hello! How can I help?' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    },
  },
};

const thinkingAssistantEntry = {
  type: 'assistant',
  uuid: 'asst-2',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:10.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      { type: 'thinking', thinking: 'Let me reason about this...', signature: 'sig123' },
      { type: 'text', text: 'After thinking, here is my answer.' },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 200,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

const toolUseAssistantEntry = {
  type: 'assistant',
  uuid: 'asst-tool',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:15.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la' } }],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 150,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

const toolResultUserEntry = {
  type: 'user',
  uuid: 'user-tool-result',
  parentUuid: 'asst-tool',
  isSidechain: false,
  isMeta: true,
  timestamp: '2026-01-01T10:00:16.000Z',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
        is_error: false,
      },
    ],
  },
};

const taskToolEntry = {
  type: 'assistant',
  uuid: 'asst-task',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:20.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: { description: 'Find files', subagent_type: 'Explore', prompt: 'Search codebase' },
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 180,
      output_tokens: 40,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

const imageAssistantEntry = {
  type: 'assistant',
  uuid: 'asst-img',
  parentUuid: 'user-1',
  isSidechain: false,
  timestamp: '2026-01-01T10:00:25.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

const compactSummaryEntry = {
  type: 'user',
  uuid: 'compact-1',
  parentUuid: null,
  isSidechain: false,
  isMeta: true,
  isCompactSummary: true,
  timestamp: '2026-01-01T11:00:00.000Z',
  message: { role: 'user', content: 'Compacted conversation summary...' },
};

const postCompactionAssistant = {
  type: 'assistant',
  uuid: 'asst-post-compact',
  parentUuid: 'compact-1',
  isSidechain: false,
  timestamp: '2026-01-01T11:00:05.000Z',
  message: {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'Continuing after compaction.' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 80,
      output_tokens: 40,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    },
  },
};

const sidechainEntry = {
  type: 'assistant',
  uuid: 'asst-side',
  parentUuid: null,
  isSidechain: true,
  timestamp: '2026-01-01T10:30:00.000Z',
  message: {
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'Subagent result' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

describe('ClaudeJsonlParser', () => {
  describe('basic parsing', () => {
    it('should parse a simple user + assistant session', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello Claude' });
        expect(result.messages[1].role).toBe('assistant');
        expect(result.messages[1].content[0]).toEqual({
          type: 'text',
          text: 'Hello! How can I help?',
        });
        expect(result.messages[1].usage).toEqual({
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheCreation: 10,
        });
      } finally {
        cleanup(filePath);
      }
    });

    it('should compute metrics correctly', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);

        expect(result.metrics.inputTokens).toBe(100);
        expect(result.metrics.outputTokens).toBe(50);
        expect(result.metrics.cacheReadTokens).toBe(20);
        expect(result.metrics.cacheCreationTokens).toBe(10);
        expect(result.metrics.totalTokens).toBe(180);
        expect(result.metrics.messageCount).toBe(2);
        expect(result.metrics.durationMs).toBe(5000);
        expect(result.metrics.isOngoing).toBe(false);
        expect(result.metrics.primaryModel).toBe('claude-sonnet-4-6');
      } finally {
        cleanup(filePath);
      }
    });

    it('should extract thinking blocks', async () => {
      const filePath = writeTempJsonl([userEntry, thinkingAssistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        const asst = result.messages[1];

        expect(asst.content).toHaveLength(2);
        expect(asst.content[0]).toEqual({
          type: 'thinking',
          thinking: 'Let me reason about this...',
          signature: 'sig123',
        });
        expect(asst.content[1]).toEqual({
          type: 'text',
          text: 'After thinking, here is my answer.',
        });
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('tool calls and results', () => {
    it('folds a standalone user(tool_result) into the preceding assistant turn (ID linking preserved)', async () => {
      const filePath = writeTempJsonl([userEntry, toolUseAssistantEntry, toolResultUserEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);

        // The tool_result user entry is folded → 2 messages, not 3 (count parity with
        // Codex/OpenCode: tool plumbing is not its own conversational message).
        expect(result.messages).toHaveLength(2);
        expect(result.metrics.messageCount).toBe(2);

        const toolMsg = result.messages[1];
        expect(toolMsg.role).toBe('assistant');

        // Tool call still present on the assistant message.
        expect(toolMsg.toolCalls).toHaveLength(1);
        expect(toolMsg.toolCalls[0]).toMatchObject({
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'ls -la' },
          isTask: false,
        });

        // Tool result folded ONTO the assistant message (toolResults + a tool_result block).
        expect(toolMsg.toolResults).toHaveLength(1);
        expect(toolMsg.toolResults[0].toolCallId).toBe('tool-1');
        expect(toolMsg.toolResults[0].isError).toBe(false);
        expect(toolMsg.content.some((b) => b.type === 'tool_result')).toBe(true);

        // No standalone user-role tool-result message remains.
        expect(result.messages.some((m) => m.role === 'user' && m.toolResults.length > 0)).toBe(
          false,
        );
      } finally {
        cleanup(filePath);
      }
    });

    it('count parity: prompt → tool_use → tool_result → text yields messageCount 2 (one turn)', async () => {
      // DoD example. The tool_result folds onto the tool_use assistant, and the FINAL text
      // assistant (the continuation after the result) coalesces onto it too ⇒ 1 user + 1
      // assistant = 2 turns. All tool calls/results + the final text land on the one assistant.
      const finalAssistant = {
        type: 'assistant',
        uuid: 'asst-final',
        parentUuid: 'user-tool-result',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:18.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Done — here are the files.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 90, output_tokens: 20 },
        },
      };
      const filePath = writeTempJsonl([
        userEntry,
        toolUseAssistantEntry,
        toolResultUserEntry,
        finalAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.messageCount).toBe(2);
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

        // The coalesced assistant carries the tool call, the folded result, and the final text.
        const asst = result.messages[1];
        expect(asst.toolCalls.map((c) => c.id)).toEqual(['tool-1']);
        expect(asst.toolResults.map((r) => r.toolCallId)).toEqual(['tool-1']);
        const texts = asst.content.filter((b) => b.type === 'text').map((b) => b.text);
        expect(texts).toContain('Done — here are the files.');
        // Order preserved: tool_call before its result before the trailing text.
        const kinds = asst.content.map((b) => b.type);
        expect(kinds).toEqual(['tool_call', 'tool_result', 'text']);
      } finally {
        cleanup(filePath);
      }
    });

    it('count parity: a sequential N=2 tool turn yields messageCount 2 (one coalesced assistant)', async () => {
      const round2ToolUse = {
        type: 'assistant',
        uuid: 'asst-tool-2',
        parentUuid: 'user-tool-result',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:17.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'pwd' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 60, output_tokens: 10 },
        },
      };
      const round2ToolResult = {
        type: 'user',
        uuid: 'user-tool-result-2',
        parentUuid: 'asst-tool-2',
        isSidechain: false,
        isMeta: true,
        timestamp: '2026-01-01T10:00:18.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-2', content: '/home', is_error: false },
          ],
        },
      };
      const finalAssistant = {
        type: 'assistant',
        uuid: 'asst-final',
        parentUuid: 'user-tool-result-2',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:19.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'All done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 90, output_tokens: 20 },
        },
      };
      const filePath = writeTempJsonl([
        userEntry,
        toolUseAssistantEntry,
        toolResultUserEntry,
        round2ToolUse,
        round2ToolResult,
        finalAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // user + [tool_use#1 → tool_use#2 → final text, all coalesced + both results folded] = 2.
        expect(result.metrics.messageCount).toBe(2);
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        // Both rounds' calls and results live on the single coalesced assistant, in order.
        const asst = result.messages[1];
        expect(asst.toolCalls.map((c) => c.id)).toEqual(['tool-1', 'tool-2']);
        expect(asst.toolResults.map((r) => r.toolCallId)).toEqual(['tool-1', 'tool-2']);
      } finally {
        cleanup(filePath);
      }
    });

    it('sums usage across the coalesced entries onto the single assistant message', async () => {
      const finalAssistant = {
        type: 'assistant',
        uuid: 'asst-final',
        parentUuid: 'user-tool-result',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:18.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 90,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 1,
          },
        },
      };
      const filePath = writeTempJsonl([
        userEntry,
        toolUseAssistantEntry, // usage: 150 / 30 / 0 / 0
        toolResultUserEntry,
        finalAssistant, // usage: 90 / 20 / 5 / 1
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // Merged assistant usage = sum of the two coalesced assistant entries.
        expect(result.messages[1].usage).toEqual({
          input: 240,
          output: 50,
          cacheRead: 5,
          cacheCreation: 1,
        });
        // Session totals are unaffected (they accumulate per entry).
        expect(result.metrics.inputTokens).toBe(240);
        expect(result.metrics.outputTokens).toBe(50);
      } finally {
        cleanup(filePath);
      }
    });

    it('over-merge guard: a post-end_turn assistant with no user between starts a NEW turn', async () => {
      // toolUseAssistantEntry has stop_reason 'tool_use'; assistantEntry has 'end_turn'. After
      // an end_turn, a following assistant (no user between) is a separate turn → not coalesced.
      const afterEndTurn = {
        type: 'assistant',
        uuid: 'asst-after-end',
        parentUuid: 'asst-1',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:30.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'A separate continuation turn.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      // userEntry → assistantEntry(end_turn) → afterEndTurn(no user between).
      const filePath = writeTempJsonl([userEntry, assistantEntry, afterEndTurn]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.messageCount).toBe(3);
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
      } finally {
        cleanup(filePath);
      }
    });

    it('over-merge guard: a tool_result after an end_turn assistant does NOT fold across the boundary', async () => {
      // Defensive (malformed input): a tool_result only ever follows a 'tool_use' assistant in
      // well-formed transcripts, never an 'end_turn' one. If one appears after a COMPLETED turn,
      // the end_turn guard on the tool_result fold (mirroring the continuation fold) prevents it
      // from being glued onto the unrelated completed turn — it stays its own message.
      const filePath = writeTempJsonl([userEntry, assistantEntry, toolResultUserEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // user + assistant(end_turn) + orphan tool_result = 3 (NOT folded into the 2nd).
        expect(result.metrics.messageCount).toBe(3);
        expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        // The completed assistant turn is untouched — no tool_result leaked onto it.
        expect(result.messages[1].toolResults).toHaveLength(0);
        expect(result.messages[2].toolResults).toHaveLength(1);
      } finally {
        cleanup(filePath);
      }
    });

    it('over-merge guard: a sidechain assistant does NOT coalesce onto a main-thread turn', async () => {
      // toolUseAssistantEntry (main, tool_use) then a sidechain assistant: sidechain mismatch
      // breaks the chain even though the preceding stop_reason is not end_turn.
      const filePath = writeTempJsonl([userEntry, toolUseAssistantEntry, sidechainEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.messageCount).toBe(3);
        expect(result.messages[2].isSidechain).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });

    it('over-merge guard: a compact summary between assistants starts a NEW turn', async () => {
      // toolUseAssistantEntry (tool_use, would otherwise allow a continuation fold) → compact
      // summary (user) → postCompactionAssistant. The compact summary nulls the fold target.
      const filePath = writeTempJsonl([
        userEntry,
        toolUseAssistantEntry,
        compactSummaryEntry,
        postCompactionAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // user + tool_use assistant + compact summary + post-compaction assistant = 4.
        expect(result.metrics.messageCount).toBe(4);
        expect(result.messages.map((m) => m.role)).toEqual([
          'user',
          'assistant',
          'user',
          'assistant',
        ]);
        expect(result.messages[2].isCompactSummary).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });

    it('over-merge guard: a real user prompt between assistants starts a NEW turn', async () => {
      const secondPrompt = {
        type: 'user',
        uuid: 'user-2',
        parentUuid: 'asst-tool',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:40.000Z',
        message: { role: 'user', content: 'Another question' },
      };
      const secondAssistant = {
        type: 'assistant',
        uuid: 'asst-2nd',
        parentUuid: 'user-2',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:45.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Second answer.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      // userEntry → toolUseAssistantEntry(tool_use) → real user → assistant.
      const filePath = writeTempJsonl([
        userEntry,
        toolUseAssistantEntry,
        secondPrompt,
        secondAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.messageCount).toBe(4);
        expect(result.messages.map((m) => m.role)).toEqual([
          'user',
          'assistant',
          'user',
          'assistant',
        ]);
      } finally {
        cleanup(filePath);
      }
    });

    it('does NOT fold a user entry that carries real text alongside a tool_result', async () => {
      const mixedUserEntry = {
        type: 'user',
        uuid: 'user-mixed',
        parentUuid: 'asst-tool',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:16.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
            { type: 'text', text: 'Thanks, now do the next thing.' },
          ],
        },
      };
      const filePath = writeTempJsonl([userEntry, toolUseAssistantEntry, mixedUserEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // Real user text ⇒ NOT folded; stays its own message (3 total).
        expect(result.metrics.messageCount).toBe(3);
        expect(result.messages[2].role).toBe('user');
      } finally {
        cleanup(filePath);
      }
    });

    it('fallback: a tool_result with no preceding assistant is preserved as its own message', async () => {
      // Mirrors the watcher slice that starts mid-turn / a malformed transcript.
      const filePath = writeTempJsonl([toolResultUserEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[0].toolResults).toHaveLength(1);
      } finally {
        cleanup(filePath);
      }
    });

    it('should identify Task tool calls with subagent metadata', async () => {
      const filePath = writeTempJsonl([userEntry, taskToolEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        const taskMsg = result.messages[1];

        expect(taskMsg.toolCalls[0]).toMatchObject({
          id: 'task-1',
          name: 'Task',
          isTask: true,
          taskDescription: 'Find files',
          taskSubagentType: 'Explore',
        });
      } finally {
        cleanup(filePath);
      }
    });

    it('should extract image content blocks', async () => {
      const filePath = writeTempJsonl([userEntry, imageAssistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        const imgMsg = result.messages[1];

        expect(imgMsg.content[0]).toEqual({
          type: 'image',
          mediaType: 'image/png',
          data: 'iVBOR...',
        });
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('message classification', () => {
    it('should set isMeta correctly for tool result messages', async () => {
      const filePath = writeTempJsonl([toolResultUserEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages[0].isMeta).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });

    it('should set isSidechain for sidechain entries', async () => {
      const filePath = writeTempJsonl([sidechainEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages[0].isSidechain).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });

    it('should mark compact summary messages', async () => {
      const filePath = writeTempJsonl([compactSummaryEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages[0].isCompactSummary).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('filtered entry types', () => {
    it('should skip summary, file-history-snapshot, queue-operation, progress entries', async () => {
      const filePath = writeTempJsonl([
        userEntry,
        { type: 'summary', summary: 'text', leafUuid: 'x' },
        { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
        { type: 'queue-operation', operation: 'x' },
        { type: 'progress', data: { type: 'mcp_progress' } },
        assistantEntry,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[1].role).toBe('assistant');
      } finally {
        cleanup(filePath);
      }
    });

    it('should skip system entries', async () => {
      const filePath = writeTempJsonl([
        { type: 'system', subtype: 'init', isMeta: true },
        userEntry,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('compaction tracking', () => {
    it('should track compaction phases correctly', async () => {
      const filePath = writeTempJsonl([
        userEntry,
        assistantEntry, // input: 100 + 20 + 10 = 130
        compactSummaryEntry,
        postCompactionAssistant, // input: 80 + 30 + 0 = 110
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);

        expect(result.metrics.compactionCount).toBe(1);
        expect(result.metrics.phaseBreakdowns).toHaveLength(2);

        // Phase 1: pre-compaction peak = 130
        expect(result.metrics.phaseBreakdowns[0].phaseNumber).toBe(1);
        expect(result.metrics.phaseBreakdowns[0].peakTokens).toBe(130);
        expect(result.metrics.phaseBreakdowns[0].postCompaction).toBe(110);

        // Phase 2: final phase contribution = 110 - 110 = 0
        // Actually, final phase = lastMainAssistantInputTokens - lastPostCompaction = 110 - 110 = 0
        // Guard: only adds final phase when postCompaction > 0 → yes it's 110
        expect(result.metrics.phaseBreakdowns[1].phaseNumber).toBe(2);
      } finally {
        cleanup(filePath);
      }
    });

    it('should handle zero compactions (single phase)', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);

        expect(result.metrics.compactionCount).toBe(0);
        expect(result.metrics.phaseBreakdowns).toHaveLength(1);
        expect(result.metrics.phaseBreakdowns[0].phaseNumber).toBe(1);
        expect(result.metrics.phaseBreakdowns[0].peakTokens).toBe(130); // 100+20+10
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('model identification', () => {
    it('should track primary model from most recent assistant', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.primaryModel).toBe('claude-sonnet-4-6');
      } finally {
        cleanup(filePath);
      }
    });

    it('should track multiple models when different models used', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry, sidechainEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.modelsUsed).toBeDefined();
        expect(result.metrics.modelsUsed).toContain('claude-sonnet-4-6');
        expect(result.metrics.modelsUsed).toContain('claude-haiku-4-5-20251001');
      } finally {
        cleanup(filePath);
      }
    });

    it('should not populate modelsUsed when single model', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.modelsUsed).toBeUndefined();
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('visible context', () => {
    it('should estimate visibleContextTokens from main-thread content blocks', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // user "Hello Claude" (12 => 3) + assistant text (22 => 6)
        expect(result.metrics.visibleContextTokens).toBe(9);
      } finally {
        cleanup(filePath);
      }
    });

    it('should not update visibleContextTokens from sidechain messages', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry, sidechainEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // Sidechain messages are excluded from visible context
        expect(result.metrics.visibleContextTokens).toBe(9);
      } finally {
        cleanup(filePath);
      }
    });

    it('should accumulate visible context across multiple main-thread messages', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry, thinkingAssistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // user (3) + assistant text (6) + thinking assistant (7 + 9)
        expect(result.metrics.visibleContextTokens).toBe(25);
      } finally {
        cleanup(filePath);
      }
    });

    it('should reset and re-accumulate visible context on compaction', async () => {
      const filePath = writeTempJsonl([
        userEntry,
        assistantEntry,
        compactSummaryEntry,
        postCompactionAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // Reset to compact summary (9), then add post-compaction assistant (7)
        expect(result.metrics.visibleContextTokens).toBe(16);
      } finally {
        cleanup(filePath);
      }
    });

    it('should reset and re-accumulate visible context across multiple compactions', async () => {
      const secondCompactSummaryEntry = {
        type: 'user',
        uuid: 'compact-2',
        parentUuid: 'asst-post-compact',
        isSidechain: false,
        isMeta: true,
        isCompactSummary: true,
        timestamp: '2026-01-01T12:00:00.000Z',
        message: { role: 'user', content: 'abcdabcd' }, // 8 chars => 2 tokens
      };
      const secondPostCompactionAssistant = {
        type: 'assistant',
        uuid: 'asst-post-compact-2',
        parentUuid: 'compact-2',
        isSidechain: false,
        timestamp: '2026-01-01T12:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'wxyzwxyz' }], // 8 chars => 2 tokens
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 60,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      };

      const filePath = writeTempJsonl([
        userEntry,
        assistantEntry,
        compactSummaryEntry,
        postCompactionAssistant,
        secondCompactSummaryEntry,
        secondPostCompactionAssistant,
      ]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.compactionCount).toBe(2);
        // After second compaction: summary(2) + next assistant(2) = 4
        expect(result.metrics.visibleContextTokens).toBe(4);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('total context', () => {
    it('should set totalContextTokens from last main-thread assistant usage', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.totalContextTokens).toBe(180); // 100 + 50 + 20 + 10
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('ongoing detection', () => {
    it('should detect ended session (stop_reason=end_turn)', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.isOngoing).toBe(false);
      } finally {
        cleanup(filePath);
      }
    });

    it('should detect ongoing session (stop_reason=tool_use)', async () => {
      const filePath = writeTempJsonl([userEntry, toolUseAssistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.isOngoing).toBe(true);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('pricing integration', () => {
    it('should calculate cost via PricingService', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath, { pricingService: mockPricing });
        expect(mockPricing.calculateMessageCost).toHaveBeenCalledWith(
          'claude-sonnet-4-6',
          100,
          50,
          20,
          10,
        );
        expect(result.metrics.costUsd).toBe(0.01);
        expect(result.metrics.contextWindowTokens).toBe(200_000);
      } finally {
        cleanup(filePath);
      }
    });

    it('should use default 200k fallback when no pricing service is provided', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.metrics.contextWindowTokens).toBe(200_000);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('error handling', () => {
    it('should skip malformed JSON lines gracefully', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
      const filePath = path.join(dir, 'test.jsonl');
      const content =
        [
          JSON.stringify(userEntry),
          'this is not valid json{{{',
          JSON.stringify(assistantEntry),
        ].join('\n') + '\n';
      fs.writeFileSync(filePath, content, 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        cleanup(filePath);
      }
    });

    it('should skip empty lines', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
      const filePath = path.join(dir, 'test.jsonl');
      const content =
        [JSON.stringify(userEntry), '', '  ', JSON.stringify(assistantEntry)].join('\n') + '\n';
      fs.writeFileSync(filePath, content, 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('incremental parsing', () => {
    it('should parse from byte offset', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        // First parse: get the full file bytesRead
        const fullResult = await parseClaudeJsonl(filePath);
        expect(fullResult.bytesRead).toBeGreaterThan(0);

        // Parse with offset at end: should return 0 messages
        const incResult = await parseClaudeJsonl(filePath, {
          byteOffset: fullResult.bytesRead,
        });
        expect(incResult.messages).toHaveLength(0);
      } finally {
        cleanup(filePath);
      }
    });

    it('should respect maxMessages limit', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry, thinkingAssistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath, { maxMessages: 1 });
        expect(result.messages).toHaveLength(1);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('warnings', () => {
    it('returns no warnings when all lines are under the size limit', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.warnings).toBeUndefined();
      } finally {
        cleanup(filePath);
      }
    });

    it('returns a warning when oversized lines are skipped', async () => {
      // Create a line that exceeds the 10MB limit
      const hugeText = 'X'.repeat(11 * 1024 * 1024);
      const hugeEntry = {
        type: 'assistant',
        uuid: 'asst-huge',
        parentUuid: 'user-1',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: hugeText }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };

      const filePath = writeTempJsonl([userEntry, hugeEntry]);
      try {
        const result = await parseClaudeJsonl(filePath);
        // The oversized line should have been skipped
        expect(result.messages).toHaveLength(1);
        expect(result.warnings).toBeDefined();
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings![0]).toMatch(/Skipped 1 oversized line/);
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('oversized line logging', () => {
    beforeEach(() => {
      mockLoggerWarn.mockClear();
    });

    it('logs byte offset and content snippet for >10MB lines', async () => {
      const hugeText = 'Z'.repeat(11 * 1024 * 1024);
      const hugeEntry = {
        type: 'assistant',
        uuid: 'asst-huge',
        parentUuid: 'user-1',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: hugeText }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };

      const filePath = writeTempJsonl([userEntry, hugeEntry]);
      try {
        await parseClaudeJsonl(filePath);

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
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('large file handling', () => {
    it('parses JSONL file larger than 10MB without size gate', async () => {
      // Create enough entries to exceed 10MB
      const largeText = 'X'.repeat(100_000); // ~100KB per entry
      const entries: object[] = [];
      for (let i = 0; i < 120; i++) {
        const minute = String(Math.floor(i / 60)).padStart(2, '0');
        const second = String(i % 60).padStart(2, '0');
        entries.push({
          type: 'user',
          uuid: `user-${i}`,
          parentUuid: i > 0 ? `asst-${i - 1}` : null,
          isSidechain: false,
          timestamp: `2026-01-01T10:${minute}:${second}.000Z`,
          message: { role: 'user', content: `${largeText}-${i}` },
        });
        entries.push({
          type: 'assistant',
          uuid: `asst-${i}`,
          parentUuid: `user-${i}`,
          isSidechain: false,
          timestamp: `2026-01-01T10:${minute}:${second}.500Z`,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: `${largeText}-reply-${i}` }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        });
      }

      const filePath = writeTempJsonl(entries);
      try {
        const stat = fs.statSync(filePath);
        expect(stat.size).toBeGreaterThan(10 * 1024 * 1024);

        const result = await parseClaudeJsonl(filePath);
        expect(result.messages.length).toBe(240);
        expect(result.metrics.messageCount).toBe(240);
        expect(result.warnings).toBeUndefined();
      } finally {
        cleanup(filePath);
      }
    });

    it('handles incremental parse of large file correctly', async () => {
      const filePath = writeTempJsonl([userEntry, assistantEntry]);
      try {
        const initialResult = await parseClaudeJsonl(filePath);
        expect(initialResult.messages).toHaveLength(2);

        // Append a large entry (>1MB but <10MB)
        const largeText = 'Y'.repeat(2 * 1024 * 1024);
        const newEntry = {
          type: 'assistant',
          uuid: 'asst-large-inc',
          parentUuid: 'asst-1',
          isSidechain: false,
          timestamp: '2026-01-01T10:00:15.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: largeText }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 500,
              output_tokens: 200,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        };
        fs.appendFileSync(filePath, JSON.stringify(newEntry) + '\n');

        // Parse incrementally from the byte offset
        const incrementalResult = await parseClaudeJsonl(filePath, {
          byteOffset: initialResult.bytesRead,
        });

        expect(incrementalResult.messages).toHaveLength(1);
        expect(incrementalResult.messages[0].id).toBe('asst-large-inc');
        const textBlock = incrementalResult.messages[0].content.find((c) => c.type === 'text');
        expect(textBlock).toBeDefined();
        if (textBlock?.type === 'text') {
          expect(textBlock.text.length).toBeGreaterThan(2 * 1024 * 1024 - 1);
        }
      } finally {
        cleanup(filePath);
      }
    });
  });

  describe('per-line size limit', () => {
    it('parses lines >1MB but <10MB (previously skipped)', async () => {
      // Create an assistant entry with a ~2MB text block
      const largeText = 'A'.repeat(2 * 1024 * 1024);
      const largeAssistant = {
        type: 'assistant',
        uuid: 'asst-large',
        parentUuid: 'user-1',
        isSidechain: false,
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: largeText }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 500,
            output_tokens: 200,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      };

      const filePath = writeTempJsonl([userEntry, largeAssistant]);
      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[1].role).toBe('assistant');
        // Verify the large content was actually parsed
        const textBlock = result.messages[1].content.find((c) => c.type === 'text');
        expect(textBlock).toBeDefined();
        if (textBlock?.type === 'text') {
          expect(textBlock.text.length).toBeGreaterThan(2 * 1024 * 1024 - 1);
        }
      } finally {
        cleanup(filePath);
      }
    });
  });
});
