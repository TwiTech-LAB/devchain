/** @jest-environment jsdom */

import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFetchFactory, createWorktreeFetch } from './useFetchFactory';
import {
  WORKTREE_PROXY_UNAVAILABLE_EVENT,
  type WorktreeProxyUnavailableDetail,
} from '@/ui/lib/worktree-fetch-interceptor';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('createWorktreeFetch', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('passes through requests unchanged when apiBase is empty', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('');
    await fetchFn('/api/epics');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/epics');
  });

  it('passes through requests unchanged when apiBase is whitespace', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('   ');
    await fetchFn('/api/epics');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/epics');
  });

  it('returns wrapped fetch when apiBase is set', () => {
    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    expect(fetchFn).not.toBe(global.fetch);
  });

  it('rewrites bare /api paths with apiBase prefix', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/epics?projectId=abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/wt/feature-auth/api/epics?projectId=abc');
  });

  it('does not rewrite /api/worktrees (main-instance prefix)', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/worktrees');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/worktrees');
  });

  it('does not rewrite /api/templates (main-instance prefix)', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/templates');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/templates');
  });

  it('does not rewrite /api/runtime (main-instance prefix)', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/runtime');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/runtime');
  });

  it('does not rewrite /api/registry/* (main-instance prefix)', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/registry/update-status');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/registry/update-status');
  });

  it('does not double-prefix already-prefixed /wt paths', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/wt/other/api/epics');

    expect(fetchMock.mock.calls[0][0]).toBe('/wt/other/api/epics');
  });

  it('does not rewrite non-api paths', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/health');

    expect(fetchMock.mock.calls[0][0]).toBe('/health');
  });

  it('preserves POST method and body', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/epics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/wt/feature-auth/api/epics');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('dispatches WORKTREE_PROXY_UNAVAILABLE_EVENT on 503 from proxy', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      const payload = {
        statusCode: 503,
        message: 'Worktree is not running',
        worktreeName: 'feature-auth',
      };
      return {
        ok: false,
        status: 503,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        } as Headers,
        clone: () => ({ json: async () => payload }) as Response,
        json: async () => payload,
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const events: WorktreeProxyUnavailableDetail[] = [];
    const handler = (e: Event) =>
      events.push((e as CustomEvent<WorktreeProxyUnavailableDetail>).detail);
    window.addEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handler);

    try {
      const fetchFn = createWorktreeFetch('/wt/feature-auth');
      await fetchFn('/api/epics');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toHaveLength(1);
      expect(events[0].statusCode).toBe(503);
      expect(events[0].worktreeName).toBe('feature-auth');
    } finally {
      window.removeEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handler);
    }
  });

  it('does not dispatch event for successful responses', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const events: WorktreeProxyUnavailableDetail[] = [];
    const handler = (e: Event) =>
      events.push((e as CustomEvent<WorktreeProxyUnavailableDetail>).detail);
    window.addEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handler);

    try {
      const fetchFn = createWorktreeFetch('/wt/feature-auth');
      await fetchFn('/api/epics');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handler);
    }
  });

  it('handles URL with hash', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL) => {
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const fetchFn = createWorktreeFetch('/wt/feature-auth');
    await fetchFn('/api/epics?projectId=abc#section');

    expect(fetchMock.mock.calls[0][0]).toBe('/wt/feature-auth/api/epics?projectId=abc#section');
  });
});

describe('useFetchFactory', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('returns a function that calls fetch', () => {
    const { result } = renderHook(() => useFetchFactory(), {
      wrapper: createWrapper(),
    });
    expect(typeof result.current).toBe('function');
  });
});
