/** @jest-environment jsdom */

import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { useWorktreeAgents } from './useWorktreeAgents';
import { getAppSocket, getWorktreeSocket, releaseWorktreeSocket } from '@/ui/lib/socket';
import { fetchRuntimeInfo } from '@/ui/lib/runtime';
import { listWorktrees } from '@/modules/orchestrator/ui/app/lib/worktrees';

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(),
  getWorktreeSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

jest.mock('@/ui/lib/runtime', () => ({
  fetchRuntimeInfo: jest.fn(),
}));

jest.mock('@/modules/orchestrator/ui/app/lib/worktrees', () => ({
  listWorktrees: jest.fn(),
}));

const getAppSocketMock = getAppSocket as jest.MockedFunction<typeof getAppSocket>;
const getWorktreeSocketMock = getWorktreeSocket as jest.MockedFunction<typeof getWorktreeSocket>;
const releaseWorktreeSocketMock = releaseWorktreeSocket as jest.MockedFunction<
  typeof releaseWorktreeSocket
>;
const fetchRuntimeInfoMock = fetchRuntimeInfo as jest.MockedFunction<typeof fetchRuntimeInfo>;
const listWorktreesMock = listWorktrees as jest.MockedFunction<typeof listWorktrees>;

interface MockSocket extends Socket {
  _listeners: Map<string, Set<(...args: unknown[]) => void>>;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    connected: true,
    emit: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    _listeners: listeners,
  } as unknown as MockSocket;
}

