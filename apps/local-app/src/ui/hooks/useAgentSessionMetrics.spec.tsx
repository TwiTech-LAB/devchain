import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAgentSessionMetrics, getMetricsKey } from './useAgentSessionMetrics';
import type { AgentSessionEntry } from './useAgentSessionMetrics';
import { fetchTranscriptSummary } from '@/ui/lib/sessions';

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchTranscriptSummary: jest.fn(),
}));

const fetchMock = fetchTranscriptSummary as jest.MockedFunction<typeof fetchTranscriptSummary>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeSummary(overrides?: {
  totalContextTokens?: number;
  contextWindowTokens?: number;
  isOngoing?: boolean;
  sessionId?: string;
}) {
  return {
    sessionId: overrides?.sessionId ?? 'test-session',
    providerName: 'claude',
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalContextConsumption: 0,
      compactionCount: 0,
      phaseBreakdowns: [],
      visibleContextTokens: 0,
      totalContextTokens: overrides?.totalContextTokens ?? 50_000,
      contextWindowTokens: overrides?.contextWindowTokens ?? 200_000,
      costUsd: 0,
    },
    messageCount: 5,
    isOngoing: overrides?.isOngoing ?? true,
  } as Awaited<ReturnType<typeof fetchTranscriptSummary>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAgentSessionMetrics', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns empty map when no entries', () => {
    const { result } = renderHook(() => useAgentSessionMetrics([]), {
      wrapper: createWrapper(),
    });
    expect(result.current.size).toBe(0);
  });

  it('returns correct metrics for local agents with sessions', async () => {
    fetchMock.mockResolvedValue(
      makeSummary({ totalContextTokens: 100_000, contextWindowTokens: 200_000 }),
    );

    const entries: AgentSessionEntry[] = [{ agentId: 'agent-1', sessionId: 'session-1' }];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });

    const metrics = result.current.get('agent-1');
    expect(metrics).toBeDefined();
    expect(metrics!.contextPercent).toBe(50);
    expect(metrics!.totalContextTokens).toBe(100_000);
    expect(metrics!.contextWindowTokens).toBe(200_000);
  });

  it('handles mixed local + worktree entries with different apiBase values', async () => {
    fetchMock.mockImplementation(async (_sessionId: string, apiBase?: string) => {
      if (apiBase) {
        return makeSummary({ totalContextTokens: 160_000, contextWindowTokens: 200_000 });
      }
      return makeSummary({ totalContextTokens: 40_000, contextWindowTokens: 200_000 });
    });

    const entries: AgentSessionEntry[] = [
      { agentId: 'agent-1', sessionId: 'session-1' },
      { agentId: 'agent-wt-1', sessionId: 'session-wt-1', apiBase: '/wt/feature-auth' },
    ];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    const local = result.current.get('agent-1');
    expect(local!.contextPercent).toBe(20);

    const worktree = result.current.get('/wt/feature-auth:agent-wt-1');
    expect(worktree!.contextPercent).toBe(80);
  });

  it('namespaced lookup keys — same agentId in different worktrees get distinct entries', async () => {
    fetchMock.mockImplementation(async (_sessionId: string, apiBase?: string) => {
      if (apiBase === '/wt/alpha') {
        return makeSummary({ totalContextTokens: 50_000, contextWindowTokens: 200_000 });
      }
      return makeSummary({ totalContextTokens: 150_000, contextWindowTokens: 200_000 });
    });

    const entries: AgentSessionEntry[] = [
      { agentId: 'shared-agent', sessionId: 'session-a', apiBase: '/wt/alpha' },
      { agentId: 'shared-agent', sessionId: 'session-b', apiBase: '/wt/beta' },
    ];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    expect(result.current.has('/wt/alpha:shared-agent')).toBe(true);
    expect(result.current.has('/wt/beta:shared-agent')).toBe(true);
    expect(result.current.get('/wt/alpha:shared-agent')!.contextPercent).toBe(25);
    expect(result.current.get('/wt/beta:shared-agent')!.contextPercent).toBe(75);
  });

  it('gracefully omits entries when summary fetch returns 404', async () => {
    fetchMock.mockRejectedValue(new Error('Not found'));

    const entries: AgentSessionEntry[] = [{ agentId: 'agent-1', sessionId: 'session-1' }];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    // Query fails → no metrics in the map
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.size).toBe(0);
  });

  it('skips entries where contextWindowTokens is 0', async () => {
    fetchMock.mockResolvedValue(makeSummary({ totalContextTokens: 100, contextWindowTokens: 0 }));

    const entries: AgentSessionEntry[] = [{ agentId: 'agent-1', sessionId: 'session-1' }];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.size).toBe(0);
  });

  it('dedup — same sessionId from same apiBase does not create duplicate queries', async () => {
    fetchMock.mockResolvedValue(
      makeSummary({ totalContextTokens: 100_000, contextWindowTokens: 200_000 }),
    );

    const entries: AgentSessionEntry[] = [
      { agentId: 'agent-1', sessionId: 'session-1' },
      { agentId: 'agent-2', sessionId: 'session-1' }, // same sessionId → same query key
    ];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    // React Query dedupes by query key — only one fetch for same sessionId
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polling stops when isOngoing === false', async () => {
    fetchMock.mockResolvedValue(makeSummary({ isOngoing: false }));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const entries: AgentSessionEntry[] = [{ agentId: 'agent-1', sessionId: 'session-1' }];

    renderHook(() => useAgentSessionMetrics(entries), { wrapper });

    await waitFor(() => {
      const state = queryClient.getQueryState(['transcript-summary', 'session-1']);
      expect(state?.data).toBeDefined();
    });

    // After query resolves with isOngoing: false, no further fetches should occur
    fetchMock.mockClear();
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('excludes zero-percent entries from map (spacer leak regression)', async () => {
    fetchMock.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session-zero') {
        return makeSummary({ totalContextTokens: 0, contextWindowTokens: 200_000 });
      }
      return makeSummary({ totalContextTokens: 100_000, contextWindowTokens: 200_000 });
    });

    const entries: AgentSessionEntry[] = [
      { agentId: 'agent-zero', sessionId: 'session-zero' },
      { agentId: 'agent-active', sessionId: 'session-active' },
    ];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });

    // Zero-usage agent excluded — prevents empty wrapper div in ChatSidebar
    expect(result.current.has('agent-zero')).toBe(false);
    expect(result.current.has('agent-active')).toBe(true);
    expect(result.current.get('agent-active')!.contextPercent).toBe(50);
  });

  it('includes all non-zero entries with correct contextPercent', async () => {
    fetchMock.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session-low') {
        return makeSummary({ totalContextTokens: 20_000, contextWindowTokens: 200_000 });
      }
      return makeSummary({ totalContextTokens: 180_000, contextWindowTokens: 200_000 });
    });

    const entries: AgentSessionEntry[] = [
      { agentId: 'agent-low', sessionId: 'session-low' },
      { agentId: 'agent-high', sessionId: 'session-high' },
    ];

    const { result } = renderHook(() => useAgentSessionMetrics(entries), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    expect(result.current.get('agent-low')!.contextPercent).toBe(10);
    expect(result.current.get('agent-high')!.contextPercent).toBe(90);
  });
});

describe('getMetricsKey', () => {
  it('returns agentId for local agents', () => {
    expect(getMetricsKey('agent-1')).toBe('agent-1');
  });

  it('returns namespaced key for worktree agents', () => {
    expect(getMetricsKey('agent-1', '/wt/feature-auth')).toBe('/wt/feature-auth:agent-1');
  });
});
