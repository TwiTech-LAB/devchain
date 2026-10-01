import type { Socket } from 'socket.io-client';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { getAppSocket } from '@/ui/lib/socket';

/** Callers pass their backend's socket; the home fallback serves the `setAppSocket` test seam. */
export function resolveTerminalSocket(socket?: Socket | null): Socket {
  return socket ?? getAppSocket(HOME_BACKEND);
}
