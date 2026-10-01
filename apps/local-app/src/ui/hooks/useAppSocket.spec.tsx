/** @jest-environment jsdom */

import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { buildApiUrl, createApiFetch } from '@/ui/lib/api-transport';
import { BackendContext, type BackendContextValue } from '@/ui/lib/backend-context';
import { getAppSocket, releaseAppSocket } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';

interface MockSocket {
  backendId: string;
  on: jest.Mock;
  off: jest.Mock;
}

const sockets = new Map<string, MockSocket>();

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn((backendId: string) => {
    let socket = sockets.get(backendId);
    if (!socket) {
      socket = { backendId, on: jest.fn(), off: jest.fn() };
      sockets.set(backendId, socket);
    }
    return socket;
  }),
  releaseAppSocket: jest.fn(),
}));

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';

function backendValue(ready: boolean): BackendContextValue {
  const bindings = new Map([['p1', REMOTE_ID]]);
  return {
    activeBackend: REMOTE_ID,
    activeRemote: null,
    bindings,
    ready,
    bindingsError: null,
    retry: jest.fn(),
    apiFetch: createApiFetch(() => ({
      bindings,
      activeProjectId: 'p1',
      authority: ready ? 'known' : 'unknown',
    })),
    buildApiUrl,
  };
}

function renderWithBackend(ready: boolean, handler: () => void) {
  let value = backendValue(ready);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
  );
  const view = renderHook(() => useAppSocket({ message: handler }), { wrapper });
  return {
    ...view,
    setReady(next: boolean) {
      value = backendValue(next);
      view.rerender();
    },
  };
}

beforeEach(() => {
  sockets.clear();
  jest.mocked(getAppSocket).mockClear();
  jest.mocked(releaseAppSocket).mockClear();
});

describe('useAppSocket', () => {
  it('attaches no handlers to any backend socket while routing is unknown', () => {
    const handler = jest.fn();
    const { result } = renderWithBackend(false, handler);

    expect(getAppSocket).not.toHaveBeenCalledWith(REMOTE_ID);
    expect(result.current).toBe(sockets.get('home'));
    for (const socket of sockets.values()) {
      expect(socket.on).not.toHaveBeenCalled();
    }
  });

  it('moves to the resolved backend and attaches its handlers once routing is known', () => {
    const handler = jest.fn();
    const view = renderWithBackend(false, handler);

    view.setReady(true);

    const remote = sockets.get(REMOTE_ID);
    expect(view.result.current).toBe(remote);
    expect(remote?.on).toHaveBeenCalledWith('message', handler);
    expect(sockets.get('home')?.on).not.toHaveBeenCalled();
    expect(releaseAppSocket).toHaveBeenCalledWith('home');
  });

  it('uses the home socket outside a BackendProvider', () => {
    const handler = jest.fn();
    const { result } = renderHook(() => useAppSocket({ message: handler }));

    expect(result.current).toBe(sockets.get('home'));
    expect(sockets.get('home')?.on).toHaveBeenCalledWith('message', handler);
  });
});
