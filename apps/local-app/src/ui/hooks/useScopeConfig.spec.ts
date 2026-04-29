import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement } from 'react';
import { useScopeConfig, scopeQueryKeys } from './useScopeConfig';
import { useSaveScopeConfig } from './useSaveScopeConfig';
import type { FolderScopeEntry } from '@/modules/codebase-overview-analyzer/types/scope.types';
import type { ScopeConfigResponse } from './useScopeConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    json: async () => data,
    status,
  } as Response;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { Wrapper, queryClient };
}

const mockEntries: FolderScopeEntry[] = [
  { folder: 'node_modules', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: 'src', purpose: 'source', reason: 'Auto-detected', origin: 'default' },
  { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
];

const mockResponse: ScopeConfigResponse = {
  entries: mockEntries,
  storageMode: 'local-only',
};

// ---------------------------------------------------------------------------
// useScopeConfig
// ---------------------------------------------------------------------------

describe('useScopeConfig', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches scope config for the given projectId', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(mockResponse)) as typeof fetch;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useScopeConfig('p1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockResponse);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/api/projects/p1/codebase-overview/scope');
  });

  it('does not fetch when projectId is null', () => {
    global.fetch = jest.fn() as typeof fetch;
    const { Wrapper } = createWrapper();

    renderHook(() => useScopeConfig(null), { wrapper: Wrapper });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns entries and storageMode from response', async () => {
    const repoResponse: ScopeConfigResponse = { entries: mockEntries, storageMode: 'repo-file' };
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(repoResponse)) as typeof fetch;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useScopeConfig('p1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.storageMode).toBe('repo-file');
    expect(result.current.data?.entries).toHaveLength(3);
  });

  it('exposes scopeQueryKeys with correct shape', () => {
    expect(scopeQueryKeys.config('p1')).toEqual(['codebase-overview', 'p1', 'scope']);
  });
});

// ---------------------------------------------------------------------------
// useSaveScopeConfig
// ---------------------------------------------------------------------------

describe('useSaveScopeConfig', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls PUT with only user-origin entries', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(mockResponse)) as typeof fetch;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSaveScopeConfig('p1'), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(mockEntries);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/api/projects/p1/codebase-overview/scope');
    expect(options.method).toBe('PUT');

    const body = JSON.parse(options.body as string) as { entries: FolderScopeEntry[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.origin).toBe('user');
    expect(body.entries[0]!.folder).toBe('dist');
  });

  it('sends empty entries array when all entries are non-user origin', async () => {
    const allDefaults: FolderScopeEntry[] = [
      { folder: 'node_modules', purpose: 'excluded', reason: 'default', origin: 'default' },
      { folder: 'src', purpose: 'source', reason: 'auto', origin: 'default' },
    ];
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ entries: [], storageMode: 'local-only' })) as typeof fetch;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSaveScopeConfig('p1'), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(allDefaults);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body as string) as { entries: FolderScopeEntry[] };
    expect(body.entries).toHaveLength(0);
  });

  it('invalidates codebase-overview queries on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(mockResponse)) as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSaveScopeConfig('p1'), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(mockEntries);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['codebase-overview', 'p1'] }),
    );
  });

  it('surfaces PERMISSION_DENIED error to callers via mutation error', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          statusCode: 422,
          code: 'http_exception',
          message: 'Permission denied',
          details: { code: 'PERMISSION_DENIED', manualEditPath: '/repo/.devchain/overview.json' },
          timestamp: new Date().toISOString(),
          path: '/api/projects/p1/codebase-overview/scope',
        },
        422,
      ),
    ) as typeof fetch;
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useSaveScopeConfig('p1'), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate(mockEntries);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const error = result.current.error;
    expect(error).toBeDefined();
    expect(error?.status).toBe(422);
    expect(error?.payload?.details?.code).toBe('PERMISSION_DENIED');
  });
});
