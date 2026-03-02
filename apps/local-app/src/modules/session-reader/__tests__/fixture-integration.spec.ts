import * as path from 'node:path';
import { parseClaudeJsonl } from '../parsers/claude-jsonl.parser';
import type { PricingServiceInterface } from '../services/pricing.interface';

/**
 * Integration tests using real JSONL fixture files.
 * These verify end-to-end parsing against representative session data.
 */

const FIXTURES_DIR = path.join(__dirname, '..', '__fixtures__');

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.001),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

describe('Fixture-based integration tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('simple-session.jsonl', () => {
    const filePath = path.join(FIXTURES_DIR, 'simple-session.jsonl');

    it('should parse all messages correctly', async () => {
      const result = await parseClaudeJsonl(filePath, { pricingService: mockPricing });

      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[3].role).toBe('assistant');
    });

    it('should preserve message parent chain', async () => {
      const result = await parseClaudeJsonl(filePath);

      expect(result.messages[0].parentId).toBeNull();
      expect(result.messages[1].parentId).toBe('u-001');
      expect(result.messages[2].parentId).toBe('a-001');
      expect(result.messages[3].parentId).toBe('u-002');
    });

    it('should aggregate token usage', async () => {
      const result = await parseClaudeJsonl(filePath, { pricingService: mockPricing });

      // assistant a-001: input=120, output=25, cacheRead=0
      // assistant a-002: input=180, output=30, cacheRead=50
      expect(result.metrics.inputTokens).toBe(300);
      expect(result.metrics.outputTokens).toBe(55);
      expect(result.metrics.cacheReadTokens).toBe(50);
    });

    it('should compute duration from first to last timestamp', async () => {
      const result = await parseClaudeJsonl(filePath);

      // From 10:00:00 to 10:00:35 = 35000ms
      expect(result.metrics.durationMs).toBe(35000);
    });

    it('should detect session as not ongoing (end_turn)', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.metrics.isOngoing).toBe(false);
    });

    it('should identify primary model', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.metrics.primaryModel).toBe('claude-sonnet-4-6');
    });

    it('should call pricing service for each assistant with usage', async () => {
      await parseClaudeJsonl(filePath, { pricingService: mockPricing });
      expect(mockPricing.calculateMessageCost).toHaveBeenCalledTimes(2);
    });

    it('should track bytesRead for full file', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.bytesRead).toBeGreaterThan(0);
    });
  });

  describe('session-with-tools.jsonl', () => {
    const filePath = path.join(FIXTURES_DIR, 'session-with-tools.jsonl');

    it('should parse all 8 messages', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.messages).toHaveLength(8);
    });

    it('should extract tool calls from assistant messages', async () => {
      const result = await parseClaudeJsonl(filePath);

      // a-101 has a Read tool call
      const readMsg = result.messages[1];
      expect(readMsg.toolCalls).toHaveLength(1);
      expect(readMsg.toolCalls[0].name).toBe('Read');
      expect(readMsg.toolCalls[0].input).toEqual({ file_path: 'src/index.ts' });
      expect(readMsg.toolCalls[0].isTask).toBe(false);
    });

    it('should extract tool results from user messages', async () => {
      const result = await parseClaudeJsonl(filePath);

      // u-102 has a tool_result
      const resultMsg = result.messages[2];
      expect(resultMsg.toolResults).toHaveLength(1);
      expect(resultMsg.toolResults[0].toolCallId).toBe('tool-001');
      expect(resultMsg.toolResults[0].content).toBe("console.log('hello world');");
    });

    it('should identify Task tool calls with subagent metadata', async () => {
      const result = await parseClaudeJsonl(filePath);

      // a-103 has a Task tool call
      const taskMsg = result.messages[5];
      expect(taskMsg.toolCalls).toHaveLength(1);
      expect(taskMsg.toolCalls[0].name).toBe('Task');
      expect(taskMsg.toolCalls[0].isTask).toBe(true);
      expect(taskMsg.toolCalls[0].taskDescription).toBe('Run unit tests');
      expect(taskMsg.toolCalls[0].taskSubagentType).toBe('Bash');
    });

    it('should detect ongoing session at tool_use stop_reason', async () => {
      // The last assistant (a-104) has end_turn, so session is not ongoing
      const result = await parseClaudeJsonl(filePath);
      expect(result.metrics.isOngoing).toBe(false);
    });

    it('should aggregate tokens across all assistants', async () => {
      const result = await parseClaudeJsonl(filePath);

      // Sum of all assistant input_tokens: 150+200+280+350 = 980
      expect(result.metrics.inputTokens).toBe(980);
      // Sum of all output_tokens: 40+20+50+15 = 125
      expect(result.metrics.outputTokens).toBe(125);
    });

    it('should include tool_call content blocks in assistant content', async () => {
      const result = await parseClaudeJsonl(filePath);

      const readMsg = result.messages[1]; // a-101
      const toolCallBlock = readMsg.content.find((b) => b.type === 'tool_call');
      expect(toolCallBlock).toBeDefined();
    });

    it('should include tool_result content blocks in user content', async () => {
      const result = await parseClaudeJsonl(filePath);

      const resultMsg = result.messages[2]; // u-102
      const toolResultBlock = resultMsg.content.find((b) => b.type === 'tool_result');
      expect(toolResultBlock).toBeDefined();
    });
  });

  describe('session-with-thinking.jsonl', () => {
    const filePath = path.join(FIXTURES_DIR, 'session-with-thinking.jsonl');

    it('should parse all 4 messages', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.messages).toHaveLength(4);
    });

    it('should extract thinking blocks with signature', async () => {
      const result = await parseClaudeJsonl(filePath);

      // a-201 has a thinking block
      const thinkMsg = result.messages[1];
      const thinkingBlock = thinkMsg.content.find((b) => b.type === 'thinking');
      expect(thinkingBlock).toBeDefined();
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        expect(thinkingBlock.thinking).toContain('let and const');
        expect(thinkingBlock.signature).toBe('sig-abc123');
      }
    });

    it('should have text blocks alongside thinking blocks', async () => {
      const result = await parseClaudeJsonl(filePath);

      const msg = result.messages[1];
      const textBlock = msg.content.find((b) => b.type === 'text');
      expect(textBlock).toBeDefined();
    });

    it('should track multiple thinking entries', async () => {
      const result = await parseClaudeJsonl(filePath);

      // Both a-201 and a-202 have thinking blocks
      const thinkingMessages = result.messages.filter((m) =>
        m.content.some((b) => b.type === 'thinking'),
      );
      expect(thinkingMessages).toHaveLength(2);
    });

    it('should identify opus model', async () => {
      const result = await parseClaudeJsonl(filePath);
      expect(result.metrics.primaryModel).toBe('claude-opus-4-6');
    });

    it('should track cache creation tokens', async () => {
      const result = await parseClaudeJsonl(filePath);

      // a-201: cacheCreation=50, a-202: cacheCreation=30
      expect(result.metrics.cacheCreationTokens).toBe(80);
    });
  });

  describe('edge cases', () => {
    it('should handle empty file gracefully', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-test-'));
      const filePath = path.join(dir, 'empty.jsonl');
      fs.writeFileSync(filePath, '', 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);

        expect(result.messages).toHaveLength(0);
        expect(result.metrics.messageCount).toBe(0);
        expect(result.metrics.totalTokens).toBe(0);
        // Empty file: no assistant stop_reason → parser treats as ongoing (null → true)
        expect(result.metrics.isOngoing).toBe(true);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should handle file with only blank lines', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-test-'));
      const filePath = path.join(dir, 'blank.jsonl');
      fs.writeFileSync(filePath, '\n\n\n\n', 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(0);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should handle file with only filtered types', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filtered-test-'));
      const filePath = path.join(dir, 'filtered.jsonl');
      const content = [
        JSON.stringify({ type: 'summary', uuid: 's-1' }),
        JSON.stringify({ type: 'file-history-snapshot', uuid: 'fh-1' }),
        JSON.stringify({ type: 'system', uuid: 'sys-1' }),
        JSON.stringify({ type: 'progress', uuid: 'p-1' }),
      ].join('\n');
      fs.writeFileSync(filePath, content + '\n', 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(0);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should handle mixed valid and malformed lines', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-test-'));
      const filePath = path.join(dir, 'mixed.jsonl');
      const content = [
        'not valid json',
        JSON.stringify({
          type: 'user',
          uuid: 'u-1',
          parentUuid: null,
          isSidechain: false,
          timestamp: '2026-01-01T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        }),
        '{incomplete json',
        JSON.stringify({
          type: 'assistant',
          uuid: 'a-1',
          parentUuid: 'u-1',
          isSidechain: false,
          timestamp: '2026-01-01T10:00:05.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      ].join('\n');
      fs.writeFileSync(filePath, content + '\n', 'utf8');

      try {
        const result = await parseClaudeJsonl(filePath);
        expect(result.messages).toHaveLength(2);
      } finally {
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
      }
    });

    it('should handle incremental parsing from byte offset', async () => {
      const simpleFile = path.join(FIXTURES_DIR, 'simple-session.jsonl');

      // First parse: get bytesRead after first 2 messages
      const first = await parseClaudeJsonl(simpleFile, { maxMessages: 2 });
      expect(first.messages).toHaveLength(2);

      // Second parse: continue from offset
      const second = await parseClaudeJsonl(simpleFile, {
        byteOffset: first.bytesRead,
      });
      expect(second.messages).toHaveLength(2); // remaining 2 messages
      expect(second.messages[0].role).toBe('user');
      expect(second.messages[1].role).toBe('assistant');
    });
  });
});
