/** @jest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createApiFetch, buildApiUrl } from '@/ui/lib/api-transport';
import { BackendContext, type BackendContextValue } from '@/ui/lib/backend-context';
import { useFetchFactory, useHomeFetch } from './useFetchFactory';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useFetchFactory', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('returns a callable fetch function', () => {
    const { result } = renderHook(() => useFetchFactory(), { wrapper: createWrapper() });
    expect(typeof result.current).toBe('function');
  });

  it('forwards the request to window.fetch unchanged', async () => {
    const fetchMock = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({ ok: true, json: async () => ({}) }) as Response,
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useFetchFactory(), { wrapper: createWrapper() });
    const init = { method: 'POST', body: JSON.stringify({ title: 'test' }) };
    await result.current('/api/epics?projectId=abc', init);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/epics?projectId=abc');
    expect(fetchMock.mock.calls[0][1]).toBe(init);
  });

  it('returns a stable function identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useFetchFactory(), { wrapper: createWrapper() });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('routes requests of a remote-bound active project through the /r proxy', async () => {
    const fetchMock = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({ ok: true, json: async () => ({}) }) as Response,
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const bindings = new Map([['p1', 'remote-1']]);
    const value: BackendContextValue = {
      activeBackend: 'remote-1',
      activeRemote: null,
      bindings,
      ready: true,
      bindingsError: null,
      retry: jest.fn(),
      apiFetch: createApiFetch(() => ({ bindings, activeProjectId: 'p1', authority: 'known' })),
      buildApiUrl,
    };
    const QueryWrapper = createWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryWrapper>
        <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
      </QueryWrapper>
    );

    const { result } = renderHook(() => useFetchFactory(), { wrapper });
    await result.current('/api/epics/e1');
    await result.current('/api/projects/p1');

    expect(fetchMock.mock.calls[0][0]).toBe('/r/remote-1/api/epics/e1');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/p1');
  });

  it('useHomeFetch keeps project-routed paths on home even under a remote backend context', async () => {
    const fetchMock = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ({ ok: true, json: async () => ({}) }) as Response,
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const bindings = new Map([['p1', 'remote-1']]);
    const value: BackendContextValue = {
      activeBackend: 'remote-1',
      activeRemote: null,
      bindings,
      ready: true,
      bindingsError: null,
      retry: jest.fn(),
      apiFetch: createApiFetch(() => ({ bindings, activeProjectId: 'p1', authority: 'known' })),
      buildApiUrl,
    };
    const QueryWrapper = createWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryWrapper>
        <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
      </QueryWrapper>
    );

    const { result } = renderHook(() => useHomeFetch(), { wrapper });
    await result.current('/api/skills/sources');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/skills/sources');
  });

  it('useHomeFetch returns a stable function identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useHomeFetch(), { wrapper: createWrapper() });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
