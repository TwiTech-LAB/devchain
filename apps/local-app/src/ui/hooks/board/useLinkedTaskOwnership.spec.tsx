import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useLinkedTaskOwnership } from './useLinkedTaskOwnership';

const fetchMock = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useLinkedTaskOwnership', () => {
  beforeEach(() => fetchMock.mockReset());

  it('resolves the Epic before requesting its exact owning project', async () => {
    const epicResponse = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/epics/epic-1') return epicResponse.promise;
      if (url === '/api/projects/project-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'project-2', workspaceId: 'workspace-2', name: 'Platform' }),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result } = renderHook(() => useLinkedTaskOwnership('epic-1'), { wrapper });
    expect(fetchMock).toHaveBeenCalledWith('/api/epics/epic-1', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/'),
      expect.anything(),
    );

    await act(async () =>
      epicResponse.resolve({
        ok: true,
        json: async () => ({ id: 'epic-1', projectId: 'project-2' }),
      }),
    );
    await waitFor(() => expect(result.current.project?.id).toBe('project-2'));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/epics/epic-1',
      '/api/projects/project-2',
    ]);
    expect(result.current.project).toEqual({
      id: 'project-2',
      workspaceId: 'workspace-2',
      name: 'Platform',
    });
  });

  it('performs no ownership request while disabled', () => {
    const { result } = renderHook(() => useLinkedTaskOwnership('epic-1', { enabled: false }), {
      wrapper,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.epic).toBeUndefined();
    expect(result.current.project).toBeUndefined();
  });
});
