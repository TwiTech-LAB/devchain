import type { Socket } from 'socket.io-client';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { useOptionalBackend } from '@/ui/lib/backend-context';
import { useBackendSocket, type SocketHandlers } from './useBackendSocket';

const NO_HANDLERS: SocketHandlers = {};

/**
 * The project socket: the active project's backend (home for a local project,
 * `/r/<remoteId>/socket.io` for a remote one). Never disconnect it in cleanup.
 *
 * While project routing is unknown it returns the pooled home socket with no handlers
 * attached, so nothing listens on a guessed backend; callers must not emit project
 * traffic before routing is known (the page and dock gates hold them back).
 */
export function useAppSocket(
  handlers: SocketHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[] = [],
): Socket {
  const backend = useOptionalBackend();
  const routingKnown = !backend || backend.ready;
  const backendId = routingKnown ? (backend?.activeBackend ?? HOME_BACKEND) : HOME_BACKEND;
  return useBackendSocket(backendId, routingKnown ? handlers : NO_HANDLERS, [
    routingKnown,
    ...deps,
  ]);
}
