import { io, type Socket } from 'socket.io-client';
import { getWsBaseUrl } from './config';

export interface WsEnvelope {
  topic: string;
  type: string;
  payload: unknown;
  ts: string;
}

let socketRef: Socket | null = null;
let socketRefCount = 0;

/**
 * Test hook: allow components to inject a socket instance.
 * In production, this is unused and the singleton is created via io().
 */
export function setAppSocket(socket: Socket | null) {
  socketRef = socket;
}

export function getAppSocket(): Socket {
  // Always reuse the existing instance to preserve single-connection invariant
  if (socketRef) {
    socketRefCount++;
    return socketRef;
  }

  const url = getWsBaseUrl();
  socketRef = io(url, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });
  // Respond to server heartbeat pings so long-lived pages (e.g., Board) stay connected
  socketRef.on('message', (envelope: unknown) => {
    const maybe = envelope as { topic?: string; type?: string };
    if (maybe?.topic === 'system' && maybe?.type === 'ping') {
      socketRef?.emit('pong');
    }
  });
  socketRefCount = 1;
  return socketRef;
}

/**
 * Release a reference to the socket. When all references are released,
 * disconnect and clean up. This prevents phantom connections in React Strict Mode.
 */
export function releaseAppSocket(): void {
  if (!socketRef) return;

  socketRefCount--;

  if (socketRefCount <= 0) {
    socketRef.disconnect();
    socketRef = null;
    socketRefCount = 0;
  }
}
