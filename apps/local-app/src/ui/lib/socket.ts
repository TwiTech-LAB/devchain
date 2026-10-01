import { io, type Socket } from 'socket.io-client';
import { getWsBaseUrl } from './config';
import { HOME_BACKEND, buildApiUrl, type BackendId } from './api-transport';

export interface WsEnvelope {
  topic: string;
  type: string;
  payload: unknown;
  ts: string;
}

interface PoolEntry {
  socket: Socket;
  refCount: number;
  pingPongHandler: (envelope: unknown) => void;
}

// One ref-counted socket per backend: `home` connects to this origin's
// /socket.io, a remote to /r/<remoteId>/socket.io through the home proxy. With a
// local project active the home and project sockets are the same entry.
const pool = new Map<string, PoolEntry>();

function poolKey(backendId: BackendId): string {
  return backendId === HOME_BACKEND ? HOME_BACKEND : `remote:${backendId}`;
}

function socketPath(backendId: BackendId): string {
  return backendId === HOME_BACKEND ? '/socket.io' : buildApiUrl(backendId, '/socket.io');
}

function createPingPongHandler(socket: Socket): (envelope: unknown) => void {
  return (envelope: unknown) => {
    const maybe = envelope as { topic?: string; type?: string };
    if (maybe?.topic === 'system' && maybe?.type === 'ping') {
      socket.emit('pong');
    }
  };
}

/**
 * Acquires one ref on a backend's pooled socket; pair with `releaseAppSocket`
 * for the same backend.
 */
export function getAppSocket(backendId: BackendId): Socket {
  const key = poolKey(backendId);
  const existing = pool.get(key);

  if (existing) {
    if (existing.refCount <= 0) {
      console.warn(`[socket] ${key} socket had non-positive refCount; recovering to 1`);
      existing.refCount = 1;
    } else {
      existing.refCount++;
    }
    return existing.socket;
  }

  const socket = io(getWsBaseUrl(), {
    path: socketPath(backendId),
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  const pingPongHandler = createPingPongHandler(socket);
  socket.on('message', pingPongHandler);

  pool.set(key, { socket, refCount: 1, pingPongHandler });

  return socket;
}

export function releaseAppSocket(backendId: BackendId): void {
  const key = poolKey(backendId);
  const entry = pool.get(key);
  if (!entry) return;

  if (entry.refCount <= 0) {
    console.warn(`[socket] ${key} socket had non-positive refCount on release`);
  }

  entry.refCount--;

  if (entry.refCount > 0) return;

  entry.socket.off('message', entry.pingPongHandler);
  entry.socket.disconnect();
  pool.delete(key);
}

/** Test seam: replaces the pooled home socket (null clears it). */
export function setAppSocket(socket: Socket | null) {
  const existing = pool.get(HOME_BACKEND);
  if (existing) {
    existing.socket.off('message', existing.pingPongHandler);
  }

  if (socket) {
    const pingPongHandler = createPingPongHandler(socket);
    pool.set(HOME_BACKEND, { socket, refCount: 1, pingPongHandler });
  } else {
    pool.delete(HOME_BACKEND);
  }
}
