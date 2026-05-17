import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { useChatSocket, type UseChatSocketOptions } from './useChatSocket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

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
    selectedThreadId: null,
    agents: [],
    getLatestSelectedThreadId: () => null,
    isInlineActive: () => false,
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

  it('passes event handlers for connect, disconnect, and message to useAppSocket', () => {
    const socket = createMockSocket();
    useAppSocketMock.mockReturnValue(socket);

    renderHook(() => useChatSocket(buildOptions()), {
      wrapper: createWrapper(),
    });

    const lastCall = useAppSocketMock.mock.calls[useAppSocketMock.mock.calls.length - 1];
    const handlers = lastCall[0];
    expect(typeof handlers.connect).toBe('function');
    expect(typeof handlers.disconnect).toBe('function');
    expect(typeof handlers.message).toBe('function');
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
      });

      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it('does not break existing chat message handling', () => {
      setup();
      messageHandler({
        topic: 'chat/thread-1',
        type: 'message.created',
        payload: { authorType: 'user', authorAgentId: null, content: 'hi' },
      });

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['messages', 'thread-1'],
      });
    });
  });
});
