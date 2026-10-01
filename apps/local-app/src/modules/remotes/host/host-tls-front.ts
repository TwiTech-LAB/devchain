import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket, type SecureContext } from 'node:tls';
import { isLoopbackHost } from '../../../common/config/integration-admission';

/** The first byte of every TLS connection: a handshake record. */
const TLS_HANDSHAKE_RECORD = 0x16;
const FIRST_BYTE_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const INSTALLED = Symbol('hostTlsFront');

export interface TlsFrontOptions {
  secureContext: SecureContext;
  firstByteTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

type ConnectionListener = (socket: Socket) => void;

/**
 * Serves TLS and plaintext on the one port of `server`. Each new connection's
 * first byte decides: a TLS handshake from any peer, plaintext from a loopback
 * peer only. Plaintext from any other peer is closed unanswered. Both kinds
 * then go to the server's own `'connection'` listeners, so `server` stays the
 * real HTTP server (Socket.IO, upgrades) and the peer address stays real.
 */
export function installTlsFront(server: Server, options: TlsFrontOptions): void {
  const guarded = server as Server & { [INSTALLED]?: true };
  if (guarded[INSTALLED]) throw new Error('The TLS front is already installed on this server');
  // A connection accepted before the swap would skip the front.
  if (server.listening) throw new Error('Install the TLS front before the server listens');
  guarded[INSTALLED] = true;

  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const handlers = server.listeners('connection') as ConnectionListener[];
  server.removeAllListeners('connection');
  // Connections still in the front belong to no HTTP listener yet, so
  // nothing else closes them when the server closes.
  const pending = new Set<Socket>();

  const handOff = (socket: Socket) => {
    for (const handler of handlers) handler.call(server, socket);
  };

  const startTls = (socket: Socket) => {
    const secure = new TLSSocket(socket, {
      isServer: true,
      secureContext: options.secureContext,
      ALPNProtocols: ['http/1.1'],
    });
    const fail = () => secure.destroy();
    const timer = setTimeout(fail, handshakeTimeoutMs);
    secure.on('error', fail);
    // TLS reads the TCP handle directly; this only keeps a late error on the
    // raw socket from going unhandled.
    socket.on('error', fail);
    secure.once('close', () => {
      clearTimeout(timer);
      pending.delete(socket);
      socket.destroy();
    });
    secure.once('secure', () => {
      clearTimeout(timer);
      pending.delete(socket);
      // The HTTP server installs its own error handling on the socket it gets.
      secure.off('error', fail);
      handOff(secure);
    });
  };

  server.on('connection', (socket: Socket) => {
    pending.add(socket);
    const drop = () => socket.destroy();
    const timer = setTimeout(drop, firstByteTimeoutMs);
    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', drop);
      socket.off('error', drop);
      socket.pause();
      socket.unshift(chunk);
      if (chunk[0] === TLS_HANDSHAKE_RECORD) {
        startTls(socket);
        return;
      }
      pending.delete(socket);
      if (!isLoopbackHost(socket.remoteAddress ?? '')) {
        socket.destroy();
        return;
      }
      handOff(socket);
      // The HTTP parser does not resume a socket paused before it got it.
      socket.resume();
    };
    socket.on('data', onData);
    // The server allows half-open sockets; a peer that ends before its first
    // byte would otherwise hold the socket open.
    socket.once('end', drop);
    socket.once('error', drop);
    socket.once('close', () => {
      clearTimeout(timer);
      pending.delete(socket);
    });
  });

  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    for (const socket of pending) socket.destroy();
    return close(callback);
  }) as Server['close'];
}
