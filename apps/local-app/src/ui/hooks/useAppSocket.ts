import { useEffect, useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import {
  getAppSocket,
  getWorktreeSocket,
  releaseAppSocket,
  releaseWorktreeSocket,
} from '@/ui/lib/socket';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';

/**
 * Subscribe to Socket.IO events with automatic cleanup. Returns the shared socket instance.
 * Automatically selects the worktree socket when a worktree tab is active.
 * Pass a map of event handlers and a deps array for effect re-binding.
 */
export function useAppSocket(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (...args: any[]) => void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[] = [],
  socketOverride?: Socket | null,
): Socket {
  const { activeWorktree } = useOptionalWorktreeTab();
  const worktreeName = useMemo(() => {
    const normalized = activeWorktree?.name?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
  }, [activeWorktree?.name]);

  const selectedSocket = useMemo<Socket>(() => {
    if (socketOverride) return socketOverride;
    if (worktreeName) return getWorktreeSocket(worktreeName);
    return getAppSocket();
  }, [socketOverride, worktreeName]);

  // Release ref-counted socket on change or unmount.
  useEffect(() => {
    if (socketOverride) return;
    return () => {
      if (worktreeName) {
        releaseWorktreeSocket(worktreeName);
      } else {
        releaseAppSocket();
      }
    };
  }, [socketOverride, worktreeName]);

  useEffect(() => {
    const entries = Object.entries(handlers || {});
    entries.forEach(([event, handler]) => {
      if (typeof handler === 'function') {
        selectedSocket.on(event, handler);
      }
    });

    return () => {
      entries.forEach(([event, handler]) => {
        if (typeof handler === 'function') {
          selectedSocket.off(event, handler);
        }
      });
    };
  }, [selectedSocket, ...deps]);

  return selectedSocket;
}
