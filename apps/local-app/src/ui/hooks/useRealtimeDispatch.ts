import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
} from '@/ui/lib/realtime-invalidation-registry';

export function useRealtimeDispatch(entries: RealtimeInvalidationRegistry): void {
  const queryClient = useQueryClient();

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      dispatchRealtimeEnvelope(envelope, entries, queryClient);
    },
    [entries, queryClient],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);
  useAppSocket(handlers, [handleMessage]);
}
