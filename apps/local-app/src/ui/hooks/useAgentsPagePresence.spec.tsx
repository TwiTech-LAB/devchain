import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAgentsPagePresence } from './useAgentsPagePresence';

// ============================================
// Mocks
// ============================================

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => {
  const actual = jest.requireActual('@/ui/lib/sessions');
  return {
    ...actual,
    fetchAgentPresence: jest.fn().mockResolvedValue({}),
  };
});

import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchAgentPresence, type AgentPresenceMap } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';

const mockFetchPresence = fetchAgentPresence as jest.MockedFunction<typeof fetchAgentPresence>;
const mockUseAppSocket = useAppSocket as jest.MockedFunction<typeof useAppSocket>;

// ============================================
// Helpers
// ============================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

function makeEnvelope(overrides: Partial<WsEnvelope> = {}): WsEnvelope {
  return {
    topic: 'agent/abc',
    type: 'presence',
    payload: {},
    ts: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function captureMessageHandler(): (envelope: WsEnvelope) => void {
  const handlerMap = mockUseAppSocket.mock.calls[0][0];
  if (typeof handlerMap.message !== 'function') {
    throw new Error('useAppSocket was not given a message handler');
  }
  return handlerMap.message;
}

// ============================================
// Tests
// ============================================

describe('useAgentsPagePresence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAppSocket.mockReturnValue({
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      connected: true,
    } as unknown as ReturnType<typeof useAppSocket>);
    mockFetchPresence.mockResolvedValue({});
  });

  // ---- Project scoping ----

  describe('project scoping', () => {
    it('returns the fetched presence map for the project', async () => {
      const presence: AgentPresenceMap = {
        'agent-1': { online: true, sessionId: 'sess-1' },
      };
      mockFetchPresence.mockResolvedValue(presence);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual(presence);
      });
      expect(mockFetchPresence).toHaveBeenCalledWith('proj-1', expect.any(Function));
    });

    it('caches presence under the exact agent-presence query key for the project', async () => {
      const presence: AgentPresenceMap = {
        'agent-1': { online: true, sessionId: 'sess-1' },
      };
      mockFetchPresence.mockResolvedValue(presence);
      const { wrapper, queryClient } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual(presence);
      });

      expect(queryClient.getQueryData(['agent-presence', 'proj-1'])).toEqual(presence);
    });
  });

  // ---- Enabled-state behavior ----

  describe('enabled-state behavior', () => {
    it('returns an empty map and does not fetch when projectId is null', async () => {
      const { wrapper, queryClient } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: null }), {
        wrapper,
      });

      expect(result.current).toEqual({});
      expect(mockFetchPresence).not.toHaveBeenCalled();

      // The query stays registered under the null-scoped key but disabled.
      await act(async () => {
        await Promise.resolve();
      });
      expect(queryClient.getQueryState(['agent-presence', null])?.fetchStatus).toBe('idle');
    });
  });

  // ---- Polling ----

  describe('polling', () => {
    it('keeps the 2000 ms refresh interval on the presence query', async () => {
      mockFetchPresence.mockResolvedValue({});
      const { wrapper, queryClient } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual({});
      });

      const cachedOptions: unknown = queryClient.getQueryCache().find({
        queryKey: ['agent-presence', 'proj-1'],
        exact: true,
      })?.options;
      expect(
        cachedOptions !== null &&
          typeof cachedOptions === 'object' &&
          'refetchInterval' in cachedOptions
          ? cachedOptions.refetchInterval
          : undefined,
      ).toBe(2000);
    });
  });

  // ---- Realtime refresh ----

  describe('realtime refresh', () => {
    it('refetches presence when an agent-presence envelope arrives', async () => {
      const first: AgentPresenceMap = { 'agent-1': { online: false } };
      const second: AgentPresenceMap = { 'agent-1': { online: true, sessionId: 'sess-1' } };
      mockFetchPresence.mockResolvedValue(first);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual(first);
      });

      mockFetchPresence.mockResolvedValue(second);
      await act(async () => {
        captureMessageHandler()(makeEnvelope({ topic: 'agent/abc', type: 'presence' }));
      });

      await waitFor(() => {
        expect(result.current).toEqual(second);
      });
    });

    it('refetches presence when a session-activity envelope arrives', async () => {
      const first: AgentPresenceMap = { 'agent-1': { online: true, sessionId: 'sess-1' } };
      const second: AgentPresenceMap = { 'agent-1': { online: false } };
      mockFetchPresence.mockResolvedValue(first);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual(first);
      });

      mockFetchPresence.mockResolvedValue(second);
      await act(async () => {
        captureMessageHandler()(makeEnvelope({ topic: 'session/abc', type: 'activity' }));
      });

      await waitFor(() => {
        expect(result.current).toEqual(second);
      });
    });

    it('ignores envelopes whose topic and type do not pair with a registry namespace', async () => {
      mockFetchPresence.mockResolvedValue({ 'agent-1': { online: true } });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAgentsPagePresence({ projectId: 'proj-1' }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current).toEqual({ 'agent-1': { online: true } });
      });

      await act(async () => {
        captureMessageHandler()(
          makeEnvelope({ topic: 'agent/abc', type: 'activity', payload: {} }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(mockFetchPresence).toHaveBeenCalledTimes(1);
    });
  });
});
