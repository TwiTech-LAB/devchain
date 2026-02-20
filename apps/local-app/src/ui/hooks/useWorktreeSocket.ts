import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { getWorktreeSocket, releaseWorktreeSocket } from '@/ui/lib/socket';

export interface UseWorktreeSocketResult {
  socket: Socket;
  release: () => void;
}

export function useWorktreeSocket(worktreeName: string): UseWorktreeSocketResult {
  const normalizedName = useMemo(() => worktreeName.trim(), [worktreeName]);
  if (!normalizedName) {
    throw new Error('useWorktreeSocket requires a non-empty worktreeName');
  }

  const releasedRef = useRef(false);
  const socket = useMemo(() => getWorktreeSocket(normalizedName), [normalizedName]);

  const release = useCallback(() => {
    if (releasedRef.current) {
      return;
    }
    releasedRef.current = true;
    releaseWorktreeSocket(normalizedName);
  }, [normalizedName]);

  useEffect(() => {
    releasedRef.current = false;
    return () => {
      if (releasedRef.current) {
        return;
      }
      releasedRef.current = true;
      releaseWorktreeSocket(normalizedName);
    };
  }, [normalizedName]);

  return {
    socket,
    release,
  };
}
