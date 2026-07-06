import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { parseProviderModels, useProviderModels } from './useProviderModels';
import { parseProviderEfforts, useProviderEfforts } from './useProviderEfforts';

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

describe('provider model/effort parsers', () => {
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

  describe('parseProviderEfforts', () => {
    it('accepts string or {name} entries and reads the capability flags', () => {
      const result = parseProviderEfforts(
        { efforts: ['low', { name: 'high' }], supportsEffort: true, requiresModelForEffort: true },
        'p1',
      );
      expect(result).toEqual({
        efforts: [
          { id: 'p1:low:0', name: 'low' },
          { id: 'p1:high:1', name: 'high' },
        ],
        supportsEffort: true,
        requiresModelForEffort: true,
      });
    });

    it('returns the disabled-empty baseline for non-object payloads', () => {
      const empty = { efforts: [], supportsEffort: false, requiresModelForEffort: false };
      expect(parseProviderEfforts(null, 'p1')).toEqual(empty);
      expect(parseProviderEfforts([], 'p1')).toEqual(empty);
      expect(parseProviderEfforts({ efforts: 'nope' }, 'p1')).toEqual(empty);
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

  it('does not clear a still-valid selection', async () => {
    mockFetch({ '/api/providers/p1/models': [{ name: 'opus' }] });
    const onStale = jest.fn();
    const { result } = renderHook(
      () =>
        useProviderModels({
          providerId: 'p1',
          modelOverride: 'opus',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    // Allow the stale-clear effect a tick to (not) fire.
    await Promise.resolve();
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe('useProviderEfforts (gating matrix + stale-clear)', () => {
  it('exposes supportsEffort:false + empty catalog for a non-capable provider (hidden state)', async () => {
    mockFetch({ '/api/providers/agy/efforts': { efforts: [], supportsEffort: false } });
    const { result } = renderHook(
      () =>
        useProviderEfforts({
          providerId: 'agy',
          effortOverride: null,
          onStaleSelection: jest.fn(),
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.supportsEffort).toBe(false));
    expect(result.current.efforts).toEqual([]);
    expect(result.current.requiresModelForEffort).toBe(false);
  });

  it('exposes supportsEffort:true with an empty catalog (disabled "No effort levels configured")', async () => {
    mockFetch({ '/api/providers/p1/efforts': { efforts: [], supportsEffort: true } });
    const { result } = renderHook(
      () =>
        useProviderEfforts({
          providerId: 'p1',
          effortOverride: null,
          onStaleSelection: jest.fn(),
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.supportsEffort).toBe(true));
    expect(result.current.efforts).toEqual([]);
  });

  it('exposes requiresModelForEffort (disabled "Select a model first" when no resolvable model)', async () => {
    mockFetch({
      '/api/providers/opencode/efforts': {
        efforts: [{ name: 'high' }],
        supportsEffort: true,
        requiresModelForEffort: true,
      },
    });
    const { result } = renderHook(
      () =>
        useProviderEfforts({
          providerId: 'opencode',
          effortOverride: null,
          onStaleSelection: jest.fn(),
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.requiresModelForEffort).toBe(true));
    expect(result.current.efforts).toHaveLength(1);
  });

  it('clears a stale effort-override selection not present in the catalog', async () => {
    mockFetch({
      '/api/providers/p1/efforts': { efforts: [{ name: 'high' }], supportsEffort: true },
    });
    const onStale = jest.fn();
    renderHook(
      () =>
        useProviderEfforts({
          providerId: 'p1',
          effortOverride: 'medium',
          onStaleSelection: onStale,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(onStale).toHaveBeenCalledWith(null));
  });
});
