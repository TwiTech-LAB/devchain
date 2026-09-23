import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ExternalTaskDetail,
  ExternalTaskImportResponse,
} from '@/modules/external-integrations/models/external-provider.models';
import { externalMyWorkQueryKeys, epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalTaskImport } from './useExternalTaskImport';

const fetchMock = jest.fn();

// Layer: hook + real QueryClient. This proves the minimal wire response still drives
// both new/duplicate navigation data and the current epoch's batch-link cache update.
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const projectId = '11111111-1111-4111-8111-111111111111';
const statusId = '22222222-2222-4222-8222-222222222222';
const connectionEpoch = 'connection-jira-a:1';
const projectBId = '44444444-4444-4444-8444-444444444444';
const connectionEpochB = 'connection-jira-b:2';
const detail: ExternalTaskDetail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Remote title',
  description: 'Remote description',
  descriptionTruncated: false,
  status: { remoteId: '1', name: 'In Progress', color: '#777777', category: 'active', position: 0 },
  dueAt: null,
  priority: null,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: '42', workAreaName: 'Delivery' },
  allowedStatuses: [],
  actions: [],
  linkState: { linked: false, epicId: null },
};
const detailB: ExternalTaskDetail = {
  ...detail,
  remoteId: 'OTHER-2',
  remoteKey: 'OTHER-2',
  title: 'Project B task',
  webUrl: 'https://other.atlassian.net/browse/OTHER-2',
  location: {
    scopeKey: 'other.atlassian.net',
    workAreaId: '84',
    workAreaName: 'Other delivery',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

function linkCacheItem(taskDetail: ExternalTaskDetail) {
  return {
    scopeKey: taskDetail.location.scopeKey,
    taskId: taskDetail.remoteId,
    linked: false,
    epicId: null,
    projectId: null,
    projectName: null,
    loggedMinutes: null,
  };
}

describe('useExternalTaskImport', () => {
  beforeEach(() => fetchMock.mockReset());

  it.each([true, false])(
    'returns the minimal public response and updates links when created=%s',
    async (created) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const epicId = created ? 'epic-new' : 'epic-existing';
      const resultPayload: ExternalTaskImportResponse = {
        epic: { id: epicId, projectId },
        created,
      };
      const linkInputs = [{ scopeKey: detail.location.scopeKey, taskId: detail.remoteId }];
      const linkKey = [
        ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false),
        linkInputs,
      ] as const;
      client.setQueryData(linkKey, {
        items: [
          {
            ...linkInputs[0],
            linked: false,
            epicId: null,
            projectId: null,
            projectName: null,
          },
        ],
      });
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/statuses')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: [{ id: statusId, projectId, label: 'New', color: '#777777', position: 0 }],
            }),
          });
        }
        expect(init?.method).toBe('POST');
        return Promise.resolve({ ok: true, json: async () => resultPayload });
      });

      const { result } = renderHook(
        () =>
          useExternalTaskImport('jira', detail, projectId, {
            connectionEpoch,
            projectName: 'Product',
          }),
        { wrapper: wrapper(client) },
      );
      await waitFor(() => expect(result.current.statuses.isSuccess).toBe(true));

      let imported: ExternalTaskImportResponse | undefined;
      await act(async () => {
        imported = await result.current.mutation.mutateAsync({
          statusId,
          title: 'Edited title',
          description: 'Edited description',
        });
      });

      const importCall = fetchMock.mock.calls.find(
        ([url]) => url === '/api/epics/import-external-task',
      );
      expect(JSON.parse(importCall?.[1]?.body as string)).toEqual(
        expect.objectContaining({
          projectId,
          statusId,
          agentId: null,
          title: 'Edited title',
          description: 'Edited description',
          remote: expect.objectContaining({ title: 'Remote title', taskId: 'ENG-1' }),
        }),
      );
      expect(imported).toEqual({ created, epic: { id: epicId, projectId } });
      expect(client.getQueryData(linkKey)).toEqual({
        items: [
          {
            ...linkInputs[0],
            linked: true,
            epicId,
            projectId,
            projectName: 'Product',
          },
        ],
      });
      // A new stored source must stale every Board batch entry and the
      // Epic-detail source read.
      expect(client.getQueryState(epicExternalSourceQueryKeys.all)).toBeUndefined();
      const seededBatch = epicExternalSourceQueryKeys.batch(['epic-seed']);
      client.setQueryData(seededBatch, { items: [] });
      const invalidated: string[] = [];
      const originalInvalidate = client.invalidateQueries.bind(client);
      jest.spyOn(client, 'invalidateQueries').mockImplementation(async (filters) => {
        invalidated.push(JSON.stringify((filters as { queryKey: unknown }).queryKey));
        return originalInvalidate(filters as never);
      });
      await act(async () => {
        await result.current.mutation.mutateAsync({
          statusId,
          title: 'Again',
          description: 'Again',
        });
      });
      expect(invalidated).toContain(JSON.stringify(epicExternalSourceQueryKeys.all));
      client.clear();
    },
  );

  it('issues no project, status, or mutation request while disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () =>
        useExternalTaskImport('jira', detail, projectId, {
          enabled: false,
          connectionEpoch,
        }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.statuses.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    client.clear();
  });

  it('attributes a repeat import to the selected project and never another project', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const linkKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false),
      [{ scopeKey: detail.location.scopeKey, taskId: detail.remoteId }],
    ] as const;
    client.setQueryData(linkKey, {
      items: [
        {
          scopeKey: detail.location.scopeKey,
          taskId: detail.remoteId,
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
        },
      ],
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === `/api/statuses?projectId=${projectId}`) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [{ id: statusId, projectId, label: 'New', color: '#777', position: 0 }],
          }),
        });
      }
      if (url === '/api/epics/import-external-task') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            epic: { id: 'epic-existing', projectId },
            created: false,
          }),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result } = renderHook(
      () =>
        useExternalTaskImport('jira', detail, projectId, {
          connectionEpoch,
          projectName: 'Current project',
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.statuses.isSuccess).toBe(true));
    await act(async () => {
      await result.current.mutation.mutateAsync({
        statusId,
        title: detail.title,
        description: detail.description ?? '',
      });
    });

    // No cross-project attribution fetch runs: the selected project's own
    // Epic is the only possible result, and decoration uses only it.
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/projects/));
    expect(client.getQueryData(linkKey)).toEqual({
      items: [
        expect.objectContaining({
          linked: true,
          epicId: 'epic-existing',
          projectId,
          projectName: 'Current project',
        }),
      ],
    });
    client.clear();
  });

  it('reconciles a deferred Project A result only into captured A caches after rendering B', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const importResponse = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/statuses')) {
        return Promise.resolve(response({ items: [] }));
      }
      if (url === '/api/epics/import-external-task') return importResponse.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    const aInputs = [{ scopeKey: detail.location.scopeKey, taskId: detail.remoteId }];
    const bInputs = [{ scopeKey: detailB.location.scopeKey, taskId: detailB.remoteId }];
    const aLinkKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false),
      aInputs,
    ] as const;
    const bLinkKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpochB, false),
      bInputs,
    ] as const;
    client.setQueryData(aLinkKey, { items: [linkCacheItem(detail)] });
    client.setQueryData(bLinkKey, { items: [linkCacheItem(detailB)] });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const onSuccess = jest.fn();
    const hook = renderHook(
      ({ taskDetail, selectedProjectId, epoch, selectedProjectName }) =>
        useExternalTaskImport('jira', taskDetail, selectedProjectId, {
          connectionEpoch: epoch,
          projectName: selectedProjectName,
        }),
      {
        wrapper: wrapper(client),
        initialProps: {
          taskDetail: detail,
          selectedProjectId: projectId,
          epoch: connectionEpoch,
          selectedProjectName: 'Project A',
        },
      },
    );

    act(() =>
      hook.result.current.mutation.mutate(
        { statusId, title: 'Import A', description: 'A description' },
        { onSuccess },
      ),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));
    expect(hook.result.current.mutation.variables).toEqual(
      expect.objectContaining({
        scope: {
          projectId,
          provider: 'jira',
          connectionEpoch,
          taskId: detail.remoteId,
        },
        detail,
        form: { statusId, title: 'Import A', description: 'A description' },
        projectAttribution: { id: projectId, name: 'Project A' },
        cacheKeys: expect.objectContaining({
          links: externalMyWorkQueryKeys.links('jira', connectionEpoch),
          taskDetail: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, detail.remoteId),
        }),
        apiFetch: expect.any(Function),
      }),
    );

    hook.rerender({
      taskDetail: detailB,
      selectedProjectId: projectBId,
      epoch: connectionEpochB,
      selectedProjectName: 'Project B',
    });
    expect(hook.result.current.mutation).toEqual(
      expect.objectContaining({
        data: undefined,
        error: null,
        variables: undefined,
        status: 'idle',
        isIdle: true,
        isPending: false,
        isSuccess: false,
        isError: false,
      }),
    );

    await act(async () =>
      importResponse.resolve(response({ epic: { id: 'epic-from-a', projectId }, created: false })),
    );
    await waitFor(() =>
      expect(client.getQueryData(aLinkKey)).toEqual({
        items: [
          expect.objectContaining({
            linked: true,
            epicId: 'epic-from-a',
            projectId,
            projectName: 'Project A',
          }),
        ],
      }),
    );

    expect(client.getQueryData(bLinkKey)).toEqual({ items: [linkCacheItem(detailB)] });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(hook.result.current.mutation).toEqual(
      expect.objectContaining({ data: undefined, error: null, status: 'idle', isSuccess: false }),
    );
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey,
    );
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ['epics', projectId],
        externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, detail.remoteId),
        externalMyWorkQueryKeys.links('jira', connectionEpoch),
      ]),
    );
    expect(invalidatedKeys).not.toContainEqual(
      externalMyWorkQueryKeys.taskDetail('jira', connectionEpochB, detailB.remoteId),
    );
    expect(invalidatedKeys).not.toContainEqual(
      externalMyWorkQueryKeys.links('jira', connectionEpochB),
    );
    expect(invalidatedKeys).not.toContainEqual(epicExternalSourceQueryKeys.all);
    client.clear();
  });

  it('settles epoch N only against epoch N caches after the connection advances to N+1', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const nextEpoch = 'connection-jira-a:2';
    const importResponse = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/statuses')
        ? Promise.resolve(response({ items: [] }))
        : importResponse.promise,
    );
    const inputs = [{ scopeKey: detail.location.scopeKey, taskId: detail.remoteId }];
    const oldKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false),
      inputs,
    ] as const;
    const nextKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', nextEpoch, false),
      inputs,
    ] as const;
    client.setQueryData(oldKey, { items: [linkCacheItem(detail)] });
    client.setQueryData(nextKey, { items: [linkCacheItem(detail)] });
    const hook = renderHook(
      ({ epoch }) =>
        useExternalTaskImport('jira', detail, projectId, {
          connectionEpoch: epoch,
          projectName: 'Project A',
        }),
      {
        wrapper: wrapper(client),
        initialProps: { epoch: connectionEpoch },
      },
    );

    act(() =>
      hook.result.current.mutation.mutate({
        statusId,
        title: 'Old epoch',
        description: '',
      }),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));
    hook.rerender({ epoch: nextEpoch });
    expect(hook.result.current.mutation.isPending).toBe(false);

    await act(async () =>
      importResponse.resolve(
        response({ epic: { id: 'epic-old-epoch', projectId }, created: true }),
      ),
    );
    await waitFor(() =>
      expect(client.getQueryData(oldKey)).toEqual({
        items: [expect.objectContaining({ linked: true, epicId: 'epic-old-epoch' })],
      }),
    );
    expect(client.getQueryData(nextKey)).toEqual({ items: [linkCacheItem(detail)] });
    expect(hook.result.current.mutation.data).toBeUndefined();
    expect(hook.result.current.mutation.isSuccess).toBe(false);
    client.clear();
  });

  it('does not present a deferred Project A failure after rendering Project B', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const importResponse = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/statuses')
        ? Promise.resolve(response({ items: [] }))
        : importResponse.promise,
    );
    const onError = jest.fn();
    const hook = renderHook(
      ({ taskDetail, selectedProjectId, epoch }) =>
        useExternalTaskImport('jira', taskDetail, selectedProjectId, {
          connectionEpoch: epoch,
        }),
      {
        wrapper: wrapper(client),
        initialProps: {
          taskDetail: detail,
          selectedProjectId: projectId,
          epoch: connectionEpoch,
        },
      },
    );
    act(() =>
      hook.result.current.mutation.mutate(
        { statusId, title: 'Import A', description: '' },
        { onError },
      ),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));
    hook.rerender({
      taskDetail: detailB,
      selectedProjectId: projectBId,
      epoch: connectionEpochB,
    });

    await act(async () => importResponse.reject(new Error('Project A import failed')));
    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.mutation).toEqual(
      expect.objectContaining({
        data: undefined,
        error: null,
        variables: undefined,
        status: 'idle',
        isIdle: true,
        isPending: false,
        isSuccess: false,
        isError: false,
      }),
    );
    client.clear();
  });

  it('preserves each cached item loggedMinutes and never appends an absent identity', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const enrichedKey = [
      ...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, true),
      [
        { scopeKey: detail.location.scopeKey, taskId: detail.remoteId },
        { scopeKey: detail.location.scopeKey, taskId: 'ENG-9' },
      ],
    ] as const;
    client.setQueryData(enrichedKey, {
      items: [
        {
          scopeKey: detail.location.scopeKey,
          taskId: detail.remoteId,
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
          loggedMinutes: 75,
        },
        {
          scopeKey: detail.location.scopeKey,
          taskId: 'ENG-9',
          linked: false,
          epicId: null,
          projectId: null,
          projectName: null,
          loggedMinutes: 0,
        },
      ],
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/statuses')) {
        return Promise.resolve(response({ items: [] }));
      }
      if (url === '/api/epics/import-external-task') {
        return Promise.resolve(
          response({ epic: { id: 'epic-imported', projectId }, created: true }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result } = renderHook(
      () =>
        useExternalTaskImport('jira', detail, projectId, {
          connectionEpoch,
          projectName: 'Product',
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.statuses.isSuccess).toBe(true));
    await act(async () => {
      await result.current.mutation.mutateAsync({
        statusId,
        title: 'Import with checkpoint',
        description: '',
      });
    });

    // The imported item keeps its prior checkpoint knowledge instead of an
    // invented zero; the untouched neighbor stays as cached; no identity is
    // appended for a card the board never asked about.
    expect(client.getQueryData(enrichedKey)).toEqual({
      items: [
        expect.objectContaining({
          taskId: detail.remoteId,
          linked: true,
          epicId: 'epic-imported',
          loggedMinutes: 75,
        }),
        expect.objectContaining({ taskId: 'ENG-9', linked: false, loggedMinutes: 0 }),
      ],
    });
    client.clear();
  });
});
