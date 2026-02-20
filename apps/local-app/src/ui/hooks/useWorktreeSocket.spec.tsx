import { renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useWorktreeSocket } from './useWorktreeSocket';
import { getWorktreeSocket, releaseWorktreeSocket } from '@/ui/lib/socket';

jest.mock('@/ui/lib/socket', () => ({
  getWorktreeSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

describe('useWorktreeSocket', () => {
  const getWorktreeSocketMock = getWorktreeSocket as jest.MockedFunction<typeof getWorktreeSocket>;
  const releaseWorktreeSocketMock = releaseWorktreeSocket as jest.MockedFunction<
    typeof releaseWorktreeSocket
  >;
  const mockSocket = {
    connected: true,
    emit: jest.fn(),
  } as unknown as Socket;

  beforeEach(() => {
    jest.clearAllMocks();
    getWorktreeSocketMock.mockReturnValue(mockSocket);
  });

  it('acquires socket on mount and releases on unmount', () => {
    const { unmount, result } = renderHook(() => useWorktreeSocket('feature-auth'));

    expect(result.current.socket).toBe(mockSocket);
    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');

    unmount();

    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(releaseWorktreeSocketMock).toHaveBeenCalledTimes(1);
  });

  it('release callback is idempotent and prevents duplicate unmount release', () => {
    const { unmount, result } = renderHook(() => useWorktreeSocket('feature-auth'));

    result.current.release();
    result.current.release();

    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(releaseWorktreeSocketMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(releaseWorktreeSocketMock).toHaveBeenCalledTimes(1);
  });

  it('releases previous socket and acquires new socket when worktree changes', () => {
    const { rerender, unmount } = renderHook(({ name }) => useWorktreeSocket(name), {
      initialProps: { name: 'feature-auth' },
    });

    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');

    rerender({ name: 'feature-billing' });

    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-auth');
    expect(getWorktreeSocketMock).toHaveBeenCalledWith('feature-billing');

    unmount();
    expect(releaseWorktreeSocketMock).toHaveBeenCalledWith('feature-billing');
  });

  it('throws for empty worktree name', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useWorktreeSocket('   '))).toThrow(
        'useWorktreeSocket requires a non-empty worktreeName',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
