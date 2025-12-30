import { useEffect } from 'react';
import { getAppSocket } from '@/ui/lib/socket';

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
) {
  useEffect(() => {
    const socket = getAppSocket();
    const host = containerRef.current;
    if (!socket || !host) return;

    const handleFocusIn = () => {
      if (socket.connected && isSubscribedRef.current) {
        socket.emit('terminal:focus', { sessionId });
      }
    };

    host.addEventListener('focusin', handleFocusIn, { capture: true });
    return () => host.removeEventListener('focusin', handleFocusIn, { capture: true });
  }, [sessionId, isSubscribedRef, containerRef]);
}
