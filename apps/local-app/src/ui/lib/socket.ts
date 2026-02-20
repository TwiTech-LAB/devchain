import { io, type Socket } from 'socket.io-client';
import { getWsBaseUrl } from './config';

export interface WsEnvelope {
  topic: string;
  type: string;
  payload: unknown;
  ts: string;
}

interface WorktreeSocketEntry {
  socket: Socket;
  refCount: number;
}

let socketRef: Socket | null = null;
let socketRefCount = 0;
const worktreeSocketPool = new Map<string, WorktreeSocketEntry>();

function resolveWorktreeSocketPath(worktreeName: string): string {
  return `/wt/${encodeURIComponent(worktreeName)}/socket.io`;
}

function normalizeWorktreeName(worktreeName: string): string {
  const normalized = worktreeName.trim();
  if (!normalized) {
    throw new Error('worktreeName is required');
  }
  return normalized;
}

/**
 * Test hook: allow components to inject a socket instance.
 * In production, this is unused and the singleton is created via io().
 */
export function setAppSocket(socket: Socket | null) {
  socketRef = socket;
  socketRefCount = socket ? 1 : 0;
}

export function getAppSocket(): Socket {
  // Always reuse the existing instance to preserve single-connection invariant
  if (socketRef) {
    socketRefCount++;
    return socketRef;
  }

  const url = getWsBaseUrl();
  socketRef = io(url, {
    path: '/socket.io',
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

export function getWorktreeSocket(worktreeName: string): Socket {
  const normalizedName = normalizeWorktreeName(worktreeName);
  const existingEntry = worktreeSocketPool.get(normalizedName);
  if (existingEntry) {
    if (existingEntry.refCount <= 0) {
      console.warn(
        `[socket] worktree socket "${normalizedName}" had non-positive refCount; recovering to 1`,
      );
      existingEntry.refCount = 1;
      return existingEntry.socket;
    }
    existingEntry.refCount++;
    return existingEntry.socket;
  }

  const url = getWsBaseUrl();
  const path = resolveWorktreeSocketPath(normalizedName);
  const socket = io(url, {
    path,
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  socket.on('message', (envelope: unknown) => {
    const maybe = envelope as { topic?: string; type?: string };
    if (maybe?.topic === 'system' && maybe?.type === 'ping') {
      socket.emit('pong');
    }
  });

  worktreeSocketPool.set(normalizedName, {
    socket,
    refCount: 1,
  });

  return socket;
}

export function releaseWorktreeSocket(worktreeName: string): void {
  const normalizedName = normalizeWorktreeName(worktreeName);
  const entry = worktreeSocketPool.get(normalizedName);
  if (!entry) {
    return;
  }

  if (entry.refCount <= 0) {
    console.warn(
      `[socket] worktree socket "${normalizedName}" had non-positive refCount on release`,
    );
  }

  entry.refCount--;

  if (entry.refCount > 0) {
    return;
  }

  entry.socket.disconnect();
  worktreeSocketPool.delete(normalizedName);
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
