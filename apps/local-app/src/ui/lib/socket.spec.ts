import { io } from 'socket.io-client';
import {
  getAppSocket,
  getWorktreeSocket,
  releaseAppSocket,
  releaseWorktreeSocket,
  setAppSocket,
} from './socket';

jest.mock('socket.io-client', () => ({
  io: jest.fn(),
}));

interface MockSocket {
  io: {
    opts: {
      path?: string;
    };
  };
  on: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
}

function createMockSocket(path = '/socket.io'): MockSocket {
  return {
    io: {
      opts: { path },
    },
    on: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connect: jest.fn(),
  };
}

describe('socket singleton', () => {
  const ioMock = io as unknown as jest.Mock;

  beforeEach(() => {
    ioMock.mockReset();
    setAppSocket(null);
    releaseWorktreeSocket('feature-auth');
    releaseWorktreeSocket('feature-billing');
    releaseWorktreeSocket('feature-search');
    releaseWorktreeSocket('feature/auth');
  });

  afterEach(() => {
    releaseAppSocket();
    setAppSocket(null);
    releaseWorktreeSocket('feature-auth');
    releaseWorktreeSocket('feature-billing');
    releaseWorktreeSocket('feature-search');
    releaseWorktreeSocket('feature/auth');
    ioMock.mockReset();
  });

  it('always uses default app socket path for singleton connection', () => {
    const socket = createMockSocket('/socket.io');
    ioMock.mockReturnValue(socket);

    const connected = getAppSocket();

    expect(connected).toBe(socket);
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        path: '/socket.io',
      }),
    );
  });

  it('creates and reuses pooled worktree sockets with ref-counting', () => {
    const socket = createMockSocket('/wt/feature-auth/socket.io');
    ioMock.mockReturnValue(socket);

    const first = getWorktreeSocket('feature-auth');
    const second = getWorktreeSocket('feature-auth');

    expect(first).toBe(socket);
    expect(second).toBe(socket);
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        path: '/wt/feature-auth/socket.io',
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10,
      }),
    );

    releaseWorktreeSocket('feature-auth');
    expect(socket.disconnect).not.toHaveBeenCalled();

    releaseWorktreeSocket('feature-auth');
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('supports multiple concurrent worktree sockets without interfering with global socket', () => {
    const globalSocket = createMockSocket('/socket.io');
    const authSocket = createMockSocket('/wt/feature-auth/socket.io');
    const billingSocket = createMockSocket('/wt/feature-billing/socket.io');
    ioMock
      .mockReturnValueOnce(globalSocket)
      .mockReturnValueOnce(authSocket)
      .mockReturnValueOnce(billingSocket);

    const appSocket = getAppSocket();
    const worktreeAuth = getWorktreeSocket('feature-auth');
    const worktreeBilling = getWorktreeSocket('feature-billing');

    expect(appSocket).toBe(globalSocket);
    expect(worktreeAuth).toBe(authSocket);
    expect(worktreeBilling).toBe(billingSocket);
    expect(ioMock).toHaveBeenCalledTimes(3);

    releaseWorktreeSocket('feature-auth');
    expect(authSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(billingSocket.disconnect).not.toHaveBeenCalled();
    expect(globalSocket.disconnect).not.toHaveBeenCalled();

    releaseWorktreeSocket('feature-billing');
    expect(billingSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(globalSocket.disconnect).not.toHaveBeenCalled();
  });

  it('encodes worktree name when building socket path', () => {
    const socket = createMockSocket('/wt/feature%2Fauth/socket.io');
    ioMock.mockReturnValue(socket);

    getWorktreeSocket('feature/auth');

    expect(ioMock).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        path: '/wt/feature%2Fauth/socket.io',
      }),
    );
  });
});
