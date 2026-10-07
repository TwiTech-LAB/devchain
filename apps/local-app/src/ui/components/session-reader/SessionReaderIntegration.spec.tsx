/**
 * Integration harness for the summary-only session transcript flow.
 *
 * Real `useSessionTranscript` (summary + WS invalidation) wired to the summary
 * chip and the paged session panel, with the network boundary mocked. The paged
 * body pipeline itself (index extension, chunk paging) is covered by
 * PagedSessionMessageList.spec.tsx; this file proves the live-metrics contract.
 */
import React, { useState } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { useSessionTranscript, type TranscriptSummary } from '@/ui/hooks/useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchTranscriptIndex } from '@/ui/lib/sessions';
import type { TranscriptIndex } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { InlineSessionSummaryChip, DEFAULT_CHIP_VISIBLE_ITEMS } from './InlineSessionSummaryChip';
import { SessionViewerPanel } from './SessionViewerPanel';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchTranscriptIndex: jest.fn(),
  fetchTranscriptChunks: jest.fn(),
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: jest.fn((options: { count: number }) => ({
    getVirtualItems: () => {
      if (options.count === 0) return [];
      return Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 120,
        size: 120,
        key: index,
        lane: 0,
        end: 120,
      }));
    },
    getTotalSize: () => options.count * 120,
    measureElement: jest.fn(),
    isScrolling: false,
  })),
}));

jest.mock('@/ui/hooks/useAutoScrollBottom', () => ({
  useAutoScrollBottom: () => ({
    scrollContainerRef: { current: null },
    bottomRef: { current: null },
    handleScroll: jest.fn(),
  }),
}));

