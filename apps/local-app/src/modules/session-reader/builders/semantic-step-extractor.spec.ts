import { extractSemanticSteps } from './semantic-step-extractor';
import type { UnifiedMessage, TokenUsage } from '../dtos/unified-session.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  overrides: Partial<UnifiedMessage> & { id: string; role: UnifiedMessage['role'] },
): UnifiedMessage {
  return {
    parentId: null,
    timestamp: new Date('2026-01-01T10:00:00.000Z'),
    content: [],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenUsage {
  return { input, output, cacheRead, cacheCreation };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSemanticSteps', () => {
  it('should extract thinking step from thinking content block', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me analyze this...', signature: 'sig' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('thinking');
    expect(steps[0].content.thinkingText).toBe('Let me analyze this...');
    expect(steps[0].estimatedTokens).toBe(Math.ceil('Let me analyze this...'.length / 4));
    expect(steps[0].sourceMessageId).toBe('a1');
    expect(steps[0].context).toBe('main');
  });

  it('should extract output step from text content block', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Here is the answer.' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('output');
    expect(steps[0].content.outputText).toBe('Here is the answer.');
    expect(steps[0].content.sourceModel).toBe('claude-sonnet-4-6');
    expect(steps[0].estimatedTokens).toBe(Math.ceil('Here is the answer.'.length / 4));
  });

  it('should extract tool_call step from tool_call content block', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Read',
            input: { file_path: '/some/file.ts' },
          },
        ],
        toolCalls: [
          { id: 'tc-1', name: 'Read', input: { file_path: '/some/file.ts' }, isTask: false },
        ],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('tool_call');
    expect(steps[0].content.toolName).toBe('Read');
    expect(steps[0].content.toolCallId).toBe('tc-1');
    expect(steps[0].content.toolInput).toEqual({ file_path: '/some/file.ts' });
    expect(steps[0].estimatedTokens).toBe(
      Math.ceil(JSON.stringify({ file_path: '/some/file.ts' }).length / 4),
    );
  });

  it('should extract subagent step for Task tool calls', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-task',
            toolName: 'Task',
            input: { prompt: 'do something' },
          },
        ],
        toolCalls: [
          {
            id: 'tc-task',
            name: 'Task',
            input: { prompt: 'do something' },
            isTask: true,
            taskDescription: 'Research something',
          },
        ],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('subagent');
    expect(steps[0].content.toolName).toBe('Task');
    expect(steps[0].content.subagentDescription).toBe('Research something');
    expect(steps[0].estimatedTokens).toBe(0);
  });

  it('should extract tool_result steps from user messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        toolResults: [{ toolCallId: 'tc-1', content: 'file contents here', isError: false }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('tool_result');
    expect(steps[0].content.toolCallId).toBe('tc-1');
    expect(steps[0].content.toolResultContent).toBe('file contents here');
    expect(steps[0].content.isError).toBe(false);
    expect(steps[0].estimatedTokens).toBe(Math.ceil('file contents here'.length / 4));
  });

  it('should extract error tool_result', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        toolResults: [{ toolCallId: 'tc-1', content: 'Error: file not found', isError: true }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].content.isError).toBe(true);
  });

  it('should extract interruption step from text with interruption pattern', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('interruption');
    expect(steps[0].content.interruptionText).toBe('[Request interrupted by user]');
    expect(steps[0].estimatedTokens).toBe(0);
  });

  it('should skip empty text blocks', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Actual output' },
        ],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('output');
    expect(steps[0].content.outputText).toBe('Actual output');
  });

  it('should extract multiple steps from a single assistant message', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Analyzing...', signature: 'sig' },
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Read',
            input: { file_path: '/file.ts' },
          },
          { type: 'text', text: 'Let me read the file.' },
        ],
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { file_path: '/file.ts' }, isTask: false }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(3);
    expect(steps[0].type).toBe('thinking');
    expect(steps[1].type).toBe('tool_call');
    expect(steps[2].type).toBe('output');
  });

  it('should include token info when usage is present', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        usage: usage(500, 200, 50),
        content: [{ type: 'text', text: 'Response' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps[0].tokens).toEqual({ input: 500, output: 200, cached: 50 });
  });

  it('should not include tokens when usage is absent', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps[0].tokens).toBeUndefined();
  });

  it('should set context to "subagent" for sidechain messages', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        isSidechain: true,
        content: [{ type: 'text', text: 'Subagent output' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps[0].context).toBe('subagent');
  });

  it('should handle multi-message AI buffer with interleaved tool results', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Read',
            input: { file_path: '/a.ts' },
          },
        ],
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { file_path: '/a.ts' }, isTask: false }],
      }),
      makeMsg({
        id: 'u1',
        role: 'user',
        isMeta: true,
        toolResults: [{ toolCallId: 'tc-1', content: 'file content', isError: false }],
      }),
      makeMsg({
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'I read the file.' }],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps).toHaveLength(3);
    expect(steps[0].type).toBe('tool_call');
    expect(steps[0].content.toolName).toBe('Read');
    expect(steps[1].type).toBe('tool_result');
    expect(steps[1].content.toolCallId).toBe('tc-1');
    expect(steps[2].type).toBe('output');
    expect(steps[2].content.outputText).toBe('I read the file.');
  });

  it('should return empty array for empty messages', () => {
    expect(extractSemanticSteps([])).toEqual([]);
  });

  it('should assign sequential step IDs', () => {
    const messages: UnifiedMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Think', signature: 'sig' },
          { type: 'text', text: 'Output' },
        ],
      }),
    ];

    const steps = extractSemanticSteps(messages);

    expect(steps.map((s) => s.id)).toEqual(['step-0', 'step-1']);
  });
});