function simulateMessage(
  socket: MockSocket,
  envelope: { topic: string; type: string; payload?: unknown; ts?: string },
) {
  const handlers = socket._listeners.get('message');
  if (handlers) {
    for (const handler of handlers) {
      handler({ ts: new Date().toISOString(), payload: {}, ...envelope });
    }
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return { Wrapper, queryClient, invalidateSpy };
}

function setupMainMode() {
  fetchRuntimeInfoMock.mockResolvedValue({ mode: 'main' } as never);
}

function setupNonMainMode() {
  fetchRuntimeInfoMock.mockResolvedValue({ mode: 'normal' } as never);
}

/**
 * Flush multiple microtask cycles so the chained queries
 * (runtime-info → worktree-agent-groups → effects) can all resolve.
 */
async function flushQueryChain(cycles = 8) {
  for (let i = 0; i < cycles; i++) {
    await act(async () => {
      jest.advanceTimersByTime(10);
    });
  }
}

describe('useWorktreeAgents socket behavior', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    listWorktreesMock.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  describe('per-worktree presence sockets', () => {
    it('does not connect worktree sockets when not in main mode', async () => {
      setupNonMainMode();
      const { Wrapper } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });
      await act(async () => {
        jest.advanceTimersByTime(10);
      });

      expect(getWorktreeSocketMock).not.toHaveBeenCalled();
    });

    it('connects to running worktree sockets and listens for presence events', async () => {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
        if (url.includes('/api/agents')) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
            }),
          };
        }
        if (url.includes('/api/sessions/agents/presence')) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      });

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);
      const { Wrapper } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });

      await flushQueryChain();

      expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-one');
      expect(wtSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('triggers debounced invalidation on agent presence event', async () => {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
        if (url.includes('/api/agents')) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
            }),
          };
        }
        if (url.includes('/api/sessions/agents/presence')) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      });

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);
      const { Wrapper, invalidateSpy } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });

      await flushQueryChain();

      invalidateSpy.mockClear();

      // Simulate agent presence event on worktree socket
      act(() => {
        simulateMessage(wtSocket, { topic: 'agent/a1', type: 'presence' });
      });

      // Should not invalidate immediately (debounced 500ms)
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ['chat-worktree-agent-groups'],
      });

      // Advance past debounce timer
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['chat-worktree-agent-groups'],
      });
    });

    it('triggers debounced invalidation on session activity event', async () => {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
        }),
      }));

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);
      const { Wrapper, invalidateSpy } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });

      await flushQueryChain();

      invalidateSpy.mockClear();

      act(() => {
        simulateMessage(wtSocket, { topic: 'session/s1', type: 'activity' });
      });

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['chat-worktree-agent-groups'],
      });
    });

    it('releases worktree sockets on unmount', async () => {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
        }),
      }));

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);
      const { Wrapper } = createWrapper();

      const { unmount } = renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });

      await flushQueryChain();

      unmount();

      expect(wtSocket.off).toHaveBeenCalledWith('message', expect.any(Function));
      expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-one');
    });

    it('does not react to unrelated worktree socket events', async () => {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
        }),
      }));

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);
      const { Wrapper, invalidateSpy } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });

      await flushQueryChain();

      invalidateSpy.mockClear();

      // Simulate an unrelated event (e.g., chat message on worktree socket)
      act(() => {
        simulateMessage(wtSocket, { topic: 'chat/thread-1', type: 'message.created' });
      });

      act(() => {
        jest.advanceTimersByTime(500);
      });

      // Should not have triggered presence invalidation
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ['chat-worktree-agent-groups'],
      });
    });
  });

  describe('reconnection storm prevention', () => {
    function setupRunningWorktree() {
      setupMainMode();
      const appSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(appSocket);

      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
      ] as never);

      (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
        if (url.includes('/api/agents')) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: 'a1', name: 'Agent', type: 'agent', profileId: 'p1' }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const wtSocket = createMockSocket();
      getWorktreeSocketMock.mockReturnValue(wtSocket);

      return { appSocket, wtSocket };
    }

    it('does not reconnect worktree socket after presence-triggered refetch', async () => {
      const { wtSocket } = setupRunningWorktree();
      const { Wrapper } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });
      await flushQueryChain();

      // Socket should be connected exactly once
      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(1);
      expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();

      // Simulate presence event → debounce fires → query invalidation → refetch
      act(() => {
        simulateMessage(wtSocket, { topic: 'agent/a1', type: 'presence' });
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });

      // Flush the refetch cycle (new worktreeGroups array reference)
      await flushQueryChain();

      // Socket should NOT have been released or re-acquired
      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(1);
      expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();
    });

    it('socket call count remains stable after multiple presence events', async () => {
      const { wtSocket } = setupRunningWorktree();
      const { Wrapper } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });
      await flushQueryChain();

      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(1);

      // Fire multiple presence events with debounce resolution between each
      for (let i = 0; i < 5; i++) {
        act(() => {
          simulateMessage(wtSocket, { topic: 'agent/a1', type: 'presence' });
        });
        act(() => {
          jest.advanceTimersByTime(500);
        });
        await flushQueryChain();
      }

      // Still only one socket connection, zero releases
      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(1);
      expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();
    });

    it('does not disconnect existing socket when a new worktree is added', async () => {
      const { wtSocket } = setupRunningWorktree();
      const wtSocket2 = createMockSocket();
      const { Wrapper } = createWrapper();

      renderHook(() => useWorktreeAgents(), { wrapper: Wrapper });
      await flushQueryChain();

      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(1);

      // Add a second running worktree on next refetch
      listWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          name: 'feature-one',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-1',
          containerPort: 4001,
        },
        {
          id: 'wt-2',
          name: 'feature-two',
          status: 'running',
          runtimeType: 'process',
          devchainProjectId: 'proj-2',
          containerPort: 4002,
        },
      ] as never);

      // Return a different socket for the second worktree
      getWorktreeSocketMock.mockReturnValue(wtSocket2);

      // Trigger refetch via presence event
      act(() => {
        simulateMessage(wtSocket, { topic: 'agent/a1', type: 'presence' });
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      await flushQueryChain();

      // First socket should not have been released; second socket acquired
      expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();
      expect(getWorktreeSocketMock).toHaveBeenCalledTimes(2);
      expect(wtSocket.off).not.toHaveBeenCalled();
    });
  });
});
