import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { useAllProjects, useWorkspaces } from './useAllProjects';

const mockApiFetch = jest.fn();
jest.mock('@/ui/lib/api-transport', () => {
  const actual = jest.requireActual('@/ui/lib/api-transport');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function project(id: string, workspaceId: string) {
  return {
    id,
    workspaceId,
    name: `Project ${id}`,
    description: null,
    rootPath: `/work/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function respond(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

// Layer: UI hook unit (Jest). The contract is the request shape and the
// truncation flag; a rendered page would add nothing the hook does not own.
describe('useAllProjects', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('lists every workspace with one request and no per-project stats', async () => {
    mockApiFetch.mockResolvedValue(
      respond({ items: [project('p1', 'w1'), project('p2', 'w2')], total: 2 }),
    );

    const { result } = renderHook(() => useAllProjects(), { wrapper });

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/projects?limit=1000', expect.anything(), {
      backend: HOME_BACKEND,
    });
    expect(result.current.truncated).toBe(false);
    expect(result.current.total).toBe(2);
  });

  it('reports when the server holds more projects than it returned', async () => {
    mockApiFetch.mockResolvedValue(respond({ items: [project('p1', 'w1')], total: 1500 }));

    const { result } = renderHook(() => useAllProjects(), { wrapper });

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.total).toBe(1500);
    expect(result.current.truncated).toBe(true);
  });

  it('surfaces a failed request', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useAllProjects(), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.projects).toEqual([]);
  });
});

describe('useWorkspaces', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('reads the plain workspace array', async () => {
    mockApiFetch.mockResolvedValue(respond([{ id: 'w1', name: 'Main', isDefault: true }]));

    const { result } = renderHook(() => useWorkspaces(), { wrapper });

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/workspaces', expect.anything(), {
      backend: HOME_BACKEND,
    });
  });
});

describe('malformed answers', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('reads a non-array workspaces answer as no workspaces', async () => {
    mockApiFetch.mockResolvedValue(respond({}));
    const { result } = renderHook(() => useWorkspaces(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workspaces).toEqual([]);
  });

  it('reads a projects answer without items as no projects', async () => {
    mockApiFetch.mockResolvedValue(respond({}));
    const { result } = renderHook(() => useAllProjects(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toEqual([]);
    expect(result.current.truncated).toBe(false);
  });
});