jest.mock('./SessionNavigationToolbar', () => ({
  SessionNavigationToolbar: () => null,
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchTranscriptIndexMock = fetchTranscriptIndex as jest.MockedFunction<
  typeof fetchTranscriptIndex
>;

const fetchMock = jest.fn<Promise<Response>, [string | URL | Request, RequestInit?]>();

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

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

function makePagedIndex(): TranscriptIndex {
  const messages = [
    {
      id: 'msg-1',
      parentId: null,
      role: 'user' as const,
      timestamp: '2026-02-24T10:00:00.000Z',
      content: [{ type: 'text' as const, text: 'Hello agent' }],
      toolCalls: [],
      toolResults: [],
      isMeta: false,
      isSidechain: false,
    },
    {
      id: 'msg-2',
      parentId: 'msg-1',
      role: 'assistant' as const,
      timestamp: '2026-02-24T10:00:05.000Z',
      content: [{ type: 'text' as const, text: 'Hello! How can I help?' }],
      model: 'claude-sonnet-4-6',
      toolCalls: [],
      toolResults: [],
      isMeta: false,
      isSidechain: false,
    },
  ];
  const chunks = [
    {
      id: 'chunk-user',
      type: 'user' as const,
      startTime: '2026-02-24T10:00:00.000Z',
      endTime: '2026-02-24T10:00:00.000Z',
      messages: [messages[0]],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        messageCount: 1,
        durationMs: 0,
        costUsd: 0,
      },
    },
    {
      id: 'chunk-ai',
      type: 'ai' as const,
      startTime: '2026-02-24T10:00:05.000Z',
      endTime: '2026-02-24T10:00:05.000Z',
      messages: [messages[1]],
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
    },
  ];
  return {
    cursor: 'index-cursor',
    totals: { messageCount: messages.length, chunkCount: chunks.length },
    chunkIds: chunks.map((chunk) => chunk.id),
    latestOutputPreview: null,
    providerName: 'claude-code',
    isOngoing: true,
    pages: [
      {
        cursor: chunks[0].id,
        size: chunks.length,
        response: {
          chunks,
          nextCursor: null,
          prevCursor: null,
          totalCount: chunks.length,
        },
      },
    ],
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
  const { metrics, isLive } = useSessionTranscript(sessionId);
  const [activeTab, setActiveTab] = useState<'terminal' | 'session'>('session');

  return (
    <div>
      {/* Chip */}
      {metrics && (
        <InlineSessionSummaryChip
          metrics={metrics}
          visibleItems={DEFAULT_CHIP_VISIBLE_ITEMS}
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
        <SessionViewerPanel sessionId={sessionId} metrics={metrics} isLive={isLive} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Reader Integration', () => {
  let queryClient: QueryClient;

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = createQueryClient();
    useAppSocketMock.mockReturnValue(createMockSocket());
    fetchTranscriptIndexMock.mockResolvedValue(makePagedIndex());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    queryClient.clear();
    global.fetch = originalFetch;
  });

  function setupSummary(summary: TranscriptSummary) {
    fetchMock.mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/transcript/summary')) {
        return Promise.resolve(mockResponse(summary));
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
    });
  }

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

  it('loads summary metrics and renders chip + paged panel', async () => {
    setupSummary(makeSummary());

    renderHarness();

    // Panel shows messages through the paged pipeline
    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });
    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument();
    expect(screen.getByTestId('session-viewer-panel-paged')).toBeInTheDocument();

    // Metrics header in panel
    expect(screen.getByTestId('session-metrics-header')).toBeInTheDocument();

    // Chip shows metrics
    const chip = screen.getByRole('button', { name: /tokens/i });
    expect(chip).toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');
  });

  // -------------------------------------------------------------------------
  // Live update via WebSocket
  // -------------------------------------------------------------------------

  it('updates the summary chip when a WS "updated" event triggers a summary re-fetch', async () => {
    setupSummary(makeSummary());

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    const updatedSummary = makeSummary({
      metrics: makeMetrics({ totalTokens: 5000, costUsd: 0.07, messageCount: 3 }),
      messageCount: 3,
    });
    setupSummary(updatedSummary);

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

    // Chip should reflect updated metrics
    await waitFor(() => {
      const chip = screen.getByRole('button', { name: /tokens/i });
      expect(chip).toHaveTextContent('5.0k');
      expect(chip).toHaveTextContent('$0.07');
    });
  });

  // -------------------------------------------------------------------------
  // Live indicator
  // -------------------------------------------------------------------------

  it('shows live indicator for ongoing sessions', async () => {
    setupSummary(makeSummary({ isOngoing: true }));

    renderHarness();

    // Live indicator visible
    await waitFor(() => {
      expect(screen.getByTestId('metrics-live')).toHaveTextContent('Live');
    });

    // Chip should have pulsing dot
    const chip = screen.getByRole('button', { name: /ongoing/i });
    expect(chip.querySelector('span.animate-pulse')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Tab switching
  // -------------------------------------------------------------------------

  it('hides panel when switching to terminal tab and restores on session tab', async () => {
    setupSummary(makeSummary());

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    // Panel visible on session tab
    expect(screen.getByTestId('session-viewer-panel-paged')).toBeInTheDocument();

    // Switch to terminal tab
    fireEvent.click(screen.getByTestId('switch-terminal'));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('terminal');

    // Panel should be hidden (not rendered)
    expect(screen.queryByTestId('session-viewer-panel-paged')).not.toBeInTheDocument();

    // Switch back to session tab
    fireEvent.click(screen.getByTestId('switch-session'));
    expect(screen.getByTestId('active-tab')).toHaveTextContent('session');

    // Panel should be visible again with data preserved
    await waitFor(() => {
      expect(screen.getByTestId('session-viewer-panel-paged')).toBeInTheDocument();
    });
    expect(screen.getByText('Hello agent')).toBeInTheDocument();
  });

  it('chip click switches from terminal to session tab', async () => {
    setupSummary(makeSummary());

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
  // Summary failure (non-fatal — panel keeps its own paged data)
  // -------------------------------------------------------------------------

  it('hides the chip but keeps the paged panel working when the summary fetch fails', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(mockResponse({ message: 'Server error' }, 500)),
    );

    renderHarness();

    await waitFor(() => {
      expect(screen.getByText('Hello agent')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /tokens/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('session-viewer-panel-paged')).toBeInTheDocument();
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
