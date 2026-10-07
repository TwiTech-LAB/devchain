import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBoardBulkEdit } from '@/ui/hooks/board/useBoardBulkEdit';
import type { Epic } from '@/ui/types/domain';

const mockToast = jest.fn();
const mockApiFetch = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => mockApiFetch,
}));

function createEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'parent-1',
    projectId: 'project-1',
    title: 'Parent',
    description: null,
    statusId: 'todo',
    version: 3,
    parentId: null,
    agentId: null,
    createdBy: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(projectId: string | null = 'project-1') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ selectedProjectId, revision }: { selectedProjectId: string | null; revision: number }) => {
      void revision;
      return useBoardBulkEdit({ selectedProjectId });
    },
    { wrapper, initialProps: { selectedProjectId: projectId, revision: 0 } },
  );
  return { ...hook, queryClient };
}

async function openLoadedSession(
  result: ReturnType<typeof createHarness>['result'],
  parent = createEpic(),
  children: Epic[] = [],
) {
  mockApiFetch.mockResolvedValueOnce(jsonResponse({ items: children }));
  act(() => result.current.open(parent));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
}

describe('useBoardBulkEdit', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockToast.mockReset();
  });

  it('rejects child targets and loads a snapshotted parent before current children', async () => {
    const parent = createEpic({ title: 'Original parent', tags: ['original'] });
    const child = createEpic({
      id: 'child-1',
      title: 'Current child',
      parentId: parent.id,
      version: 8,
    });
    const load = deferred<Response>();
    mockApiFetch.mockReturnValueOnce(load.promise);
    const { result } = createHarness();

    act(() => result.current.open(child));
    expect(result.current.isOpen).toBe(false);
    expect(mockApiFetch).not.toHaveBeenCalled();

    act(() => result.current.open(parent));
    parent.title = 'Refetched parent';
    parent.tags.push('refetched');
    await act(async () => load.resolve(jsonResponse({ items: [child] })));

    expect(result.current.rows.map((row) => row.epic.id)).toEqual(['parent-1', 'child-1']);
    expect(result.current.rows[0].epic).toMatchObject({
      title: 'Original parent',
      tags: ['original'],
    });
  });

  it('builds a payload from only changed fields and baseline versions', async () => {
    const child = createEpic({
      id: 'child-1',
      parentId: 'parent-1',
      statusId: 'todo',
      agentId: 'agent-1',
      version: 8,
    });
    const { result } = createHarness();
    await openLoadedSession(result, createEpic({ agentId: null, version: 3 }), [child]);
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

    act(() => {
      result.current.changeRow('parent-1', 'agentId', 'agent-2');
      result.current.changeRow('child-1', 'statusId', 'done');
    });
    act(() => result.current.submit());

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    const [, init] = mockApiFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      parentId: 'parent-1',
      updates: [
        { id: 'parent-1', version: 3, agentId: 'agent-2' },
        { id: 'child-1', version: 8, statusId: 'done' },
      ],
    });
  });

  it('sends no request for an unchanged draft and shows the current notice', async () => {
    const { result } = createHarness();
    await openLoadedSession(result);

    act(() => result.current.submit());

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({
      title: 'No changes',
      description: 'Update at least one epic before saving.',
    });
  });

  it('does not replace loaded rows or the draft during routine rerenders', async () => {
    const child = createEpic({ id: 'child-1', parentId: 'parent-1', version: 4 });
    const { result, rerender } = createHarness();
    await openLoadedSession(result, createEpic(), [child]);
    act(() => result.current.changeRow('child-1', 'agentId', 'agent-2'));

    rerender({ selectedProjectId: 'project-1', revision: 1 });

    expect(result.current.rows[1].agentId).toBe('agent-2');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('discards old loads after close and after a newer target session', async () => {
    const firstLoad = deferred<Response>();
    const secondLoad = deferred<Response>();
    const thirdLoad = deferred<Response>();
    mockApiFetch
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise)
      .mockReturnValueOnce(thirdLoad.promise);
    const { result } = createHarness();

    act(() => result.current.open(createEpic({ id: 'parent-1' })));
    act(() => result.current.close());
    await act(async () => firstLoad.resolve(jsonResponse({ items: [] })));
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.open(createEpic({ id: 'parent-2', title: 'Second' })));
    act(() => result.current.open(createEpic({ id: 'parent-3', title: 'Third' })));
    await act(async () => secondLoad.resolve(jsonResponse({ items: [] })));
    expect(result.current.rows[0].epic.id).toBe('parent-3');
    expect(result.current.isLoading).toBe(true);
    await act(async () => thirdLoad.resolve(jsonResponse({ items: [] })));
    expect(result.current.rows[0].epic.id).toBe('parent-3');
    expect(result.current.isLoading).toBe(false);
  });

  it('closes presentation immediately and discards loads when the project changes', async () => {
    const load = deferred<Response>();
    mockApiFetch.mockReturnValueOnce(load.promise);
    const { result, rerender } = createHarness();
    act(() => result.current.open(createEpic()));

    rerender({ selectedProjectId: 'project-2', revision: 0 });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.rows).toEqual([]);
    await act(async () => load.resolve(jsonResponse({ items: [createEpic({ id: 'late' })] })));
    expect(result.current.isOpen).toBe(false);
  });

  it('discards a pending load after unmount', async () => {
    const load = deferred<Response>();
    mockApiFetch.mockReturnValueOnce(load.promise);
    const { result, unmount } = createHarness();
    act(() => result.current.open(createEpic()));

    unmount();
    await act(async () => load.resolve(jsonResponse({ items: [] })));

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([['ordinary failure', 500, 'Failed to save']])(
    'keeps the dialog and draft on %s',
    async (_label, status, message) => {
      const { result } = createHarness();
      await openLoadedSession(result);
      mockApiFetch.mockResolvedValueOnce(jsonResponse({ message }, status));
      act(() => result.current.changeRow('parent-1', 'statusId', 'done'));

      act(() => result.current.submit());

      await waitFor(() => expect(result.current.error).toBe(message));
      expect(result.current.isOpen).toBe(true);
      expect(result.current.rows[0].statusId).toBe('done');
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: message,
        variant: 'destructive',
      });
    },
  );

  it('invalidates only the bulk contract keys before resetting a successful session', async () => {
    const { result, queryClient } = createHarness();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    await openLoadedSession(result);
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));
    act(() => result.current.changeRow('parent-1', 'agentId', 'agent-2'));

    act(() => result.current.submit());

    await waitFor(() => expect(result.current.isOpen).toBe(false));
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['epics'] });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: ['epics', 'parent-1', 'sub-counts'],
    });
    expect(invalidate).toHaveBeenNthCalledWith(3, {
      queryKey: ['epics', 'parent', 'parent-1'],
    });
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Updates applied',
      description: 'Bulk changes saved successfully.',
    });
  });
});
