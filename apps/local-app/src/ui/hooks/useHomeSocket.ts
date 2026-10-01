import type { Socket } from 'socket.io-client';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { useBackendSocket, type SocketHandlers } from './useBackendSocket';

/** The home socket, for instance-level topics (`remotes`, `cloud`) whatever project is active. */
export function useHomeSocket(
  handlers: SocketHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[] = [],
): Socket {
  return useBackendSocket(HOME_BACKEND, handlers, deps);
}
