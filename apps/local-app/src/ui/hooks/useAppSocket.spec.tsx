import { renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useAppSocket } from './useAppSocket';
import {
  getAppSocket,
  getWorktreeSocket,
  releaseAppSocket,
  releaseWorktreeSocket,
} from '@/ui/lib/socket';

let activeWorktreeName: string | null = null;

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: activeWorktreeName
      ? {
          id: `wt-${activeWorktreeName}`,
          name: activeWorktreeName,
          devchainProjectId: `project-${activeWorktreeName}`,
        }
      : null,
    setActiveWorktree: jest.fn(),
    apiBase: activeWorktreeName ? `/wt/${encodeURIComponent(activeWorktreeName)}` : '',
    worktrees: [],
    worktreesLoading: false,
  }),
}));

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(),
  getWorktreeSocket: jest.fn(),
  releaseAppSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

function createMockSocket(): Socket {
  return {
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  } as unknown as Socket;
}

describe('useAppSocket', () => {
  const getAppSocketMock = getAppSocket as jest.MockedFunction<typeof getAppSocket>;
  const getWorktreeSocketMock = getWorktreeSocket as jest.MockedFunction<typeof getWorktreeSocket>;
  const releaseAppSocketMock = releaseAppSocket as jest.MockedFunction<typeof releaseAppSocket>;
  const releaseWorktreeSocketMock = releaseWorktreeSocket as jest.MockedFunction<
    typeof releaseWorktreeSocket
  >;

  beforeEach(() => {
    activeWorktreeName = null;
    jest.clearAllMocks();
  });

  it('uses app socket when no worktree is active', () => {
    const appSocket = createMockSocket();
    getAppSocketMock.mockReturnValue(appSocket);
    const handler = jest.fn();

    const { result, unmount } = renderHook(() => useAppSocket({ message: handler }, [handler]));

    expect(result.current).toBe(appSocket);
    expect(getAppSocketMock).toHaveBeenCalledTimes(1);
    expect(getWorktreeSocketMock).not.toHaveBeenCalled();

    unmount();

    expect(releaseAppSocketMock).toHaveBeenCalledTimes(1);
    expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();
  });

  it('uses worktree socket when a worktree is active', () => {
    activeWorktreeName = 'feature-auth';
    const worktreeSocket = createMockSocket();
    getWorktreeSocketMock.mockReturnValue(worktreeSocket);
    const handler = jest.fn();

    const { result, unmount } = renderHook(() => useAppSocket({ message: handler }, [handler]));

    expect(result.current).toBe(worktreeSocket);
    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(getAppSocketMock).not.toHaveBeenCalled();

    unmount();

    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(releaseAppSocketMock).not.toHaveBeenCalled();
  });

  it('socketOverride takes precedence over worktree auto-selection', () => {
    activeWorktreeName = 'feature-auth';
    const overrideSocket = createMockSocket();
    const handler = jest.fn();

    const { result, unmount } = renderHook(() =>
      useAppSocket({ message: handler }, [handler], overrideSocket),
    );

    expect(result.current).toBe(overrideSocket);
    expect(getAppSocketMock).not.toHaveBeenCalled();
    expect(getWorktreeSocketMock).not.toHaveBeenCalled();

    unmount();

    expect(releaseAppSocketMock).not.toHaveBeenCalled();
    expect(releaseWorktreeSocketMock).not.toHaveBeenCalled();
  });

  it('releases worktree socket when worktree context changes', () => {
    activeWorktreeName = 'feature-auth';
    const worktreeSocket = createMockSocket();
    const appSocket = createMockSocket();
    getWorktreeSocketMock.mockReturnValue(worktreeSocket);
    getAppSocketMock.mockReturnValue(appSocket);
    const handler = jest.fn();

    const { rerender, result, unmount } = renderHook(
      ({ dep }) => useAppSocket({ message: handler }, [dep]),
      { initialProps: { dep: 0 } },
    );

    expect(result.current).toBe(worktreeSocket);
    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');

    // Switch back to main (no worktree)
    activeWorktreeName = null;
    rerender({ dep: 1 });

    expect(result.current).toBe(appSocket);
    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(getAppSocketMock).toHaveBeenCalledTimes(1);

    unmount();

    expect(releaseAppSocketMock).toHaveBeenCalledTimes(1);
  });

  it('acquires app socket once across rerenders and releases once on unmount', () => {
    const appSocket = createMockSocket();
    getAppSocketMock.mockReturnValue(appSocket);
    const handler = jest.fn();

    const { rerender, unmount, result } = renderHook(
      ({ dep }) => useAppSocket({ message: handler }, [dep]),
      { initialProps: { dep: 0 } },
    );

    expect(result.current).toBe(appSocket);
    expect(getAppSocketMock).toHaveBeenCalledTimes(1);

    rerender({ dep: 1 });
    rerender({ dep: 2 });

    expect(getAppSocketMock).toHaveBeenCalledTimes(1);
    expect(releaseAppSocketMock).not.toHaveBeenCalled();

    unmount();

    expect(releaseAppSocketMock).toHaveBeenCalledTimes(1);
  });

  it('releases acquired app socket when switching to override mode', () => {
    const appSocket = createMockSocket();
    const overrideSocket = createMockSocket();
    const handler = jest.fn();
    getAppSocketMock.mockReturnValue(appSocket);

    const { rerender, unmount, result } = renderHook(
      ({ useOverride }) =>
        useAppSocket({ message: handler }, [useOverride], useOverride ? overrideSocket : undefined),
      { initialProps: { useOverride: false } },
    );

    expect(result.current).toBe(appSocket);
    expect(getAppSocketMock).toHaveBeenCalledTimes(1);
    expect(releaseAppSocketMock).not.toHaveBeenCalled();

    rerender({ useOverride: true });

    expect(result.current).toBe(overrideSocket);
    expect(releaseAppSocketMock).toHaveBeenCalledTimes(1);

    unmount();

    expect(releaseAppSocketMock).toHaveBeenCalledTimes(1);
  });
});
