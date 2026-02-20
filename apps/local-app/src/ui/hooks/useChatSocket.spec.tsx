import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { useChatSocket, type UseChatSocketOptions } from './useChatSocket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
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
    // No 3rd argument (socketOverride) — useAppSocket handles worktree selection
    expect(useAppSocketMock.mock.calls[0][2]).toBeUndefined();
    expect(result.current.socketRef.current).toBe(socket);
  });

  it('passes event handlers for connect, disconnect, and message to useAppSocket', () => {
    const socket = createMockSocket();
    useAppSocketMock.mockReturnValue(socket);

    renderHook(() => useChatSocket(buildOptions()), {
      wrapper: createWrapper(),
    });

    const handlers = useAppSocketMock.mock.calls[0][0];
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
});
