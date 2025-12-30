import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { getAppSocket, releaseAppSocket } from '@/ui/lib/socket';

/**
 * Subscribe to Socket.IO events with automatic cleanup. Returns the shared socket instance.
 * Pass a map of event handlers and a deps array for effect re-binding.
 */
export function useAppSocket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (...args: any[]) => void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[] = [],
  socketOverride?: Socket | null,
): Socket {
  const socket = socketOverride ?? getAppSocket();

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

      // Release socket reference when component unmounts
      // Only disconnects when all components have unmounted (handles React Strict Mode)
      if (!socketOverride) {
        releaseAppSocket();
      }
    };
    // Note: socket is intentionally NOT in deps - we don't want to re-register
    // handlers when socket reference changes. The socket is stable and handlers
    // should only re-bind when deps change.
  }, deps);

  return socket;
}
