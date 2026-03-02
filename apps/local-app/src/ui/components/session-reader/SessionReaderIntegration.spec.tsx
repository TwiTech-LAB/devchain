import React, { useState } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import {
  useSessionTranscript,
  type SerializedSession,
  type TranscriptSummary,
} from '@/ui/hooks/useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { InlineSessionSummaryChip } from './InlineSessionSummaryChip';
import { SessionViewerPanel } from './SessionViewerPanel';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSocket(): Socket {
  return {
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  } as unknown as Socket;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

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
    messageCount: 2,
    isOngoing: true,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SerializedSession> = {}): SerializedSession {
  return {
    id: 'session-1',
    providerName: 'claude-code',
    filePath: '/tmp/session.jsonl',
    messages: [
      {
        id: 'msg-1',
        parentId: null,
        role: 'user',
        timestamp: '2026-02-24T10:00:00.000Z',
        content: [{ type: 'text', text: 'Hello agent' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
      {
        id: 'msg-2',
        parentId: 'msg-1',
        role: 'assistant',
        timestamp: '2026-02-24T10:00:05.000Z',
        content: [{ type: 'text', text: 'Hello! How can I help?' }],
        model: 'claude-sonnet-4-6',
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      },
    ],
    metrics: makeMetrics(),
    isOngoing: true,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    sessionId: 'session-1',
    providerName: 'claude-code',
    metrics: makeMetrics(),
    messageCount: 2,
    isOngoing: true,
    ...overrides,
  };
}

/** Extract the WS message handler passed to useAppSocket */
function captureWsHandler(): (envelope: WsEnvelope) => void {
  const handlers = useAppSocketMock.mock.calls[0]?.[0];
  if (!handlers?.message) throw new Error('useAppSocket not called or no message handler');
  return handlers.message as (envelope: WsEnvelope) => void;
}

// ---------------------------------------------------------------------------
// Integration harness — uses real useSessionTranscript + real components
// ---------------------------------------------------------------------------

function IntegrationHarness({ sessionId }: { sessionId: string | null }) {
  const { messages, chunks, metrics, isLive, isLoading, error } = useSessionTranscript(sessionId);
  const [activeTab, setActiveTab] = useState<'terminal' | 'session'>('session');

  return (
    <div>
      {/* Chip */}
      {metrics && (
        <InlineSessionSummaryChip
          metrics={metrics}
          activeTab={activeTab}
          onSwitchToSession={() => setActiveTab('session')}
        />
      )}

      {/* Tab switch controls */}
      <button data-testid="switch-terminal" onClick={() => setActiveTab('terminal')}>
        Terminal
      </button>
      <button data-testid="switch-session" onClick={() => setActiveTab('session')}>
        Session
      </button>
      <span data-testid="active-tab">{activeTab}</span>

      {/* Panel (only visible on session tab) */}
      {activeTab === 'session' && (
        <SessionViewerPanel
          sessionId={sessionId}
          messages={messages}
          chunks={chunks}
          metrics={metrics}
          isLive={isLive}
          isLoading={isLoading}
          error={error}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Reader Integration', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = createQueryClient();
    useAppSocketMock.mockReturnValue(createMockSocket());
  });

  afterEach(() => {
    queryClient.clear();
  });

  function renderHarness(sessionId: string | null = 'session-1') {
    return render(
      <QueryClientProvider client={queryClient}>
        <IntegrationHarness sessionId={sessionId} />
      </QueryClientProvider>,
    );
  }

  // -------------------------------------------------------------------------
  // Full data flow: hook → chip + panel
  // -------------------------------------------------------------------------

  it('loads session data and renders chip + panel with metrics and messages', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(summary);
      if (url.includes('/transcript')) return Promise.resolve(session);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Chip shows metrics
    const chip = screen.getByRole('button', { name: /tokens/i });
    expect(chip).toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');

    // Panel shows messages
    expect(screen.getByTestId('user-message-card')).toBeInTheDocument();
    expect(screen.getByTestId('ai-message-card')).toBeInTheDocument();
    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument();

    // Metrics header in panel
    expect(screen.getByTestId('session-metrics-header')).toBeInTheDocument();
  });

  it('shows loading state then transitions to loaded', async () => {
    let resolveTranscript: (v: SerializedSession) => void;
    const transcriptPromise = new Promise<SerializedSession>((r) => {
      resolveTranscript = r;
    });

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(makeSummary());
      if (url.includes('/transcript')) return transcriptPromise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    // Should show loading initially
    expect(screen.getByTestId('session-viewer-loading')).toBeInTheDocument();

    // Resolve the transcript
    await act(async () => {
      resolveTranscript!(makeSession());
    });

    // Should now show messages
    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('session-viewer-loading')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Live update via WebSocket
  // -------------------------------------------------------------------------

  it('updates UI when WS "updated" event triggers re-fetch with new data', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(summary);
      if (url.includes('/transcript')) return Promise.resolve(session);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Now update the mock to return new data with an additional message
    const updatedSession = makeSession({
      messages: [
        ...session.messages,
        {
          id: 'msg-3',
          parentId: 'msg-2',
          role: 'user',
          timestamp: '2026-02-24T10:00:10.000Z',
          content: [{ type: 'text', text: 'Please fix the bug' }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
        },
      ],
      metrics: makeMetrics({ totalTokens: 5000, costUsd: 0.07, messageCount: 3 }),
    });
    const updatedSummary = makeSummary({
      metrics: makeMetrics({ totalTokens: 5000, costUsd: 0.07, messageCount: 3 }),
      messageCount: 3,
    });

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(updatedSummary);
      if (url.includes('/transcript')) return Promise.resolve(updatedSession);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    // Simulate WS event
    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        payload: { sessionId: 'session-1', newMessageCount: 3, metrics: {} },
        ts: new Date().toISOString(),
      });
    });

    // Wait for new message to appear
    await waitFor(() => {
      expect(screen.getByText('Please fix the bug')).toBeInTheDocument();
    });

    // Chip should reflect updated metrics
    const chip = screen.getByRole('button', { name: /tokens/i });
    expect(chip).toHaveTextContent('5.0k');
    expect(chip).toHaveTextContent('$0.07');
  });

  // -------------------------------------------------------------------------
  // Live indicator
  // -------------------------------------------------------------------------

  it('shows live indicator for ongoing sessions', async () => {
    const session = makeSession({ isOngoing: true });
    const summary = makeSummary({ isOngoing: true });

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(summary);
      if (url.includes('/transcript')) return Promise.resolve(session);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    // Live indicator visible
    await waitFor(() => {
      expect(screen.getByTestId('metrics-live')).toHaveTextContent('Live');
    });

    // Chip should have pulsing dot
    const chip = screen.getByRole('button', { name: /ongoing/i });
    expect(chip.querySelector('span.animate-pulse')).toBeTruthy();
  });

  it('hides live indicator for completed sessions', async () => {
    const session = makeSession({
      isOngoing: false,
      metrics: makeMetrics({ isOngoing: false }),
    });
    const summary = makeSummary({
      isOngoing: false,
      metrics: makeMetrics({ isOngoing: false }),
    });

    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(summary);
      if (url.includes('/transcript')) return Promise.resolve(session);
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Live indicator should not be present
    expect(screen.queryByTestId('metrics-live')).not.toBeInTheDocument();

    // Chip should have static dot (not pulsing)
    const chip = screen.getByRole('button', { name: /tokens/i });
    expect(chip.querySelector('span.animate-pulse')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tab switching
  // -------------------------------------------------------------------------

  it('hides panel when switching to terminal tab and restores on session tab', async () => {
    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(makeSummary());
      if (url.includes('/transcript')) return Promise.resolve(makeSession());
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Panel visible on session tab
    expect(screen.getByTestId('session-viewer-panel')).toBeInTheDocument();

    // Switch to terminal tab
    fireEvent.click(screen.getByTestId('switch-terminal'));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('terminal');

    // Panel should be hidden (not rendered)
    expect(screen.queryByTestId('session-viewer-panel')).not.toBeInTheDocument();

    // Switch back to session tab
    fireEvent.click(screen.getByTestId('switch-session'));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('session');

    // Panel should be visible again with data preserved
    await waitFor(() => {
      expect(screen.getByTestId('session-viewer-panel')).toBeInTheDocument();
    });
    expect(screen.getByText('Hello agent')).toBeInTheDocument();
  });

  it('chip click switches from terminal to session tab', async () => {
    fetchJsonOrThrowMock.mockImplementation((url: string) => {
      if (url.includes('/transcript/summary')) return Promise.resolve(makeSummary());
      if (url.includes('/transcript')) return Promise.resolve(makeSession());
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    renderHarness();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /tokens/i })).toBeInTheDocument();
    });

    // Switch to terminal tab first
    fireEvent.click(screen.getByTestId('switch-terminal'));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('terminal');

    // Click chip to switch back to session
    fireEvent.click(screen.getByRole('button', { name: /tokens/i }));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('session');
  });

  // -------------------------------------------------------------------------
  // Error flow
  // -------------------------------------------------------------------------

  it('shows error in panel when fetch fails', async () => {
    fetchJsonOrThrowMock.mockRejectedValue(new Error('Server error'));

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load session: Server error/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Null session (disabled)
  // -------------------------------------------------------------------------

  it('shows empty state when sessionId is null', () => {
    renderHarness(null);

    expect(screen.getByTestId('session-viewer-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tokens/i })).not.toBeInTheDocument();
  });
});
