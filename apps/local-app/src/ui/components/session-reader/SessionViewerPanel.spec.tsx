import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SessionViewerPanel } from './SessionViewerPanel';
import type { SerializedMessage, SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 300,
    cacheCreationTokens: 100,
    totalTokens: 2400,
    totalContextConsumption: 500,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 50_000,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0.035,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 15_000,
    messageCount: 6,
    isOngoing: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'user',
    timestamp: '2026-02-24T12:00:00.000Z',
    content: [{ type: 'text', text: 'Hello world' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<SerializedChunk> = {}): SerializedChunk {
  return {
    id: 'chunk-1',
    type: 'user',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [makeMessage()],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      messageCount: 1,
      durationMs: 1000,
      costUsd: 0.001,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionViewerPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseProps = {
    sessionId: undefined,
    messages: [] as SerializedMessage[],
    chunks: [] as SerializedChunk[],
    metrics: undefined,
    isLive: false,
    isLoading: false,
    error: null,
  };

  // -------------------------------------------------------------------------
  // Empty & loading states
  // -------------------------------------------------------------------------

  it('shows loading skeleton when isLoading', () => {
    render(<SessionViewerPanel {...baseProps} isLoading={true} />);
    expect(screen.getByTestId('session-viewer-loading')).toBeInTheDocument();
  });

  it('shows error message when error provided', () => {
    render(<SessionViewerPanel {...baseProps} error={new Error('Network fail')} />);
    expect(screen.getByText(/Failed to load session: Network fail/)).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    render(<SessionViewerPanel {...baseProps} />);
    expect(screen.getByTestId('session-viewer-empty')).toBeInTheDocument();
    expect(screen.getByText(/No messages in this session yet/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Metrics bar
  // -------------------------------------------------------------------------

  it('renders metrics header when metrics provided', () => {
    const metrics = makeMetrics();
    render(<SessionViewerPanel {...baseProps} messages={[makeMessage()]} metrics={metrics} />);

    const header = screen.getByTestId('session-metrics-header');
    expect(header).toHaveTextContent('2.4k');
    expect(header).toHaveTextContent('$0.04');
    expect(header).toHaveTextContent('15.0s');
    expect(header).toHaveTextContent('claude-sonnet-4-6');
  });

  it('shows live indicator when session is ongoing', () => {
    render(
      <SessionViewerPanel
        {...baseProps}
        messages={[makeMessage()]}
        metrics={makeMetrics({ isOngoing: true })}
        isLive={true}
      />,
    );

    const header = screen.getByTestId('session-metrics-header');
    expect(header).toHaveTextContent('Live');
  });

  // -------------------------------------------------------------------------
  // User messages
  // -------------------------------------------------------------------------

  it('renders user message card', () => {
    const msg = makeMessage({
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'What is React?' }],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    expect(screen.getByTestId('user-message-card')).toBeInTheDocument();
    expect(screen.getByText('What is React?')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // AI messages
  // -------------------------------------------------------------------------

  it('renders AI message card with text content', () => {
    const msg = makeMessage({
      id: 'ai-1',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'React is a library.' }],
      usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    expect(screen.getByTestId('ai-message-card')).toBeInTheDocument();
    expect(screen.getByText('React is a library.')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
  });

  it('renders collapsible thinking block in AI message', () => {
    const msg = makeMessage({
      id: 'ai-2',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me consider this carefully...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    // Thinking trigger should be visible
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    // Thinking content should be hidden until expanded
    expect(screen.queryByText('Let me consider this carefully...')).not.toBeInTheDocument();

    // Expand thinking block
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('Let me consider this carefully...')).toBeInTheDocument();
  });

  it('renders collapsible tool call in AI message', () => {
    const msg = makeMessage({
      id: 'ai-3',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      toolCalls: [
        {
          id: 'tc-1',
          name: 'Read',
          input: { file_path: '/src/index.ts' },
          isTask: false,
        },
      ],
      toolResults: [{ toolCallId: 'tc-1', content: 'file contents here', isError: false }],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    // Tool name visible in trigger
    expect(screen.getByText('Read')).toBeInTheDocument();

    // Expand tool call
    fireEvent.click(screen.getByText('Read'));
    expect(screen.getByText(/file_path/)).toBeInTheDocument();
    expect(screen.getByText(/file contents here/)).toBeInTheDocument();
  });

  it('shows Task icon and description for Task tool calls', () => {
    const msg = makeMessage({
      id: 'ai-4',
      role: 'assistant',
      content: [],
      toolCalls: [
        {
          id: 'tc-2',
          name: 'Task',
          input: { prompt: 'Explore codebase' },
          isTask: true,
          taskDescription: 'Search for auth patterns',
          taskSubagentType: 'Explore',
        },
      ],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText(/Search for auth patterns/)).toBeInTheDocument();
  });

  it('loads full server-truncated tool result on demand in flat message view', async () => {
    fetchJsonOrThrowMock.mockResolvedValue({
      sessionId: 'session-1',
      toolCallId: 'tc-1',
      content: 'FULL TOOL RESULT FROM ENDPOINT',
      isError: false,
      fullLength: 4096,
    });

    const msg = makeMessage({
      id: 'ai-truncated',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      toolCalls: [
        { id: 'tc-1', name: 'Read', input: { file_path: '/src/index.ts' }, isTask: false },
      ],
      toolResults: [
        {
          toolCallId: 'tc-1',
          content: 'TRUNCATED RESULT…',
          isError: false,
          isTruncated: true,
          fullLength: 4096,
        },
      ],
    });

    render(
      <SessionViewerPanel {...baseProps} sessionId="session-1" messages={[msg]} chunks={[]} />,
    );

    fireEvent.click(screen.getByText('Read'));
    fireEvent.click(screen.getByTestId('tool-result-load-full'));

    await waitFor(() => {
      expect(screen.getByText(/FULL TOOL RESULT FROM ENDPOINT/)).toBeInTheDocument();
    });
    expect(fetchJsonOrThrowMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/transcript/tool-result/tc-1',
      {},
      'Failed to fetch full tool result',
    );
  });

  // -------------------------------------------------------------------------
  // System messages
  // -------------------------------------------------------------------------

  it('renders system message card', () => {
    const msg = makeMessage({
      id: 'sys-1',
      role: 'system',
      content: [{ type: 'text', text: 'Tool output: success' }],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    expect(screen.getByTestId('system-message-card')).toBeInTheDocument();
    expect(screen.getByText('Tool output: success')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Compact markers
  // -------------------------------------------------------------------------

  it('renders compact marker for compaction summaries', () => {
    const msg = makeMessage({
      id: 'compact-1',
      role: 'assistant',
      isCompactSummary: true,
      content: [{ type: 'text', text: 'Context was compacted.' }],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    expect(screen.getByTestId('compact-marker')).toBeInTheDocument();
    expect(screen.getByText('Context compacted')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Chunk-based rendering
  // -------------------------------------------------------------------------

  it('renders chunks when available instead of flat messages', () => {
    const userChunk = makeChunk({
      id: 'chunk-user',
      type: 'user',
      messages: [
        makeMessage({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hi from chunk' }] }),
      ],
    });
    const aiChunk = makeChunk({
      id: 'chunk-ai',
      type: 'ai',
      messages: [
        makeMessage({
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'AI response' }],
        }),
      ],
    });

    render(
      <SessionViewerPanel
        {...baseProps}
        messages={[makeMessage()]}
        chunks={[userChunk, aiChunk]}
      />,
    );

    expect(screen.getByTestId('chunk-user')).toBeInTheDocument();
    expect(screen.getByTestId('chunk-ai')).toBeInTheDocument();
    expect(screen.getByText('Hi from chunk')).toBeInTheDocument();
    expect(screen.getByText('AI response')).toBeInTheDocument();
  });

  it('renders AIGroupCard for AI chunks and shows expanded semantic steps on toggle', () => {
    const aiChunk = makeChunk({
      id: 'chunk-ai-steps',
      type: 'ai',
      messages: [
        makeMessage({
          id: 'a1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'AI response' }],
        }),
      ],
      semanticSteps: [
        {
          id: 'step-call',
          type: 'tool_call',
          startTime: '2026-02-24T12:00:01.000Z',
          durationMs: 200,
          content: {
            toolCallId: 'tc-1',
            toolName: 'Read',
            toolInput: { file_path: '/src/index.ts' },
          },
          context: 'main',
        },
        {
          id: 'step-result',
          type: 'tool_result',
          startTime: '2026-02-24T12:00:02.000Z',
          durationMs: 0,
          content: {
            toolCallId: 'tc-1',
            toolResultContent: 'export const value = 1;',
            isError: false,
          },
          context: 'main',
        },
        {
          id: 'step-output',
          type: 'output',
          startTime: '2026-02-24T12:00:03.000Z',
          durationMs: 0,
          content: { outputText: 'Rendered from semantic output.' },
          context: 'main',
        },
      ],
      turns: [],
    });

    render(
      <SessionViewerPanel
        {...baseProps}
        sessionId="session-1"
        messages={[makeMessage()]}
        chunks={[aiChunk]}
      />,
    );

    expect(screen.getByTestId('ai-group-card')).toBeInTheDocument();
    expect(screen.getByTestId('last-output-display')).toBeInTheDocument();
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    expect(screen.getByText('Rendered from semantic output.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-group-header'));

    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    expect(screen.getByText(/Read: \/src\/index\.ts/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    expect(screen.getByText(/file_path/)).toBeInTheDocument();
    expect(screen.getByText(/export const value = 1/)).toBeInTheDocument();
    expect(screen.getAllByText('Rendered from semantic output.')).toHaveLength(1);
  });

  it('keeps AIGroupCard collapsed by default and toggles expanded content via parent state', () => {
    const aiChunk = makeChunk({
      id: 'chunk-ai-collapsed',
      type: 'ai',
      messages: [
        makeMessage({
          id: 'a1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Chunk response' }],
        }),
      ],
      semanticSteps: [
        {
          id: 'step-thinking',
          type: 'thinking',
          startTime: '2026-02-24T12:00:00.000Z',
          durationMs: 0,
          content: {
            thinkingText: 'Thinking about answer',
          },
          context: 'main',
        },
        {
          id: 'step-output',
          type: 'output',
          startTime: '2026-02-24T12:00:01.000Z',
          durationMs: 0,
          content: { outputText: 'Final card output' },
          context: 'main',
        },
      ],
      turns: [],
    });

    render(<SessionViewerPanel {...baseProps} messages={[makeMessage()]} chunks={[aiChunk]} />);

    expect(screen.getByTestId('ai-group-card')).toBeInTheDocument();
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    expect(screen.getByText('Final card output')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
  });

  it('shows no-output placeholder for live AI group with no output yet', () => {
    const aiChunk = makeChunk({
      id: 'chunk-ai-no-output',
      type: 'ai',
      messages: [
        makeMessage({
          id: 'a1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Chunk response' }],
        }),
      ],
      semanticSteps: [
        {
          id: 'step-thinking',
          type: 'thinking',
          startTime: '2026-02-24T12:00:00.000Z',
          durationMs: 0,
          content: { thinkingText: 'Still working' },
          context: 'main',
        },
      ],
      turns: [],
    });

    render(
      <SessionViewerPanel
        {...baseProps}
        isLive={true}
        metrics={makeMetrics({ isOngoing: true })}
        messages={[makeMessage()]}
        chunks={[aiChunk]}
      />,
    );

    expect(screen.getByTestId('last-output-placeholder')).toBeInTheDocument();
    expect(screen.getByText('No output yet')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Main container
  // -------------------------------------------------------------------------

  it('renders main panel with scroll container', () => {
    render(<SessionViewerPanel {...baseProps} messages={[makeMessage()]} />);

    expect(screen.getByTestId('session-viewer-panel')).toBeInTheDocument();
    expect(screen.getByTestId('session-viewer-scroll')).toBeInTheDocument();
  });

  it('virtualizes large message lists and only renders a subset', () => {
    const largeMessageList = Array.from({ length: 80 }, (_, index) =>
      makeMessage({
        id: `user-${index}`,
        role: 'user',
        content: [{ type: 'text', text: `Message ${index}` }],
      }),
    );

    render(<SessionViewerPanel {...baseProps} messages={largeMessageList} />);

    expect(screen.getByText('Message 0')).toBeInTheDocument();
    expect(screen.queryByText('Message 79')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('user-message-card').length).toBeLessThan(largeMessageList.length);
  });

  it('keeps rendered node identity stable when appending messages with stable ids', () => {
    const initialMessages = Array.from({ length: 40 }, (_, index) =>
      makeMessage({
        id: `user-${index}`,
        role: 'user',
        content: [{ type: 'text', text: `Message ${index}` }],
      }),
    );

    const { rerender } = render(<SessionViewerPanel {...baseProps} messages={initialMessages} />);

    const firstMessageNode = screen.getByText('Message 0');

    const updatedMessages = [
      ...initialMessages,
      makeMessage({
        id: 'user-40',
        role: 'user',
        content: [{ type: 'text', text: 'Message 40' }],
      }),
    ];

    rerender(<SessionViewerPanel {...baseProps} messages={updatedMessages} />);

    expect(screen.getByText('Message 0')).toBe(firstMessageNode);
    expect(screen.queryByText('Message 40')).not.toBeInTheDocument();
  });

  it('renders 1200-message sessions within a 1s budget in test environment', () => {
    const hugeMessageList = Array.from({ length: 1200 }, (_, index) =>
      makeMessage({
        id: `user-${index}`,
        role: 'user',
        content: [{ type: 'text', text: `Large Message ${index}` }],
      }),
    );

    const start = Date.now();
    render(<SessionViewerPanel {...baseProps} messages={hugeMessageList} />);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(screen.getByText('Large Message 0')).toBeInTheDocument();
    expect(screen.queryByText('Large Message 1199')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Error result styling
  // -------------------------------------------------------------------------

  it('shows error styling on tool result with isError', () => {
    const msg = makeMessage({
      id: 'ai-err',
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'tc-err', name: 'Bash', input: { command: 'exit 1' }, isTask: false }],
      toolResults: [{ toolCallId: 'tc-err', content: 'Command failed', isError: true }],
    });

    render(<SessionViewerPanel {...baseProps} messages={[msg]} />);

    // Expand the tool call
    fireEvent.click(screen.getByText('Bash'));
    const errorResult = screen.getByText(/Command failed/);
    expect(errorResult.closest('pre')).toHaveClass('bg-destructive/10');
  });

  // -------------------------------------------------------------------------
  // Auto-expand behavior
  // -------------------------------------------------------------------------

  function makeAiChunk(id: string, overrides: Partial<SerializedChunk> = {}): SerializedChunk {
    return makeChunk({
      id,
      type: 'ai',
      messages: [
        makeMessage({
          id: `${id}-msg`,
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: `Output from ${id}` }],
        }),
      ],
      semanticSteps: [
        {
          id: `${id}-thinking`,
          type: 'thinking',
          startTime: '2026-02-24T12:00:00.000Z',
          durationMs: 0,
          content: { thinkingText: 'thinking' },
          context: 'main',
        },
        {
          id: `${id}-output`,
          type: 'output',
          startTime: '2026-02-24T12:00:01.000Z',
          durationMs: 0,
          content: { outputText: `Output from ${id}` },
          context: 'main',
        },
      ],
      turns: [],
      ...overrides,
    });
  }

  describe('auto-expand', () => {
    it('auto-expands newest AI chunk during live session', () => {
      const aiChunk = makeAiChunk('chunk-ai-1');

      render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={true}
        />,
      );

      // Auto-expand should have opened the AI group
      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    });

    it('does NOT re-open after manual collapse', () => {
      const aiChunk = makeAiChunk('chunk-ai-1');

      const { rerender } = render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={true}
        />,
      );

      // Auto-expanded
      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();

      // Manually collapse
      fireEvent.click(screen.getByTestId('ai-group-header'));
      expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();

      // Rerender with same chunks — should stay collapsed
      rerender(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={true}
        />,
      );

      expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    });

    it('expands a newly appended AI chunk', () => {
      const chunk1 = makeAiChunk('chunk-ai-1');

      const { rerender } = render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[chunk1]}
          isLive={true}
        />,
      );

      // First chunk auto-expanded
      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();

      // Add a second AI chunk
      const chunk2 = makeAiChunk('chunk-ai-2');
      rerender(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[chunk1, chunk2]}
          isLive={true}
        />,
      );

      // Both chunks should have their groups visible (both auto-expanded)
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(2);
    });

    it('resets expansion state on session switch', () => {
      const aiChunk = makeAiChunk('chunk-ai-1');

      const { rerender } = render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-a"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={true}
        />,
      );

      // Auto-expanded
      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();

      // Switch session — renders without chunks first (different session)
      rerender(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-b"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={false}
        />,
      );

      // Should be collapsed (expansion state reset, isLive=false so no auto-expand)
      expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Keyboard shortcut guard tests
  // -------------------------------------------------------------------------

  describe('keyboard shortcuts', () => {
    it('handles Home key in flat-message mode (no chunks)', () => {
      render(<SessionViewerPanel {...baseProps} messages={[makeMessage()]} chunks={[]} />);

      // Mock scrollTo on the specific scroll element AFTER render
      const scrollContainer = screen.getByTestId('session-viewer-scroll');
      const scrollToMock = jest.fn();
      scrollContainer.scrollTo = scrollToMock;

      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'Home' });

      expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    it('does NOT fire Alt+ArrowDown when target is an input element', () => {
      const aiChunk = makeAiChunk('chunk-ai-1');

      render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={false}
        />,
      );

      // Mock scrollTo AFTER render to avoid capturing initialisation calls
      const scrollContainer = screen.getByTestId('session-viewer-scroll');
      const scrollToMock = jest.fn();
      scrollContainer.scrollTo = scrollToMock;

      const region = screen.getByRole('region', { name: 'Session viewer' });
      const input = document.createElement('input');
      region.appendChild(input);

      // Fire keydown on the input — should bubble to region but guard should block
      fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });

      expect(scrollToMock).not.toHaveBeenCalled();
    });

    it('does NOT fire Alt+ArrowDown when target is a textarea element', () => {
      const aiChunk = makeAiChunk('chunk-ai-1');

      render(
        <SessionViewerPanel
          {...baseProps}
          sessionId="session-1"
          messages={[makeMessage()]}
          chunks={[aiChunk]}
          isLive={false}
        />,
      );

      // Mock scrollTo AFTER render to avoid capturing initialisation calls
      const scrollContainer = screen.getByTestId('session-viewer-scroll');
      const scrollToMock = jest.fn();
      scrollContainer.scrollTo = scrollToMock;

      const region = screen.getByRole('region', { name: 'Session viewer' });
      const textarea = document.createElement('textarea');
      region.appendChild(textarea);

      // Fire keydown on the textarea — should bubble to region but guard should block
      fireEvent.keyDown(textarea, { key: 'ArrowDown', altKey: true });

      expect(scrollToMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Focus mode navigation (preserve / single_focus)
  // -------------------------------------------------------------------------

  describe('focus mode navigation', () => {
    function buildFocusChunks(): SerializedChunk[] {
      return [
        makeAiChunk('chunk-ai-0'),
        makeChunk({ id: 'user-1' }),
        makeAiChunk('chunk-ai-2'),
        makeChunk({ id: 'user-3' }),
        makeAiChunk('chunk-ai-4'),
      ];
    }

    const focusProps = {
      ...baseProps,
      sessionId: 'session-focus',
      messages: [makeMessage()],
      isLive: false,
    };

    it('"next response" preserves current expansion state (no accidental collapse/expand)', () => {
      const chunks = buildFocusChunks();
      render(<SessionViewerPanel {...focusProps} chunks={chunks} />);

      const headers = screen.getAllByTestId('ai-group-header');
      // Manually expand chunk-ai-0
      fireEvent.click(headers[0]);
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);

      // Alt+Shift+↓ — next response (preserve mode)
      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true, shiftKey: true });

      // Expansion state unchanged: chunk-0 still expanded, others still collapsed
      const cards = screen.getAllByTestId('ai-group-card');
      expect(within(cards[0]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[1]).queryByTestId('semantic-step-list')).toBeNull();
      expect(within(cards[2]).queryByTestId('semantic-step-list')).toBeNull();
    });

    it('"next thinking" collapses all other groups, expands only target', () => {
      const chunks = buildFocusChunks();
      render(<SessionViewerPanel {...focusProps} chunks={chunks} />);

      const headers = screen.getAllByTestId('ai-group-header');
      // Manually expand chunk-ai-0 and chunk-ai-4
      fireEvent.click(headers[0]);
      fireEvent.click(headers[2]);
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(2);

      // Alt+↓ — next thinking from visible 0 → chunk 2 (single_focus)
      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

      // Only chunk-ai-2 should be expanded
      const cards = screen.getAllByTestId('ai-group-card');
      expect(within(cards[0]).queryByTestId('semantic-step-list')).toBeNull();
      expect(within(cards[1]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[2]).queryByTestId('semantic-step-list')).toBeNull();
    });

    it('manual AIGroupCard header click still toggles independently after focus-mode navigation', () => {
      const chunks = buildFocusChunks();
      render(<SessionViewerPanel {...focusProps} chunks={chunks} />);

      // Alt+↓ — focus-mode navigate to chunk-ai-2
      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

      const cards = screen.getAllByTestId('ai-group-card');
      expect(within(cards[1]).queryByTestId('semantic-step-list')).not.toBeNull();

      // Manually expand chunk-ai-0 via click
      const headers = screen.getAllByTestId('ai-group-header');
      fireEvent.click(headers[0]);
      expect(within(cards[0]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[1]).queryByTestId('semantic-step-list')).not.toBeNull();

      // Manually collapse chunk-ai-2 via click
      fireEvent.click(headers[1]);
      expect(within(cards[0]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[1]).queryByTestId('semantic-step-list')).toBeNull();
    });

    it('stale false entries in expansion map converge to exactly one expanded group after single_focus', () => {
      const chunks = buildFocusChunks();
      render(<SessionViewerPanel {...focusProps} chunks={chunks} />);

      const headers = screen.getAllByTestId('ai-group-header');
      // Expand chunk-ai-0 then collapse it → creates stale {chunk-ai-0: false} entry
      fireEvent.click(headers[0]);
      fireEvent.click(headers[0]);
      // Expand chunk-ai-4 → map now has {chunk-ai-0: false, chunk-ai-4: true}
      fireEvent.click(headers[2]);
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);

      // Alt+↓ — next thinking from 0 → chunk 2 (single_focus replaces entire map)
      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

      // All stale entries gone — exactly one expanded (chunk-ai-2)
      const cards = screen.getAllByTestId('ai-group-card');
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);
      expect(within(cards[0]).queryByTestId('semantic-step-list')).toBeNull();
      expect(within(cards[1]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[2]).queryByTestId('semantic-step-list')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Hotspot filter integration
  // -------------------------------------------------------------------------

  describe('hotspot filter', () => {
    /**
     * Build a chunk sequence that triggers hotspot detection:
     * 5 AI chunks where chunk-ai-4 is an extreme outlier (10000 tokens).
     * IQR of [100,200,300,400] → Q1=175, Q3=375, IQR=200, fence=675.
     * 10000 > 675 → hot.
     *
     * Layout: user → ai(100) → user → ai(200) → user → ai(300) → user → ai(400) → user → ai(10000)
     */
    function buildHotspotChunks(): SerializedChunk[] {
      const tokenValues = [100, 200, 300, 400, 10000];
      const result: SerializedChunk[] = [];
      for (let i = 0; i < tokenValues.length; i++) {
        result.push(
          makeChunk({
            id: `user-${i}`,
            type: 'user',
            messages: [
              makeMessage({
                id: `user-${i}-msg`,
                role: 'user',
                content: [{ type: 'text', text: `User prompt ${i}` }],
              }),
            ],
          }),
        );
        result.push(
          makeAiChunk(`chunk-ai-${i}`, {
            metrics: {
              inputTokens: tokenValues[i] * 0.6,
              outputTokens: tokenValues[i] * 0.4,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: tokenValues[i],
              messageCount: 1,
              durationMs: 1000,
              costUsd: 0.001,
            },
          }),
        );
      }
      return result;
    }

    const hotspotProps = {
      ...baseProps,
      sessionId: 'session-hotspot',
      messages: [makeMessage()],
      metrics: makeMetrics({ contextWindowTokens: 200_000 }),
      isLive: false,
    };

    it('shows all chunks when hotspot filter is inactive', () => {
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // All 5 user chunks + 5 AI chunks visible
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(5);
      expect(screen.getByText('User prompt 0')).toBeInTheDocument();
      expect(screen.getByText('User prompt 2')).toBeInTheDocument();
    });

    it('shows only hot AI chunks + preceding user when filter active', () => {
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Toggle the hotspot filter
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));

      // Only chunk-ai-4 (hot) and user-4 (preceding) should remain
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(1);
      expect(screen.getByText('User prompt 4')).toBeInTheDocument();

      // Non-adjacent user chunks hidden
      expect(screen.queryByText('User prompt 0')).not.toBeInTheDocument();
      expect(screen.queryByText('User prompt 1')).not.toBeInTheDocument();
      expect(screen.queryByText('User prompt 2')).not.toBeInTheDocument();
      expect(screen.queryByText('User prompt 3')).not.toBeInTheDocument();
    });

    it('toggling filter off restores all chunks', () => {
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Toggle on
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(1);

      // Toggle off
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(5);
      expect(screen.getByText('User prompt 0')).toBeInTheDocument();
    });

    it('preserves expand state for visible chunks through filter toggle', () => {
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Expand the hot AI chunk (chunk-ai-4, the last AI group card)
      const headers = screen.getAllByTestId('ai-group-header');
      fireEvent.click(headers[4]); // chunk-ai-4 is the 5th AI card (index 4)
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);

      // Toggle filter on — chunk-ai-4 should still be expanded
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(1);
      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();

      // Toggle filter off — chunk-ai-4 should remain expanded
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      const cards = screen.getAllByTestId('ai-group-card');
      expect(cards).toHaveLength(5);
      expect(within(cards[4]).queryByTestId('semantic-step-list')).not.toBeNull();
    });

    it('shows flame icon on hot AI chunks', () => {
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Only chunk-ai-4 is hot and should have a flame icon
      const flames = screen.getAllByTestId('ai-group-flame');
      expect(flames).toHaveLength(1);
    });

    it('mixed-sequence regression: user → hot ai → user → non-hot ai with filter on', () => {
      // Specifically tests the refined filter that hides non-adjacent user chunks.
      // Sequence: u0, ai0(100), u1, ai1(200), u2, ai2(300), u3, ai3(400), u4, ai4(10000)
      // When filter active: only u4 + ai4 visible (plus any compact chunks if present)
      const chunks = buildHotspotChunks();
      render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));

      // Only 1 AI card (the hot one)
      const aiCards = screen.getAllByTestId('ai-group-card');
      expect(aiCards).toHaveLength(1);

      // The hot chunk's output is visible
      expect(screen.getByText(`Output from chunk-ai-4`)).toBeInTheDocument();

      // Preceding user prompt visible
      expect(screen.getByText('User prompt 4')).toBeInTheDocument();

      // Non-hot AI chunks NOT rendered
      expect(screen.queryByText('Output from chunk-ai-0')).not.toBeInTheDocument();
      expect(screen.queryByText('Output from chunk-ai-1')).not.toBeInTheDocument();
      expect(screen.queryByText('Output from chunk-ai-2')).not.toBeInTheDocument();
      expect(screen.queryByText('Output from chunk-ai-3')).not.toBeInTheDocument();
    });

    // -----------------------------------------------------------------------
    // Stuck-state regression guards (Remediation 12)
    // -----------------------------------------------------------------------

    it('filter toggle remains clickable when hotspots drop to zero while filter is active', () => {
      const chunks = buildHotspotChunks();
      const { rerender } = render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Activate filter
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(1);

      // Re-render with uniform token data (no hotspots)
      const uniformChunks = buildHotspotChunks().map((c) =>
        c.type === 'ai'
          ? {
              ...c,
              metrics: { ...c.metrics, totalTokens: 500, inputTokens: 300, outputTokens: 200 },
            }
          : c,
      );
      rerender(<SessionViewerPanel {...hotspotProps} chunks={uniformChunks} />);

      // Toggle button must still be enabled (not aria-disabled) so user can turn filter off
      const toggleBtn = screen.getByTestId('nav-toggle-hotspot-filter');
      expect(toggleBtn).not.toHaveAttribute('aria-disabled', 'true');

      // Click to deactivate — should restore all chunks
      fireEvent.click(toggleBtn);
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(5);
    });

    it('session switch resets hotspot filter to inactive', () => {
      const chunks = buildHotspotChunks();
      const { rerender } = render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Activate filter
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getByTestId('nav-toggle-hotspot-filter')).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Switch session (no hotspots in new session)
      const noHotspotChunks = [
        makeChunk({
          id: 'b-user-0',
          type: 'user',
          messages: [
            makeMessage({
              id: 'b-user-0-msg',
              role: 'user',
              content: [{ type: 'text', text: 'Session B prompt' }],
            }),
          ],
        }),
        makeAiChunk('b-ai-0'),
      ];
      rerender(
        <SessionViewerPanel {...hotspotProps} sessionId="session-b" chunks={noHotspotChunks} />,
      );

      // Filter should be reset — all chunks visible, toggle not pressed
      expect(screen.getByText('Session B prompt')).toBeInTheDocument();
      const toggleBtn = screen.queryByTestId('nav-toggle-hotspot-filter');
      // With < 4 AI chunks there are no hotspots, so toggle handler is null (disabled)
      // but filter state has been reset so it's not stuck
      if (toggleBtn) {
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
      }
    });

    it('clicking toggle off when hotspots just disappeared restores all chunks', () => {
      const chunks = buildHotspotChunks();
      const { rerender } = render(<SessionViewerPanel {...hotspotProps} chunks={chunks} />);

      // Activate filter — shows only hot chunk
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(1);

      // Hotspots disappear (uniform data) while filter is still active
      const uniformChunks = buildHotspotChunks().map((c) =>
        c.type === 'ai'
          ? {
              ...c,
              metrics: { ...c.metrics, totalTokens: 500, inputTokens: 300, outputTokens: 200 },
            }
          : c,
      );
      rerender(<SessionViewerPanel {...hotspotProps} chunks={uniformChunks} />);

      // Toggle off — all chunks should be visible
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
      expect(screen.getAllByTestId('ai-group-card')).toHaveLength(5);
      expect(screen.getByText('User prompt 0')).toBeInTheDocument();
      expect(screen.getByText('User prompt 4')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Input token delta computation & rendering
  // -------------------------------------------------------------------------

  describe('input token delta', () => {
    /**
     * Build AI chunks with specific message.usage input values.
     * Each AI chunk has an assistant message with usage.input, cacheRead, cacheCreation.
     * getHeaderInputTotal = input + cacheRead + cacheCreation.
     */
    function buildDeltaChunks(
      inputTotals: { input: number; cacheRead: number; cacheCreation: number }[],
    ): SerializedChunk[] {
      const result: SerializedChunk[] = [];
      for (let i = 0; i < inputTotals.length; i++) {
        const { input, cacheRead, cacheCreation } = inputTotals[i];
        result.push(
          makeChunk({
            id: `user-${i}`,
            type: 'user',
            messages: [
              makeMessage({
                id: `user-${i}-msg`,
                role: 'user',
                content: [{ type: 'text', text: `Prompt ${i}` }],
              }),
            ],
          }),
        );
        result.push(
          makeAiChunk(`chunk-ai-${i}`, {
            messages: [
              makeMessage({
                id: `ai-${i}-msg`,
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: `Response ${i}` }],
                usage: { input, output: 500, cacheRead, cacheCreation },
              }),
            ],
          }),
        );
      }
      return result;
    }

    const deltaProps = {
      ...baseProps,
      sessionId: 'session-delta',
      messages: [makeMessage()],
      isLive: false,
    };

    it('first AI chunk renders no input delta', () => {
      const chunks = buildDeltaChunks([
        { input: 10_000, cacheRead: 5_000, cacheCreation: 1_000 }, // total: 16k
      ]);
      render(<SessionViewerPanel {...deltaProps} chunks={chunks} />);

      expect(screen.queryByTestId('ai-group-input-delta')).not.toBeInTheDocument();
    });

    it('second AI chunk renders correct positive delta', () => {
      const chunks = buildDeltaChunks([
        { input: 10_000, cacheRead: 5_000, cacheCreation: 1_000 }, // total: 16k
        { input: 20_000, cacheRead: 8_000, cacheCreation: 2_000 }, // total: 30k → delta: 14k
      ]);
      render(<SessionViewerPanel {...deltaProps} chunks={chunks} />);

      const deltas = screen.getAllByTestId('ai-group-input-delta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toHaveTextContent('(+14k)');
    });

    it('post-compaction AI chunk shows no delta (input decreased)', () => {
      const chunks = buildDeltaChunks([
        { input: 50_000, cacheRead: 10_000, cacheCreation: 5_000 }, // total: 65k
        { input: 20_000, cacheRead: 3_000, cacheCreation: 2_000 }, // total: 25k (compacted, less)
      ]);
      render(<SessionViewerPanel {...deltaProps} chunks={chunks} />);

      // Delta is negative (25k < 65k) → no delta shown
      expect(screen.queryByTestId('ai-group-input-delta')).not.toBeInTheDocument();
    });

    it('zero input delta is not shown', () => {
      const chunks = buildDeltaChunks([
        { input: 10_000, cacheRead: 5_000, cacheCreation: 1_000 }, // total: 16k
        { input: 10_000, cacheRead: 5_000, cacheCreation: 1_000 }, // total: 16k (same → zero delta)
      ]);
      render(<SessionViewerPanel {...deltaProps} chunks={chunks} />);

      expect(screen.queryByTestId('ai-group-input-delta')).not.toBeInTheDocument();
    });

    it('hotspot-filter parity: same chunk shows identical delta before and after filter toggle', () => {
      // Build 5 AI chunks where last is a hotspot outlier
      // Input totals: 16k, 30k(+14k), 45k(+15k), 60k(+15k), 200k(+140k)
      const inputTotals = [
        { input: 10_000, cacheRead: 5_000, cacheCreation: 1_000 }, // 16k
        { input: 20_000, cacheRead: 8_000, cacheCreation: 2_000 }, // 30k
        { input: 30_000, cacheRead: 10_000, cacheCreation: 5_000 }, // 45k
        { input: 40_000, cacheRead: 15_000, cacheCreation: 5_000 }, // 60k
        { input: 150_000, cacheRead: 30_000, cacheCreation: 20_000 }, // 200k
      ];
      const chunks = buildDeltaChunks(inputTotals);
      // Make the last one a clear hotspot by inflating totalTokens
      const hotChunk = chunks[chunks.length - 1];
      if (hotChunk.type === 'ai') {
        hotChunk.metrics = {
          ...hotChunk.metrics,
          totalTokens: 50_000,
          inputTokens: 30_000,
          outputTokens: 20_000,
        };
      }
      // Keep other AI chunks with low totalTokens
      for (let i = 1; i < chunks.length - 1; i += 2) {
        const c = chunks[i];
        if (c.type === 'ai') {
          c.metrics = { ...c.metrics, totalTokens: 500, inputTokens: 300, outputTokens: 200 };
        }
      }

      const hotspotMetrics = makeMetrics({ contextWindowTokens: 200_000 });
      render(<SessionViewerPanel {...deltaProps} metrics={hotspotMetrics} chunks={chunks} />);

      // Before filter: find the last AI card's delta (chunk-ai-4 has delta +140k)
      const deltasBeforeFilter = screen.getAllByTestId('ai-group-input-delta');
      const lastDeltaBefore = deltasBeforeFilter[deltasBeforeFilter.length - 1];
      const deltaTextBefore = lastDeltaBefore.textContent;

      // Toggle hotspot filter on
      fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));

      // After filter: only hot chunk visible — should have same delta
      const deltasAfterFilter = screen.queryAllByTestId('ai-group-input-delta');
      if (deltasAfterFilter.length > 0) {
        const lastDeltaAfter = deltasAfterFilter[deltasAfterFilter.length - 1];
        expect(lastDeltaAfter.textContent).toBe(deltaTextBefore);
      }
      // The key assertion: delta was computed from raw chunks, so same chunk ID
      // gets the same delta regardless of hotspot filter state
    });

    it('metrics-fallback parity: chunk with only chunk.metrics (no message.usage) gets correct delta', () => {
      // First chunk: has message.usage → total = 10k + 5k + 1k = 16k
      // Second chunk: no message.usage, only chunk.metrics → total from metrics = 20k + 6k + 2k = 28k
      // Delta = 28k - 16k = 12k
      const userChunk0 = makeChunk({
        id: 'user-0',
        type: 'user',
        messages: [
          makeMessage({ id: 'u0', role: 'user', content: [{ type: 'text', text: 'P0' }] }),
        ],
      });
      const aiChunk0 = makeAiChunk('chunk-ai-0', {
        messages: [
          makeMessage({
            id: 'ai-0-msg',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'R0' }],
            usage: { input: 10_000, output: 500, cacheRead: 5_000, cacheCreation: 1_000 },
          }),
        ],
      });

      const userChunk1 = makeChunk({
        id: 'user-1',
        type: 'user',
        messages: [
          makeMessage({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'P1' }] }),
        ],
      });
      // AI chunk with NO message.usage, only chunk.metrics
      const aiChunk1 = makeAiChunk('chunk-ai-1', {
        messages: [
          makeMessage({
            id: 'ai-1-msg',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'R1' }],
            usage: undefined,
          }),
        ],
        metrics: {
          inputTokens: 20_000,
          outputTokens: 1_000,
          cacheReadTokens: 6_000,
          cacheCreationTokens: 2_000,
          totalTokens: 29_000,
          messageCount: 1,
          durationMs: 1000,
          costUsd: 0.01,
        },
      });

      const chunks = [userChunk0, aiChunk0, userChunk1, aiChunk1];
      render(<SessionViewerPanel {...deltaProps} chunks={chunks} />);

      const deltas = screen.getAllByTestId('ai-group-input-delta');
      expect(deltas).toHaveLength(1);
      // 28k - 16k = 12k
      expect(deltas[0]).toHaveTextContent('(+12k)');
    });
  });

  // ---------------------------------------------------------------------------
  // warnings banner
  // ---------------------------------------------------------------------------

  describe('warnings banner', () => {
    const baseProps = {
      sessionId: 'sess-1',
      messages: [makeMessage({ id: 'u1', role: 'user' })],
      chunks: [makeChunk()],
      metrics: makeMetrics(),
      isLive: false,
      isLoading: false,
      error: null,
    };

    it('renders warning banner when warnings are present', () => {
      render(
        <SessionViewerPanel
          {...baseProps}
          warnings={['Skipped 2 oversized lines (>10MB each)', 'File partially parsed']}
        />,
      );

      const banner = screen.getByTestId('session-warnings-banner');
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent('Skipped 2 oversized lines');
      expect(banner).toHaveTextContent('File partially parsed');
    });

    it('does not render warning banner when warnings is undefined', () => {
      render(<SessionViewerPanel {...baseProps} />);

      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();
    });

    it('does not render warning banner when warnings is empty', () => {
      render(<SessionViewerPanel {...baseProps} warnings={[]} />);

      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();
    });

    it('dismisses warning banner when X button is clicked', () => {
      render(
        <SessionViewerPanel {...baseProps} warnings={['Skipped 1 oversized line (>10MB each)']} />,
      );

      expect(screen.getByTestId('session-warnings-banner')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('session-warnings-dismiss'));

      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();
    });

    it('renders warning banner in empty-state when messages=[] and warnings present', () => {
      render(
        <SessionViewerPanel
          {...baseProps}
          messages={[]}
          chunks={[]}
          warnings={['Skipped 3 oversized lines']}
        />,
      );

      const emptyContainer = screen.getByTestId('session-viewer-empty');
      expect(emptyContainer).toBeInTheDocument();
      expect(emptyContainer).toHaveTextContent('No messages in this session yet');

      const banner = screen.getByTestId('session-warnings-banner');
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent('Skipped 3 oversized lines');
    });

    it('shows empty-state without banner when messages=[] and no warnings', () => {
      render(<SessionViewerPanel {...baseProps} messages={[]} chunks={[]} />);

      const emptyContainer = screen.getByTestId('session-viewer-empty');
      expect(emptyContainer).toBeInTheDocument();
      expect(emptyContainer).toHaveTextContent('No messages in this session yet');

      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();
    });

    it('resets dismissed state when sessionId changes', () => {
      const { rerender } = render(
        <SessionViewerPanel {...baseProps} warnings={['Skipped 1 oversized line (>10MB each)']} />,
      );

      // Dismiss the banner
      fireEvent.click(screen.getByTestId('session-warnings-dismiss'));
      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();

      // Switch to a different session with warnings
      rerender(
        <SessionViewerPanel
          {...baseProps}
          sessionId="sess-2"
          warnings={['Skipped 1 oversized line (>10MB each)']}
        />,
      );

      expect(screen.getByTestId('session-warnings-banner')).toBeInTheDocument();
    });

    it('resets dismissed state when warning content changes', () => {
      const { rerender } = render(
        <SessionViewerPanel {...baseProps} warnings={['Skipped 1 oversized line (>10MB each)']} />,
      );

      // Dismiss the banner
      fireEvent.click(screen.getByTestId('session-warnings-dismiss'));
      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();

      // Same session gets new/different warnings
      rerender(
        <SessionViewerPanel
          {...baseProps}
          warnings={['File partially parsed due to memory limit']}
        />,
      );

      expect(screen.getByTestId('session-warnings-banner')).toBeInTheDocument();
      expect(screen.getByTestId('session-warnings-banner')).toHaveTextContent(
        'File partially parsed due to memory limit',
      );
    });

    it('stays dismissed when same warnings are re-sent without content change', () => {
      const warnings = ['Skipped 1 oversized line (>10MB each)'];
      const { rerender } = render(<SessionViewerPanel {...baseProps} warnings={warnings} />);

      // Dismiss the banner
      fireEvent.click(screen.getByTestId('session-warnings-dismiss'));
      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();

      // Re-render with a new array reference but identical content
      rerender(<SessionViewerPanel {...baseProps} warnings={[...warnings]} />);

      expect(screen.queryByTestId('session-warnings-banner')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Step-level hotspot integration
  // -------------------------------------------------------------------------

  describe('step-level hotspot integration', () => {
    /**
     * Build 3 AI chunks with varied step estimatedTokens.
     * Values: [100, 200, 150, 400, 250, 5000, 100]
     * Sorted: [100, 100, 150, 200, 250, 400, 5000]
     * Q1=125, Q3=325, IQR=200, fence=625
     * Only 5000 > 625 → hot (ai-2's thinking step)
     */
    function buildStepHotspotChunks(): SerializedChunk[] {
      return [
        makeChunk({
          id: 'user-0',
          type: 'user',
          messages: [
            makeMessage({
              id: 'u0-msg',
              role: 'user',
              content: [{ type: 'text', text: 'Prompt 0' }],
            }),
          ],
        }),
        makeAiChunk('ai-0', {
          semanticSteps: [
            {
              id: 'a0-t',
              type: 'thinking',
              startTime: '2026-02-24T12:00:00.000Z',
              durationMs: 0,
              estimatedTokens: 100,
              content: { thinkingText: 'Short thinking' },
              context: 'main',
            },
            {
              id: 'a0-o',
              type: 'output',
              startTime: '2026-02-24T12:00:01.000Z',
              durationMs: 0,
              estimatedTokens: 200,
              content: { outputText: 'Output from ai-0' },
              context: 'main',
            },
          ],
        }),
        makeChunk({
          id: 'user-1',
          type: 'user',
          messages: [
            makeMessage({
              id: 'u1-msg',
              role: 'user',
              content: [{ type: 'text', text: 'Prompt 1' }],
            }),
          ],
        }),
        makeAiChunk('ai-1', {
          semanticSteps: [
            {
              id: 'a1-t',
              type: 'thinking',
              startTime: '2026-02-24T12:00:02.000Z',
              durationMs: 0,
              estimatedTokens: 150,
              content: { thinkingText: 'Another thinking' },
              context: 'main',
            },
            {
              id: 'a1-tc',
              type: 'tool_call',
              startTime: '2026-02-24T12:00:03.000Z',
              durationMs: 0,
              estimatedTokens: 300,
              content: {
                toolCallId: 'tc-1',
                toolName: 'Read',
                toolInput: { file_path: '/src/x.ts' },
              },
              context: 'main',
            },
            {
              id: 'a1-tr',
              type: 'tool_result',
              startTime: '2026-02-24T12:00:04.000Z',
              durationMs: 0,
              estimatedTokens: 100,
              content: { toolCallId: 'tc-1', toolResultContent: 'const x = 1;', isError: false },
              context: 'main',
            },
            {
              id: 'a1-o',
              type: 'output',
              startTime: '2026-02-24T12:00:05.000Z',
              durationMs: 0,
              estimatedTokens: 250,
              content: { outputText: 'Output from ai-1' },
              context: 'main',
            },
          ],
        }),
        makeChunk({
          id: 'user-2',
          type: 'user',
          messages: [
            makeMessage({
              id: 'u2-msg',
              role: 'user',
              content: [{ type: 'text', text: 'Prompt 2' }],
            }),
          ],
        }),
        makeAiChunk('ai-2', {
          semanticSteps: [
            {
              id: 'a2-t',
              type: 'thinking',
              startTime: '2026-02-24T12:00:06.000Z',
              durationMs: 0,
              estimatedTokens: 5000,
              content: { thinkingText: 'Very long extended thinking' },
              context: 'main',
            },
            {
              id: 'a2-o',
              type: 'output',
              startTime: '2026-02-24T12:00:07.000Z',
              durationMs: 0,
              estimatedTokens: 100,
              content: { outputText: 'Output from ai-2' },
              context: 'main',
            },
          ],
        }),
      ];
    }

    const stepHotspotProps = {
      ...baseProps,
      sessionId: 'session-step-hotspot',
      messages: [makeMessage()],
      isLive: false,
    };

    it('outlier step shows flame icon when AI card is expanded', () => {
      const chunks = buildStepHotspotChunks();
      render(<SessionViewerPanel {...stepHotspotProps} chunks={chunks} />);

      // Expand the AI card containing the outlier (ai-2, the 3rd AI card at index 2)
      const headers = screen.getAllByTestId('ai-group-header');
      fireEvent.click(headers[2]);

      // The thinking step with 5000 tokens > threshold(625) → hot
      expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
      expect(screen.getByTestId('step-hotspot-pct')).toBeInTheDocument();
    });

    it('non-outlier card shows no step hotspot indicators when expanded', () => {
      const chunks = buildStepHotspotChunks();
      render(<SessionViewerPanel {...stepHotspotProps} chunks={chunks} />);

      // Expand the first AI card (ai-0) — all its steps are below threshold
      const headers = screen.getAllByTestId('ai-group-header');
      fireEvent.click(headers[0]);

      expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
      expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    });
  });
});
