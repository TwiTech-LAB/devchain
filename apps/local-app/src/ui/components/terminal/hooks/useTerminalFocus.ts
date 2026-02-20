import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { resolveTerminalSocket } from '../socket';

/**
 * Custom hook for managing terminal focus event handling.
 * Emits focus events to the server when the terminal container receives focus.
 *
 * @param containerRef - Ref to the terminal container element
 * @param sessionId - Terminal session ID
 * @param isSubscribedRef - Ref tracking subscription status
 */
export function useTerminalFocus(
  containerRef: React.RefObject<HTMLDivElement>,
  sessionId: string,
  isSubscribedRef: React.MutableRefObject<boolean>,
  socket?: Socket | null,
) {
  useEffect(() => {
    const activeSocket = resolveTerminalSocket(socket);
    const host = containerRef.current;
    if (!host) return;

    const handleFocusIn = () => {
      if (activeSocket.connected && isSubscribedRef.current) {
        activeSocket.emit('terminal:focus', { sessionId });
      }
    };

    host.addEventListener('focusin', handleFocusIn, { capture: true });
    return () => host.removeEventListener('focusin', handleFocusIn, { capture: true });
  }, [sessionId, isSubscribedRef, containerRef, socket]);
}
