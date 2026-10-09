import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { parseProviderModels, useProviderModels } from './useProviderModels';
import { useProviderEfforts } from './useProviderEfforts';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function mockFetch(map: Record<string, unknown>) {
  const fetchMock = jest.fn(async (url: string) => {
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const body = map[path];
    return { ok: body !== undefined, json: async () => body } as Response;
  });
  (global as { fetch: unknown }).fetch = fetchMock as unknown;
  return fetchMock;
}

describe('provider model parser', () => {
  describe('parseProviderModels', () => {
    it('parses entries with a name and synthesizes a stable id when missing', () => {
      const result = parseProviderModels(
        [{ name: 'claude-sonnet' }, { id: 'x', name: 'opus' }],
        'p1',
      );
      expect(result).toEqual([
        { id: 'p1:claude-sonnet:0', name: 'claude-sonnet' },
        { id: 'x', name: 'opus' },
      ]);
    });

    it('rejects non-array payloads and entries without a usable name', () => {
      expect(parseProviderModels(null, 'p1')).toEqual([]);
      expect(parseProviderModels([{ name: '   ' }, { id: 'x' }, 5, null], 'p1')).toEqual([]);
    });
  });
});

describe('useProviderModels', () => {
  it('fetches and parses the model catalog for a provider', async () => {
    mockFetch({ '/api/providers/p1/models': [{ name: 'opus' }] });
    const { result } = renderHook(
      () =>
        useProviderModels({
          providerId: 'p1',
          modelOverride: null,
          onStaleSelection: jest.fn(),
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(result.current.models[0]).toMatchObject({ name: 'opus' });
  });

  it('clears a stale model-override selection not present in the catalog', async () => {
    mockFetch({ '/api/providers/p1/models': [{ name: 'opus' }] });
    const onStale = jest.fn();
    renderHook(
      () =>
        useProviderModels({
          providerId: 'p1',
          modelOverride: 'gone',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(onStale).toHaveBeenCalledWith(null));
  });

  it('keeps a selection whose catalog row differs only in case', async () => {
    mockFetch({ '/api/providers/p1/models': [{ name: 'SONNET-4' }] });
    const onStale = jest.fn();
    const { result } = renderHook(
      () =>
        useProviderModels({
          providerId: 'p1',
          modelOverride: 'sonnet-4',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    await Promise.resolve();
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe('useProviderEfforts (gating matrix + stale-clear)', () => {
  it.each([
    {
      label: 'non-capable provider',
      id: 'agy',
      payload: { efforts: [], supportsEffort: false, requiresModelForEffort: false },
    },
    {
      label: 'empty supported catalog',
      id: 'p1',
      payload: { efforts: [], supportsEffort: true, requiresModelForEffort: false },
    },
    {
      label: 'model required',
      id: 'opencode',
      payload: {
        efforts: [{ providerId: 'opencode', name: 'high' }],
        supportsEffort: true,
        requiresModelForEffort: true,
      },
    },
  ] as const)('$label', async ({ id, payload }) => {
    const fetchMock = mockFetch({
      [`/api/providers/${id}/efforts`]: {
        ...payload,
        efforts: payload.efforts.map((effort) => ({ ...effort, providerId: id })),
      },
    });
    const { result } = renderHook(
      () =>
        useProviderEfforts({ providerId: id, effortOverride: null, onStaleSelection: jest.fn() }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(result.current.efforts).toEqual(
        payload.efforts.map(({ name }, index) => ({ id: `${id}:${name}:${index}`, name })),
      );
      expect(result.current.supportsEffort).toBe(payload.supportsEffort);
      expect(result.current.requiresModelForEffort).toBe(payload.requiresModelForEffort);
    });
  });

  it('clears a stale effort-override selection not present in the catalog', async () => {
    mockFetch({
      '/api/providers/p1/efforts': {
        efforts: [{ providerId: 'p1', name: 'high' }],
        supportsEffort: true,
      },
    });
    const onStale = jest.fn();
    const { rerender } = renderHook(
      () =>
        useProviderEfforts({
          providerId: 'p1',
          effortOverride: 'medium',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(onStale).toHaveBeenCalledWith(null));
    rerender();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('keeps an effort selection whose catalog row differs only in case', async () => {
    mockFetch({
      '/api/providers/p1/efforts': {
        efforts: [{ providerId: 'p1', name: 'high' }],
        supportsEffort: true,
      },
    });
    const onStale = jest.fn();
    const { result } = renderHook(
      () =>
        useProviderEfforts({
          providerId: 'p1',
          effortOverride: 'High',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.efforts).toHaveLength(1));
    await Promise.resolve();
    expect(onStale).not.toHaveBeenCalled();
  });
});
