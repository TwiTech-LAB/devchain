import type { Socket } from 'socket.io-client';

/**
 * Terminal component types and interfaces
 */

export interface ChatTerminalProps {
  sessionId: string;
  socket: Socket | null;
  className?: string;
  chrome?: 'default' | 'none';
  ariaLabel?: string;
  onSessionEnded?: (payload: SessionStatePayload) => void;
}

export interface SessionStatePayload {
  sessionId: string;
  status: 'started' | 'ended' | 'crashed' | 'timeout';
  message?: string;
}

export type ConnStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'subscribing'
  | 'seeding'
  | 'error';

export type ConnAction =
  | { type: 'SOCKET_CONNECT' }
  | { type: 'SOCKET_DISCONNECT' }
  | { type: 'SUBSCRIBE_ATTEMPT' }
  | { type: 'SEED_START' }
  | { type: 'SEED_COMPLETE' }
  | { type: 'SEED_TIMEOUT' }
  | { type: 'ERROR'; message?: string };

export interface ConnState {
  status: ConnStatus;
  srAnnouncement: string;
}
