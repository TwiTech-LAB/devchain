import { io } from 'socket.io-client';
import {
  getAppSocket,
  getSocket,
  getWorktreeSocket,
  releaseAppSocket,
  releaseSocket,
  releaseWorktreeSocket,
  setAppSocket,
} from './socket';
import type { SocketAddress } from './socket';

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
  off: jest.Mock;
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
    off: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    connect: jest.fn(),
  };
}

describe('socket unified pool', () => {
  const ioMock = io as unknown as jest.Mock;

  beforeEach(() => {
    ioMock.mockReset();
    setAppSocket(null);
    releaseWorktreeSocket('feature-auth');
    releaseWorktreeSocket('feature-billing');
    releaseWorktreeSocket('feature-search');
    releaseWorktreeSocket('feature/auth');
    releaseWorktreeSocket('x');
    releaseWorktreeSocket('test-wt');
  });

  afterEach(() => {
    releaseAppSocket();
    setAppSocket(null);
    releaseWorktreeSocket('feature-auth');
    releaseWorktreeSocket('feature-billing');
    releaseWorktreeSocket('feature-search');
    releaseWorktreeSocket('feature/auth');
    releaseWorktreeSocket('x');
    releaseWorktreeSocket('test-wt');
    ioMock.mockReset();
  });

  describe('backward compat: app socket', () => {
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
  });

  describe('backward compat: worktree sockets', () => {
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

  describe('unified getSocket / releaseSocket', () => {
    it('acquires and releases main socket via unified API', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      const s = getSocket('main');
      expect(s).toBe(socket);
      expect(ioMock).toHaveBeenCalledTimes(1);

      releaseSocket('main');
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('acquires and releases worktree socket via unified API', () => {
      const socket = createMockSocket('/wt/test-wt/socket.io');
      ioMock.mockReturnValue(socket);

      const s = getSocket({ worktree: 'test-wt' });
      expect(s).toBe(socket);

      releaseSocket({ worktree: 'test-wt' });
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('main and worktree sockets are independent', () => {
      const mainSocket = createMockSocket('/socket.io');
      const wtSocket = createMockSocket('/wt/x/socket.io');
      ioMock.mockReturnValueOnce(mainSocket).mockReturnValueOnce(wtSocket);

      getSocket('main');
      getSocket({ worktree: 'x' });

      releaseSocket('main');
      expect(mainSocket.disconnect).toHaveBeenCalledTimes(1);
      expect(wtSocket.disconnect).not.toHaveBeenCalled();

      releaseSocket({ worktree: 'x' });
      expect(wtSocket.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('acquire/release happy path', () => {
    it('ref-counts multiple acquires and disconnects on last release', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();
      getAppSocket();
      getAppSocket();

      expect(ioMock).toHaveBeenCalledTimes(1);

      releaseAppSocket();
      releaseAppSocket();
      expect(socket.disconnect).not.toHaveBeenCalled();

      releaseAppSocket();
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('re-acquires after full release creates new socket', () => {
      const first = createMockSocket('/socket.io');
      const second = createMockSocket('/socket.io');
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const s1 = getAppSocket();
      releaseAppSocket();
      const s2 = getAppSocket();

      expect(s1).toBe(first);
      expect(s2).toBe(second);
      expect(ioMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('refcount underflow recovery', () => {
    it('recovers from non-positive refCount on acquire', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getWorktreeSocket('feature-auth');
      releaseWorktreeSocket('feature-auth');

      expect(socket.disconnect).toHaveBeenCalledTimes(1);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // Simulate pool entry with refCount = 0 by re-acquiring
        // The socket was disconnected and removed from pool, so re-acquire creates new
        const newSocket = createMockSocket('/wt/feature-auth/socket.io');
        ioMock.mockReturnValue(newSocket);

        getWorktreeSocket('feature-auth');
        expect(ioMock).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('warns on release when refCount is already zero', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getWorktreeSocket('feature-auth');
      releaseWorktreeSocket('feature-auth');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        releaseWorktreeSocket('feature-auth');
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('ping-pong listener lifecycle', () => {
    it('registers message listener on first acquire', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();

      expect(socket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(socket.on).toHaveBeenCalledTimes(1);
    });

    it('does not register additional message listener on subsequent acquires', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();
      getAppSocket();
      getAppSocket();

      expect(socket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(socket.on).toHaveBeenCalledTimes(1);
    });

    it('removes message listener on last release', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();
      getAppSocket();

      releaseAppSocket();
      expect(socket.off).not.toHaveBeenCalled();

      releaseAppSocket();
      expect(socket.off).toHaveBeenCalledWith('message', expect.any(Function));
      expect(socket.off).toHaveBeenCalledTimes(1);
    });

    it('ping-pong handler responds to system ping with pong', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();

      const handler = socket.on.mock.calls.find(
        (call: [string, (...args: unknown[]) => void]) => call[0] === 'message',
      )?.[1];
      expect(handler).toBeDefined();

      handler!({ topic: 'system', type: 'ping', payload: null, ts: '' });
      expect(socket.emit).toHaveBeenCalledWith('pong');

      socket.emit.mockClear();
      handler!({ topic: 'other', type: 'ping', payload: null, ts: '' });
      expect(socket.emit).not.toHaveBeenCalled();
    });
  });

  describe('non-accumulation of message listener across reconnects', () => {
    it('re-acquiring after full release registers exactly one listener', () => {
      const first = createMockSocket('/socket.io');
      const second = createMockSocket('/socket.io');
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      getAppSocket();
      expect(first.on).toHaveBeenCalledTimes(1);

      releaseAppSocket();
      expect(first.off).toHaveBeenCalledTimes(1);

      getAppSocket();
      expect(second.on).toHaveBeenCalledTimes(1);
    });

    it('worktree socket: re-acquire after full release has single listener', () => {
      const first = createMockSocket('/wt/x/socket.io');
      const second = createMockSocket('/wt/x/socket.io');
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      getWorktreeSocket('x');
      releaseWorktreeSocket('x');

      getWorktreeSocket('x');
      expect(second.on).toHaveBeenCalledTimes(1);
      expect(first.on).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnect cleanup', () => {
    it('disconnects socket on last release', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();
      releaseAppSocket();

      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not disconnect while refs remain', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket();
      getAppSocket();
      releaseAppSocket();

      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('worktree pool deletion', () => {
    it('removes worktree entry from pool on last release', () => {
      const socket1 = createMockSocket('/wt/x/socket.io');
      const socket2 = createMockSocket('/wt/x/socket.io');
      ioMock.mockReturnValueOnce(socket1).mockReturnValueOnce(socket2);

      getWorktreeSocket('x');
      releaseWorktreeSocket('x');

      // Re-acquire should create a new socket (pool entry was deleted)
      getWorktreeSocket('x');
      expect(ioMock).toHaveBeenCalledTimes(2);
    });

    it('does not delete worktree entry while refs remain', () => {
      const socket = createMockSocket('/wt/x/socket.io');
      ioMock.mockReturnValue(socket);

      getWorktreeSocket('x');
      getWorktreeSocket('x');
      releaseWorktreeSocket('x');

      // Should reuse (not create new)
      getWorktreeSocket('x');
      expect(ioMock).toHaveBeenCalledTimes(1);
    });
  });
});
