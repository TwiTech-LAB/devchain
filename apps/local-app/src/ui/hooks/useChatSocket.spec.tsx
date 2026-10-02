import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { useChatSocket, type UseChatSocketOptions } from './useChatSocket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useRealtimeDispatch } from '@/ui/hooks/useRealtimeDispatch';
import type { WsEnvelope } from '@/ui/lib/socket';

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/hooks/useRealtimeDispatch', () => ({
  useRealtimeDispatch: jest.fn(),
}));

function createMockSocket(): Socket {
  return {
    connected: true,
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as Socket;
}

function buildOptions(overrides: Partial<UseChatSocketOptions> = {}): UseChatSocketOptions {
  return {
    projectId: 'project-1',
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useChatSocket', () => {
  const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
  const useRealtimeDispatchMock = useRealtimeDispatch as jest.MockedFunction<
    typeof useRealtimeDispatch
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates socket selection to useAppSocket without override', () => {
    const socket = createMockSocket();
    useAppSocketMock.mockReturnValue(socket);

    const { result } = renderHook(() => useChatSocket(buildOptions()), {
      wrapper: createWrapper(),
    });

    expect(useAppSocketMock).toHaveBeenCalled();
    expect(result.current.socketRef.current).toBe(socket);
  });

  it('binds only the retained project-state message handler', () => {
    const socket = createMockSocket();
    useAppSocketMock.mockReturnValue(socket);

    renderHook(() => useChatSocket(buildOptions()), {
      wrapper: createWrapper(),
    });

    const lastCall = useAppSocketMock.mock.calls[useAppSocketMock.mock.calls.length - 1];
    const handlers = lastCall[0];
    expect(typeof handlers.message).toBe('function');
    expect(handlers.connect).toBeUndefined();
    expect(handlers.disconnect).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('retains agent, team, presence, and session invalidations without thread entries', () => {
    useAppSocketMock.mockReturnValue(createMockSocket());

    renderHook(() => useChatSocket(buildOptions()), { wrapper: createWrapper() });

    const registry = useRealtimeDispatchMock.mock.calls.at(-1)?.[0] ?? [];
    expect(registry.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'agent.created',
        'agent.deleted',
        'team.member.added',
        'team.member.removed',
        'team.config.updated',
        'presence',
        'activity',
      ]),
    );
    expect(
      registry
        .flatMap((entry) => entry.entries)
        .some((entry) =>
          entry.kind === 'invalidate' && Array.isArray(entry.queryKey)
            ? entry.queryKey.some((segment) => String(segment).includes('thread'))
            : false,
        ),
    ).toBe(false);
  });

  it('exposes socketRef pointing to the socket returned by useAppSocket', () => {
    const socket = createMockSocket();
    useAppSocketMock.mockReturnValue(socket);

    const { result, unmount } = renderHook(() => useChatSocket(buildOptions()), {
      wrapper: createWrapper(),
    });

    expect(result.current.socketRef.current).toBe(socket);

    unmount();
  });

  describe('project-state topic', () => {
    let queryClient: QueryClient;
    let messageHandler: (envelope: WsEnvelope) => void;

    function setup(projectId = 'project-1') {
      const socket = createMockSocket();
      useAppSocketMock.mockReturnValue(socket);
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      jest.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useChatSocket(buildOptions({ projectId })), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      });

      const lastCall = useAppSocketMock.mock.calls[useAppSocketMock.mock.calls.length - 1];
      messageHandler = lastCall[0].message;
    }

    it('team.member.added invalidates team detail', () => {
      setup();
      messageHandler({
        topic: 'project/project-1/state',
        type: 'team.member.added',
        payload: { teamId: 't1', teamName: 'Backend', addedAgentId: 'a2', addedAgentName: 'W' },
        ts: '2026-01-01T00:00:00.000Z',
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['teams', 'detail', 't1'],
      });
    });

    it('team.member.removed invalidates team detail', () => {
      setup();
      messageHandler({
        topic: 'project/project-1/state',
        type: 'team.member.removed',
        payload: { teamId: 't1', teamName: 'Backend', removedAgentId: 'a2', removedAgentName: 'W' },
        ts: '2026-01-01T00:00:00.000Z',
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['teams', 'detail', 't1'],
      });
    });

    it('team.config.updated invalidates team detail', () => {
      setup();
      messageHandler({
        topic: 'project/project-1/state',
        type: 'team.config.updated',
        payload: { teamId: 't1', teamName: 'Backend', previous: {}, current: {} },
        ts: '2026-01-01T00:00:00.000Z',
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['teams', 'detail', 't1'],
      });
    });

    it('ignores project-state events from a different project', () => {
      setup('project-1');
      messageHandler({
        topic: 'project/project-other/state',
        type: 'agent.created',
        payload: { agentId: 'a1', agentName: 'Coder' },
        ts: '2026-01-01T00:00:00.000Z',
      });

      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it('ignores removed chat message topics', () => {
      setup();
      messageHandler({
        topic: 'chat/thread-1',
        type: 'message.created',
        payload: { authorType: 'user', authorAgentId: null, content: 'hi' },
        ts: '2026-01-01T00:00:00.000Z',
      });

      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });
  });
});
