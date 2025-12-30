import { useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { getAppSocket } from '@/ui/lib/socket';
import { termLog } from '@/ui/lib/debug';

/**
 * Custom hook for managing terminal session subscription.
 * Provides idempotent subscription logic with proper precondition checks.
 *
 * @param sessionId - Terminal session ID
 * @param xtermRef - React ref to the xterm Terminal instance
 * @param dispatchConn - Connection state dispatcher
 * @returns Object containing refs and subscription function
 */
export function useTerminalSubscription(
  sessionId: string,
  xtermRef: React.RefObject<Terminal | null>,
  dispatchConn: React.Dispatch<{
    type:
      | 'SOCKET_CONNECT'
      | 'SOCKET_DISCONNECT'
      | 'SUBSCRIBE_ATTEMPT'
      | 'SEED_START'
      | 'SEED_COMPLETE'
      | 'SEED_TIMEOUT'
      | 'ERROR';
    message?: string;
  }>,
) {
  const lastSequenceRef = useRef<number>(0);
  const isSubscribedRef = useRef<boolean>(false);
  const expectingSeedRef = useRef<boolean>(false);
  // Tracks whether this ChatTerminal instance has ever successfully sent a subscribe.
  // Used to decide when to request a full seed vs. replay, independent of lastSequenceRef.
  const hasEverSubscribedRef = useRef<boolean>(false);

  /**
   * Attempts to subscribe to terminal session if all preconditions are met.
   * Idempotent - safe to call multiple times.
   *
   * This consolidates subscription logic that was previously duplicated in:
   * 1. Terminal init effect (when socket already connected)
   * 2. Socket connect handler (when socket connects after mount)
   */
  const attemptSubscription = useCallback(() => {
    const socket = getAppSocket();
    const terminal = xtermRef.current;

    // Guard: Check preconditions
    if (!socket.connected) {
      termLog('subscribe_blocked', {
        reason: 'socket_not_connected',
        sessionId,
        socketId: socket.id,
      });
      return false;
    }

    if (!terminal || !terminal.cols || !terminal.rows) {
      termLog('subscribe_blocked', {
        reason: 'terminal_not_ready',
        sessionId,
        hasTerminal: !!terminal,
        cols: terminal?.cols,
        rows: terminal?.rows,
      });
      return false;
    }

    if (isSubscribedRef.current) {
      termLog('subscribe_blocked', {
        reason: 'already_subscribed',
        sessionId,
      });
      return false;
    }

    // Perform subscription
    dispatchConn({ type: 'SUBSCRIBE_ATTEMPT' });

    // First attach is scoped to this ChatTerminal instance, not just sequence number.
    // We always want a full tmux seed for the first subscription of a fresh xterm,
    // even if lastSequenceRef was non-zero from a prior view.
    const isFirstAttach = !hasEverSubscribedRef.current;

    const lastSequenceToSend =
      !isFirstAttach && lastSequenceRef.current > 0 ? lastSequenceRef.current : undefined;

    termLog('subscribe_attempt', {
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
      socketId: socket.id,
      lastSequence: lastSequenceToSend ?? 0,
      isFirstAttach,
    });

    // Mark that we're expecting a seed (only on first attach)
    if (isFirstAttach) {
      expectingSeedRef.current = true;
    }

    socket.emit('terminal:subscribe', {
      sessionId,
      lastSequence: lastSequenceToSend,
      cols: terminal.cols,
      rows: terminal.rows,
    });

    socket.emit('terminal:focus', { sessionId });
    // Note: Resize is handled by server during subscribe (using cols/rows from payload)
    // No need to emit separate resize - it would be deduplicated anyway

    termLog('subscribe_success', { sessionId, expectingSeed: expectingSeedRef.current });
    hasEverSubscribedRef.current = true;
    return true;
  }, [sessionId, xtermRef, dispatchConn]);

  return {
    lastSequenceRef,
    isSubscribedRef,
    expectingSeedRef,
    attemptSubscription,
  };
}
