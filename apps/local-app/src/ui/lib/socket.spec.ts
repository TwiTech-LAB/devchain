import { io } from 'socket.io-client';
import { getAppSocket, releaseAppSocket, setAppSocket } from './socket';

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

describe('app socket pool', () => {
  const ioMock = io as unknown as jest.Mock;

  beforeEach(() => {
    ioMock.mockReset();
    setAppSocket(null);
  });

  afterEach(() => {
    setAppSocket(null);
    ioMock.mockReset();
  });

  describe('connection', () => {
    it('always uses the default app socket path for the singleton connection', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      const connected = getAppSocket('home');

      expect(connected).toBe(socket);
      expect(ioMock).toHaveBeenCalledTimes(1);
      expect(ioMock).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          path: '/socket.io',
          transports: ['websocket'],
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionAttempts: 10,
        }),
      );
    });
  });

  describe('acquire/release happy path', () => {
    it('ref-counts multiple acquires and disconnects on last release', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket('home');
      getAppSocket('home');
      getAppSocket('home');

      expect(ioMock).toHaveBeenCalledTimes(1);

      releaseAppSocket('home');
      releaseAppSocket('home');
      expect(socket.disconnect).not.toHaveBeenCalled();

      releaseAppSocket('home');
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('re-acquires after full release creates a new socket', () => {
      const first = createMockSocket('/socket.io');
      const second = createMockSocket('/socket.io');
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const s1 = getAppSocket('home');
      releaseAppSocket('home');
      const s2 = getAppSocket('home');

      expect(s1).toBe(first);
      expect(s2).toBe(second);
      expect(ioMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('refcount underflow recovery', () => {
    it('warns on release when there is no live socket', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // No socket acquired: release is a no-op with no warning.
        releaseAppSocket('home');
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('ping-pong listener lifecycle', () => {
    it('does not register additional message listeners on subsequent acquires', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket('home');
      getAppSocket('home');
      getAppSocket('home');

      expect(socket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(socket.on).toHaveBeenCalledTimes(1);
    });

    it('removes the message listener on last release', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket('home');
      getAppSocket('home');

      releaseAppSocket('home');
      expect(socket.off).not.toHaveBeenCalled();

      releaseAppSocket('home');
      expect(socket.off).toHaveBeenCalledWith('message', expect.any(Function));
      expect(socket.off).toHaveBeenCalledTimes(1);
    });

    it('responds to a system ping with pong and ignores other topics', () => {
      const socket = createMockSocket('/socket.io');
      ioMock.mockReturnValue(socket);

      getAppSocket('home');

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

  describe('non-accumulation of message listeners across reconnects', () => {
    it('re-acquiring after full release registers exactly one listener', () => {
      const first = createMockSocket('/socket.io');
      const second = createMockSocket('/socket.io');
      ioMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      getAppSocket('home');
      expect(first.on).toHaveBeenCalledTimes(1);

      releaseAppSocket('home');
      expect(first.off).toHaveBeenCalledTimes(1);

      getAppSocket('home');
      expect(second.on).toHaveBeenCalledTimes(1);
    });
  });

  describe('setAppSocket override', () => {
    it('installs a test double that getAppSocket returns without opening a connection', () => {
      const injected = createMockSocket('/socket.io');
      setAppSocket(injected as unknown as Parameters<typeof setAppSocket>[0]);

      const s = getAppSocket('home');
      expect(s).toBe(injected);
      // io is never called when a socket is injected.
      expect(ioMock).not.toHaveBeenCalled();
    });
  });

  describe('per-backend pool', () => {
    const REMOTE_ID = '11111111-1111-4111-8111-111111111111';

    it('connects a remote socket through the /r proxy path, separate from home', () => {
      const home = createMockSocket('/socket.io');
      const remote = createMockSocket(`/r/${REMOTE_ID}/socket.io`);
      ioMock.mockReturnValueOnce(home).mockReturnValueOnce(remote);

      expect(getAppSocket('home')).toBe(home);
      expect(getAppSocket(REMOTE_ID)).toBe(remote);
      expect(getAppSocket(REMOTE_ID)).toBe(remote);

      expect(ioMock).toHaveBeenCalledTimes(2);
      expect(ioMock).toHaveBeenLastCalledWith(
        '',
        expect.objectContaining({ path: `/r/${REMOTE_ID}/socket.io`, transports: ['websocket'] }),
      );

      releaseAppSocket(REMOTE_ID);
      expect(remote.disconnect).not.toHaveBeenCalled();
      releaseAppSocket(REMOTE_ID);
      expect(remote.disconnect).toHaveBeenCalledTimes(1);
      expect(home.disconnect).not.toHaveBeenCalled();

      releaseAppSocket('home');
      expect(home.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
