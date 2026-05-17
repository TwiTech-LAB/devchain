import { io, type Socket } from 'socket.io-client';
import { getWsBaseUrl } from './config';

export interface WsEnvelope {
  topic: string;
  type: string;
  payload: unknown;
  ts: string;
}

export type SocketAddress = 'main' | { worktree: string };

interface PoolEntry {
  socket: Socket;
  refCount: number;
  pingPongHandler: (envelope: unknown) => void;
}

const pool = new Map<string, PoolEntry>();

function addressKey(address: SocketAddress): string {
  return address === 'main' ? '__main__' : `wt:${address.worktree}`;
}

function addressPath(address: SocketAddress): string {
  return address === 'main'
    ? '/socket.io'
    : `/wt/${encodeURIComponent(address.worktree)}/socket.io`;
}

function createPingPongHandler(socket: Socket): (envelope: unknown) => void {
  return (envelope: unknown) => {
    const maybe = envelope as { topic?: string; type?: string };
    if (maybe?.topic === 'system' && maybe?.type === 'ping') {
      socket.emit('pong');
    }
  };
}

function normalizeWorktreeName(worktreeName: string): string {
  const normalized = worktreeName.trim();
  if (!normalized) {
    throw new Error('worktreeName is required');
  }
  return normalized;
}

export function getSocket(address: SocketAddress): Socket {
  const key = addressKey(address);
  const existing = pool.get(key);

  if (existing) {
    if (existing.refCount <= 0) {
      console.warn(`[socket] pool entry "${key}" had non-positive refCount; recovering to 1`);
      existing.refCount = 1;
    } else {
      existing.refCount++;
    }
    return existing.socket;
  }

  const url = getWsBaseUrl();
  const path = addressPath(address);
  const socket = io(url, {
    path,
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

export function releaseSocket(address: SocketAddress): void {
  const key = addressKey(address);
  const entry = pool.get(key);
  if (!entry) return;

  if (entry.refCount <= 0) {
    console.warn(`[socket] pool entry "${key}" had non-positive refCount on release`);
  }

  entry.refCount--;

  if (entry.refCount > 0) return;

  entry.socket.off('message', entry.pingPongHandler);
  entry.socket.disconnect();
  pool.delete(key);
}

export function setAppSocket(socket: Socket | null) {
  const key = addressKey('main');
  const existing = pool.get(key);
  if (existing) {
    existing.socket.off('message', existing.pingPongHandler);
  }

  if (socket) {
    const pingPongHandler = createPingPongHandler(socket);
    pool.set(key, { socket, refCount: 1, pingPongHandler });
  } else {
    pool.delete(key);
  }
}

export function getAppSocket(): Socket {
  return getSocket('main');
}

export function releaseAppSocket(): void {
  releaseSocket('main');
}

export function getWorktreeSocket(worktreeName: string): Socket {
  const normalizedName = normalizeWorktreeName(worktreeName);
  return getSocket({ worktree: normalizedName });
}

export function releaseWorktreeSocket(worktreeName: string): void {
  const normalizedName = normalizeWorktreeName(worktreeName);
  releaseSocket({ worktree: normalizedName });
}
