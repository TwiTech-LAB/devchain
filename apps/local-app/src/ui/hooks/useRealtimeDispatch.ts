import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';
import { useHomeSocket } from './useHomeSocket';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
} from '@/ui/lib/realtime-invalidation-registry';

export interface RealtimeDispatchOptions {
  /** `home` for instance-level topics; defaults to the active project's socket. Fixed per call site. */
  socket?: 'project' | 'home';
}

export function useRealtimeDispatch(
  entries: RealtimeInvalidationRegistry,
  options: RealtimeDispatchOptions = {},
): void {
  const queryClient = useQueryClient();

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      dispatchRealtimeEnvelope(envelope, entries, queryClient);
    },
    [entries, queryClient],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);
  const useSocket = options.socket === 'home' ? useHomeSocket : useAppSocket;
  useSocket(handlers, [handleMessage]);
}
