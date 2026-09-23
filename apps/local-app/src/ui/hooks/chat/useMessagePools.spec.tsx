import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMessagePools, type PoolDetails } from './useMessagePools';

const ioMock = jest.fn();

jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

const mockWorktreeTab = { activeWorktree: null as { name: string } | null };

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: mockWorktreeTab.activeWorktree,
    setActiveWorktree: jest.fn(),
    apiBase: mockWorktreeTab.activeWorktree
      ? `/wt/${encodeURIComponent(mockWorktreeTab.activeWorktree.name)}`
      : '',
    worktrees: [],
    worktreesLoading: false,
    runtimeResolved: true,
  }),
}));

let socketHandlers: Record<string, ((payload: unknown) => void)[]>;

function makePool(overrides: Partial<PoolDetails> = {}): PoolDetails {
  return {
    agentId: 'agent-1',
    agentName: 'Test Agent',
    projectId: 'project-1',
    messageCount: 1,
    humanHeldMessageCount: 0,
    waitingMs: 1000,
    messages: [],
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe('useMessagePools', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    mockWorktreeTab.activeWorktree = null;
    socketHandlers = {};
    ioMock.mockReturnValue({
      on: jest.fn((event: string, handler: (payload: unknown) => void) => {
        socketHandlers[event] = socketHandlers[event] || [];
        socketHandlers[event].push(handler);
      }),
      emit: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    });
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ pools: [makePool()] }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    ioMock.mockReset();
  });

  it('fetches pools for the project', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.pools).toEqual([makePool()]));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/pools?projectId=project-1'),
      undefined,
    );
  });

  it('does not fetch without a project', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useMessagePools(null), { wrapper: Wrapper });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an explicit human-hold release and refreshes the project pools', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.pools).toBeDefined());

    await act(async () => {
      await result.current.releaseHumanHeldMessages('agent-1');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/pools/agent-1/release-human-hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pools', 'project-1'] });
  });

  it('surfaces a stale release after newer terminal input', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => ({
      ok: !String(input).includes('release-human-hold'),
      status: 409,
      json: async () => ({ pools: [makePool()] }),
    }));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.pools).toBeDefined());

    await expect(result.current.releaseHumanHeldMessages('agent-1')).rejects.toThrow(
      'More recent terminal input postponed queued-message release.',
    );
  });

  it('invalidates the project pools query on a messages/pools update envelope', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

    const fetchedPools = () =>
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sessions/pools'));
    await waitFor(() => expect(fetchedPools()).toBe(true));

    const messageHandlers = socketHandlers['message'] || [];
    expect(messageHandlers.length).toBeGreaterThan(0);
    act(() => {
      messageHandlers.forEach((handler) => {
        handler({
          topic: 'messages/pools',
          type: 'updated',
          payload: [],
          ts: new Date().toISOString(),
        });
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pools', 'project-1'] });
    });
  });

  it('refetches after the envelope so cleared human-held counts reach consumers', async () => {
    let currentPools: PoolDetails[] = [makePool({ humanHeldMessageCount: 2 })];
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ pools: currentPools }),
    }));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.pools?.[0].humanHeldMessageCount).toBe(2));

    currentPools = [makePool({ humanHeldMessageCount: 0, messageCount: 0 })];
    act(() => {
      (socketHandlers['message'] || []).forEach((handler) => {
        handler({
          topic: 'messages/pools',
          type: 'updated',
          payload: [],
          ts: new Date().toISOString(),
        });
      });
    });

    await waitFor(() => expect(result.current.pools?.[0].humanHeldMessageCount).toBe(0));
  });

  it('ignores envelopes for other topics', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sessions/pools'))),
    );

    act(() => {
      (socketHandlers['message'] || []).forEach((handler) => {
        handler({
          topic: 'messages/activity',
          type: 'updated',
          payload: [],
          ts: new Date().toISOString(),
        });
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('exposes fetch errors to consumers', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect((result.current.error as Error).message).toBe('Failed to fetch pools');
  });

  describe('worktree tab active', () => {
    it('stays subscribed to the root app socket and invalidates on a root pools envelope', async () => {
      mockWorktreeTab.activeWorktree = { name: 'feature-auth' };
      const { Wrapper, queryClient } = createWrapper();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

      const fetchedPools = () =>
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sessions/pools'));
      await waitFor(() => expect(fetchedPools()).toBe(true));

      // No worktree socket may be created: the hook pins the root socket.
      const worktreeIoCalls = ioMock.mock.calls.filter(
        (call) =>
          typeof call[1] === 'object' &&
          String((call[1] as { path?: string }).path).startsWith('/wt/'),
      );
      expect(worktreeIoCalls).toHaveLength(0);

      const messageHandlers = socketHandlers['message'] || [];
      expect(messageHandlers.length).toBeGreaterThan(0);
      act(() => {
        messageHandlers.forEach((handler) => {
          handler({
            topic: 'messages/pools',
            type: 'updated',
            payload: [],
            ts: new Date().toISOString(),
          });
        });
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pools', 'project-1'] });
      });
    });

    it('shares one root socket across instances and disconnects only after the last releases', async () => {
      const { Wrapper } = createWrapper();
      const first = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
      const second = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });

      const fetchedPools = () =>
        fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sessions/pools'));
      await waitFor(() => expect(fetchedPools()).toBe(true));

      // Pooled acquisition: exactly one root socket instance for two consumers.
      const rootIoCalls = ioMock.mock.calls.filter(
        (call) =>
          typeof call[1] === 'object' && (call[1] as { path?: string }).path === '/socket.io',
      );
      expect(rootIoCalls).toHaveLength(1);
      const rootSocket = ioMock.mock.results[0]?.value as { disconnect: jest.Mock };

      first.unmount();
      expect(rootSocket.disconnect).not.toHaveBeenCalled();

      second.unmount();
      expect(rootSocket.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('force deferred delivery', () => {
    it('posts force request and invalidates pools on settlement', async () => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('force-deferred')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'delivered', deliveredCount: 1 }),
          };
        }
        return { ok: true, json: async () => ({ pools: [makePool()] }) };
      });
      const { Wrapper, queryClient } = createWrapper();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.pools).toBeDefined());

      await act(async () => {
        const outcome = await result.current.forceDeferredDelivery({
          agentId: 'agent-1',
          sessionId: 'session-1',
          messageIds: ['msg-1'],
        });
        expect(outcome).toEqual({ status: 'delivered', deliveredCount: 1 });
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/pools/agent-1/force-deferred',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            projectId: 'project-1',
            sessionId: 'session-1',
            messageIds: ['msg-1'],
          }),
        }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pools', 'project-1'] });
    });

    it('throws ForceConflictError on 409', async () => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('force-deferred')) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ message: 'Batch changed' }),
          };
        }
        return { ok: true, json: async () => ({ pools: [makePool()] }) };
      });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.pools).toBeDefined());

      await expect(
        result.current.forceDeferredDelivery({
          agentId: 'agent-1',
          sessionId: 'session-1',
          messageIds: ['msg-1'],
        }),
      ).rejects.toThrow('Batch changed');
    });

    it('exposes forcingAgentId while the mutation is in flight', async () => {
      let resolveForce!: () => void;
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('force-deferred')) {
          await new Promise<void>((resolve) => {
            resolveForce = resolve;
          });
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'delivered', deliveredCount: 1 }),
          };
        }
        return { ok: true, json: async () => ({ pools: [makePool()] }) };
      });
      const { Wrapper } = createWrapper();
      const { result } = renderHook(() => useMessagePools('project-1'), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.pools).toBeDefined());

      let forcePromise: Promise<unknown>;
      act(() => {
        forcePromise = result.current.forceDeferredDelivery({
          agentId: 'agent-1',
          sessionId: 'session-1',
          messageIds: ['msg-1'],
        });
      });

      await waitFor(() => expect(result.current.forcingAgentId).toBe('agent-1'));

      await act(async () => {
        resolveForce();
        await forcePromise!;
      });

      await waitFor(() => expect(result.current.forcingAgentId).toBeNull());
    });
  });
});
