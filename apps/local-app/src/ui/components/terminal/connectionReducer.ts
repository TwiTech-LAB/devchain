import type { ConnState, ConnAction } from './types';

/**
 * Reducer for managing terminal connection state
 */
export function connectionReducer(state: ConnState, action: ConnAction): ConnState {
  switch (action.type) {
    case 'SOCKET_CONNECT':
      return { status: 'connected', srAnnouncement: 'Terminal connected' };
    case 'SOCKET_DISCONNECT':
      return {
        status: 'disconnected',
        srAnnouncement: 'Terminal disconnected. Attempting to reconnect.',
      };
    case 'SUBSCRIBE_ATTEMPT':
      return { ...state, status: 'subscribing' };
    case 'SEED_START':
      return { ...state, status: 'seeding' };
    case 'SEED_COMPLETE':
      return { ...state, status: 'connected' };
    case 'SEED_TIMEOUT':
      return { ...state, status: 'connected' };
    case 'ERROR':
      return { status: 'error', srAnnouncement: action.message ?? state.srAnnouncement };
    default:
      return state;
  }
}
