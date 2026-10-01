import { useEffect, useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import type { BackendId } from '@/ui/lib/api-transport';
import { getAppSocket, releaseAppSocket } from '@/ui/lib/socket';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SocketHandlers = Record<string, (...args: any[]) => void>;

/**
 * Subscribes handlers to one backend's pooled socket with automatic cleanup.
 * Holds one ref on that socket for the component's lifetime.
 */
export function useBackendSocket(
  backendId: BackendId,
  handlers: SocketHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[] = [],
): Socket {
  const socket = useMemo<Socket>(() => getAppSocket(backendId), [backendId]);

  useEffect(() => () => releaseAppSocket(backendId), [backendId]);

  useEffect(() => {
    const entries = Object.entries(handlers || {});
    entries.forEach(([event, handler]) => {
      if (typeof handler === 'function') {
        socket.on(event, handler);
      }
    });

    return () => {
      entries.forEach(([event, handler]) => {
        if (typeof handler === 'function') {
          socket.off(event, handler);
        }
      });
    };
  }, [socket, ...deps]);

  return socket;
}
