import type { Socket } from 'socket.io-client';
import { getAppSocket } from '@/ui/lib/socket';

export function resolveTerminalSocket(socket?: Socket | null): Socket {
  return socket ?? getAppSocket();
}
