import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ExternalTaskComment } from '@/modules/external-integrations/models/external-provider.models';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  COMMENTS_CHANGED_WHILE_LOADING_MESSAGE,
  chaseAttemptMessage,
  mergeExternalTaskCommentPages,
  nextCommentPageParam,
  useExternalTaskController,
} from './useExternalTaskController';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const detail = {
  remoteId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Ship actions',
  description: null,
  descriptionTruncated: false,
  status: {
    remoteId: 'status-open',
    name: 'Open',
    color: '#6b778c',
    category: 'active',
    position: 0,
  },
  dueAt: null,
  priority: null,
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  location: { scopeKey: 'acme.atlassian.net', workAreaId: 'board-1', workAreaName: 'Board' },
  allowedStatuses: [],
  actions: [],
  linkState: { linked: false, epicId: null },
};
const connectionEpoch = 'connection-jira-a:1';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_B_ID = '22222222-2222-4222-8222-222222222222';
const connectionEpochB = 'connection-jira-b:2';
const detailB = {
  ...detail,
  remoteId: 'OTHER-2',
  remoteKey: 'OTHER-2',
  title: 'Project B action',
  webUrl: 'https://other.atlassian.net/browse/OTHER-2',
  location: {
    scopeKey: 'other.atlassian.net',
    workAreaId: 'board-2',
    workAreaName: 'Other board',
  },
};
const emptyCommentsPage = { comments: [], nextCursor: null };

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

function actionResult(taskId: string, action: 'add_comment' | 'change_status') {
  return {
    remoteTaskId: taskId,
    action,
    succeeded: true,
    refresh: ['my_work', 'task_detail'],
  };
}

function comment(id: string, minutesOffset: number): ExternalTaskComment {
  return {
    remoteId: id,
    author: { remoteId: `author-${id}`, displayName: `Author ${id}` },
    body: `Body ${id}`,
    bodyTruncated: false,
    createdAt: new Date(
      Date.parse('2026-08-20T12:00:00.000Z') + minutesOffset * 60_000,
    ).toISOString(),
    updatedAt: null,
  };
}

function page(comments: ExternalTaskComment[], nextCursor: string | null) {
  return { comments, nextCursor };
}

function commentsUrl(cursor: string | null): string {
  return `/api/integrations/my-work/jira/tasks/ENG-1/comments${
    cursor === null ? `?projectId=${PROJECT_ID}` : `?cursor=${cursor}&projectId=${PROJECT_ID}`
  }`;
}

function fetchedCommentCursors(): Array<string | null> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/comments') && !init?.method)
    .map(([url]) => new URL(String(url), 'https://local.dev').searchParams.get('cursor'));
}

describe('useExternalTaskController', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      const action = url.includes('/status?') ? 'change_status' : 'add_comment';
      return Promise.resolve({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action,
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
    });
  });

  afterEach(() => queryClient.clear());

  it('loads detail from the canonical task-detail query key', async () => {
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/my-work/jira/tasks/ENG-1?projectId=${PROJECT_ID}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(
      queryClient.getQueryData(
        externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
      ),
    ).toEqual(detail);
  });

  it.each([
    [{ action: 'change_status' as const, input: { status: 'transition-31' } }, '/status', 'PUT'],
    [
      { action: 'add_comment' as const, input: { text: 'Ready', notifyAll: false } },
      '/comments',
      'POST',
    ],
  ])(
    'sends %s and invalidates the exact task-detail and landing queries',
    async (request, path, method) => {
      const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(
        () =>
          useExternalTaskController('jira', 'ENG-1', {
            enabled: true,
            connectionEpoch,
            projectId: PROJECT_ID,
          }),
        { wrapper: wrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

      await act(async () => {
        await result.current.mutation.mutateAsync(request);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/integrations/my-work/jira/tasks/ENG-1${path}?projectId=${PROJECT_ID}`,
        expect.objectContaining({ method, body: JSON.stringify(request.input) }),
      );
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
        exact: true,
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.landing('jira', connectionEpoch),
      });
    },
  );

  it.each([{ action: 'change_status' as const, input: { status: 'transition-31' } }])(
    'never fetches comments for %s',
    async (request) => {
      const { result } = renderHook(
        () =>
          useExternalTaskController('jira', 'ENG-1', {
            enabled: true,
            connectionEpoch,
            projectId: PROJECT_ID,
          }),
        { wrapper: wrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.mutation.mutateAsync(request);
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([url]) => String(url).includes('/comments')),
        ).toHaveLength(0),
      );
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/comments')),
      ).toHaveLength(0);
    },
  );

  it('projects a safe mutation error without removing loaded detail', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method
          ? { ok: false, json: async () => ({ message: 'Complete this transition in Jira.' }) }
          : String(url).includes('/comments')
            ? { ok: true, json: async () => emptyCommentsPage }
            : { ok: true, json: async () => detail },
      ),
    );
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

    await act(async () => {
      await expect(
        result.current.mutation.mutateAsync({
          action: 'change_status',
          input: { status: 'transition-31' },
        }),
      ).rejects.toThrow('Complete this transition in Jira.');
    });

    expect(result.current.detail.data).toEqual(detail);
  });

  it('keeps a newer Project B comment operation intact when Project A settles late', async () => {
    const actionA = deferred<Response>();
    const actionB = deferred<Response>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) {
        const body = JSON.parse(String(init.body)) as { text?: string };
        return body.text === 'Comment A' ? actionA.promise : actionB.promise;
      }
      if (String(url).includes('/comments')) {
        return Promise.resolve(response(emptyCommentsPage));
      }
      return Promise.resolve(response(String(url).includes('OTHER-2') ? detailB : detail));
    });
    const cancelQueries = jest.spyOn(queryClient, 'cancelQueries');
    const resetQueries = jest.spyOn(queryClient, 'resetQueries');
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const onASuccess = jest.fn();
    const hook = renderHook(
      ({ taskId, selectedProjectId, epoch }) =>
        useExternalTaskController('jira', taskId, {
          enabled: true,
          connectionEpoch: epoch,
          projectId: selectedProjectId,
        }),
      {
        wrapper: wrapper(queryClient),
        initialProps: {
          taskId: detail.remoteId,
          selectedProjectId: PROJECT_ID,
          epoch: connectionEpoch,
        },
      },
    );
    await waitFor(() => expect(hook.result.current.comments.isSuccess).toBe(true));

    act(() => {
      hook.result.current.setCommentText('Draft A');
      hook.result.current.mutation.mutate(
        { action: 'add_comment', input: { text: 'Comment A', notifyAll: false } },
        { onSuccess: onASuccess },
      );
    });
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));
    expect(hook.result.current.mutation.capturedVariables).toEqual(
      expect.objectContaining({
        scope: {
          projectId: PROJECT_ID,
          provider: 'jira',
          connectionEpoch,
          taskId: detail.remoteId,
        },
        request: { action: 'add_comment', input: { text: 'Comment A', notifyAll: false } },
        cacheKeys: {
          comments: externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, detail.remoteId),
          detail: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, detail.remoteId),
          landing: externalMyWorkQueryKeys.landing('jira', connectionEpoch),
        },
        operationId: expect.any(Number),
        apiFetch: expect.any(Function),
      }),
    );

    hook.rerender({
      taskId: detailB.remoteId,
      selectedProjectId: PROJECT_B_ID,
      epoch: connectionEpochB,
    });
    await waitFor(() => expect(hook.result.current.comments.isSuccess).toBe(true));
    expect(hook.result.current.mutation).toEqual(
      expect.objectContaining({
        data: undefined,
        error: null,
        variables: undefined,
        capturedVariables: undefined,
        status: 'idle',
        isPending: false,
        isSuccess: false,
      }),
    );

    act(() => {
      hook.result.current.setCommentText('Draft B');
      hook.result.current.mutation.mutate({
        action: 'add_comment',
        input: { text: 'Comment B', notifyAll: false },
      });
    });
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));

    await act(async () => actionA.resolve(response(actionResult(detail.remoteId, 'add_comment'))));
    await waitFor(() =>
      expect(resetQueries).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, detail.remoteId),
        exact: true,
      }),
    );
    expect(hook.result.current.commentText).toBe('Draft B');
    expect(hook.result.current.mutation.isPending).toBe(true);
    expect(hook.result.current.mutation.data).toBeUndefined();
    expect(onASuccess).not.toHaveBeenCalled();
    expect(cancelQueries).not.toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskComments('jira', connectionEpochB, detailB.remoteId),
      exact: true,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpochB, detailB.remoteId),
      exact: true,
    });

    await act(async () => actionB.resolve(response(actionResult(detailB.remoteId, 'add_comment'))));
    await waitFor(() => expect(hook.result.current.mutation.isSuccess).toBe(true));
    expect(hook.result.current.commentText).toBe('');
    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskComments('jira', connectionEpochB, detailB.remoteId),
      exact: true,
    });
  });

  it('hides a Project A status failure after rendering Project B', async () => {
    const action = deferred<Response>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) return action.promise;
      if (String(url).includes('/comments')) return Promise.resolve(response(emptyCommentsPage));
      return Promise.resolve(response(String(url).includes('OTHER-2') ? detailB : detail));
    });
    const onError = jest.fn();
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const hook = renderHook(
      ({ taskId, selectedProjectId, epoch }) =>
        useExternalTaskController('jira', taskId, {
          enabled: true,
          connectionEpoch: epoch,
          projectId: selectedProjectId,
        }),
      {
        wrapper: wrapper(queryClient),
        initialProps: {
          taskId: detail.remoteId,
          selectedProjectId: PROJECT_ID,
          epoch: connectionEpoch,
        },
      },
    );
    await waitFor(() => expect(hook.result.current.detail.isSuccess).toBe(true));
    act(() =>
      hook.result.current.mutation.mutate(
        { action: 'change_status', input: { status: 'transition-a' } },
        { onError },
      ),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));

    hook.rerender({
      taskId: detailB.remoteId,
      selectedProjectId: PROJECT_B_ID,
      epoch: connectionEpochB,
    });
    await act(async () => action.reject(new Error('Project A status failed')));

    expect(onError).not.toHaveBeenCalled();
    expect(hook.result.current.mutation).toEqual(
      expect.objectContaining({
        data: undefined,
        error: null,
        variables: undefined,
        status: 'idle',
        isPending: false,
        isError: false,
      }),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpochB, detailB.remoteId),
      }),
    );
  });

  it('keeps an epoch N+1 comment draft and caches untouched after an epoch N failure', async () => {
    const action = deferred<Response>();
    const nextEpoch = 'connection-jira-a:2';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) return action.promise;
      if (String(url).includes('/comments')) return Promise.resolve(response(emptyCommentsPage));
      return Promise.resolve(response(detail));
    });
    const resetQueries = jest.spyOn(queryClient, 'resetQueries');
    const hook = renderHook(
      ({ epoch }) =>
        useExternalTaskController('jira', detail.remoteId, {
          enabled: true,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient), initialProps: { epoch: connectionEpoch } },
    );
    await waitFor(() => expect(hook.result.current.comments.isSuccess).toBe(true));
    act(() =>
      hook.result.current.mutation.mutate({
        action: 'add_comment',
        input: { text: 'Old epoch comment', notifyAll: false },
      }),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));

    hook.rerender({ epoch: nextEpoch });
    await waitFor(() => expect(hook.result.current.comments.isSuccess).toBe(true));
    act(() => hook.result.current.setCommentText('New epoch draft'));
    await act(async () => action.reject(new Error('Old epoch comment failed')));

    expect(hook.result.current.commentText).toBe('New epoch draft');
    expect(hook.result.current.mutation.error).toBeNull();
    expect(hook.result.current.mutation.isError).toBe(false);
    expect(resetQueries).not.toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskComments('jira', nextEpoch, detail.remoteId),
      exact: true,
    });
  });

  it('invalidates only epoch N status caches after the hook advances to N+1', async () => {
    const action = deferred<Response>();
    const nextEpoch = 'connection-jira-a:2';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) return action.promise;
      if (String(url).includes('/comments')) return Promise.resolve(response(emptyCommentsPage));
      return Promise.resolve(response(detail));
    });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const hook = renderHook(
      ({ epoch }) =>
        useExternalTaskController('jira', detail.remoteId, {
          enabled: true,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient), initialProps: { epoch: connectionEpoch } },
    );
    await waitFor(() => expect(hook.result.current.detail.isSuccess).toBe(true));
    act(() =>
      hook.result.current.mutation.mutate({
        action: 'change_status',
        input: { status: 'old-epoch-transition' },
      }),
    );
    await waitFor(() => expect(hook.result.current.mutation.isPending).toBe(true));
    hook.rerender({ epoch: nextEpoch });
    expect(hook.result.current.mutation.isPending).toBe(false);

    await act(async () => action.resolve(response(actionResult(detail.remoteId, 'change_status'))));
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, detail.remoteId),
        exact: true,
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.landing('jira', connectionEpoch),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: externalMyWorkQueryKeys.taskDetail('jira', nextEpoch, detail.remoteId),
      }),
    );
    expect(hook.result.current.mutation.data).toBeUndefined();
    expect(hook.result.current.mutation.isSuccess).toBe(false);
  });
});

describe('external task comments query', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action: 'add_comment',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
    });
  });

  afterEach(() => queryClient.clear());

  it('stays disabled without availability, epoch, task, or dialog and requests with an AbortSignal', async () => {
    const { result: dormant } = renderHook(
      () =>
        useExternalTaskController('jira', null, {
          enabled: false,
          connectionEpoch: null,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );

    expect(dormant.current.comments.data).toBeUndefined();
    expect(dormant.current.detail.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(commentsUrl(null), {
      signal: expect.any(AbortSignal),
    });
    expect(
      queryClient.getQueryData(
        externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
      ),
    ).toEqual({ pageParams: [null], pages: [emptyCommentsPage] });
  });

  it('chases one duplicate-only Jira page to reach older unique comments without duplicates', async () => {
    const a0to9 = Array.from({ length: 10 }, (_, index) => comment(`A${index}`, -index));
    const a10to19 = Array.from({ length: 10 }, (_, index) =>
      comment(`A${10 + index}`, -(10 + index)),
    );
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        const cursor = new URL(String(url), 'https://local.dev').searchParams.get('cursor');
        if (cursor === '10')
          return Promise.resolve({ ok: true, json: async () => page(a0to9, '20') });
        if (cursor === '20') {
          return Promise.resolve({ ok: true, json: async () => page(a10to19, null) });
        }
        return Promise.resolve({ ok: true, json: async () => page(a0to9, '10') });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
    });
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(fetchedCommentCursors()).toEqual([null, '10', '20']);
    const ids = result.current.chronologicalComments.map((entry) => entry.remoteId);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, index) => `A${19 - index}`));
    expect(new Set(ids).size).toBe(20);
    expect(result.current.commentsMessage).toBeNull();
    expect(result.current.comments.hasNextPage).toBe(false);
  });

  it('stops one Load earlier after three duplicate-only pages and preserves the next cursor', async () => {
    const a0to9 = Array.from({ length: 10 }, (_, index) => comment(`A${index}`, -index));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        const cursor = new URL(String(url), 'https://local.dev').searchParams.get('cursor');
        if (cursor === '40') {
          return Promise.resolve({
            ok: true,
            json: async () => page([comment('A-OLD', -99)], null),
          });
        }
        const next = cursor === null ? '10' : String(Number(cursor) + 10);
        return Promise.resolve({ ok: true, json: async () => page(a0to9, next) });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
    });
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(fetchedCommentCursors()).toEqual([null, '10', '20', '30']);
    expect(result.current.commentsMessage).toBe(COMMENTS_CHANGED_WHILE_LOADING_MESSAGE);
    expect(result.current.comments.hasNextPage).toBe(true);
    expect(result.current.chronologicalComments.map((entry) => entry.remoteId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `A${9 - index}`),
    );

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(fetchedCommentCursors()).toEqual([null, '10', '20', '30', '40']);
    expect(result.current.chronologicalComments.map((entry) => entry.remoteId)).toEqual([
      'A-OLD',
      ...Array.from({ length: 10 }, (_, index) => `A${9 - index}`),
    ]);
  });

  it('reports each chase attempt through the comments message', async () => {
    // act batches a whole chase into one commit, so intermediate live-region
    // values are asserted deterministically: distinct per-attempt text plus
    // the committed exhaustion message below.
    expect(chaseAttemptMessage(1)).toBe('Loading earlier comments (attempt 1 of 3)…');
    expect(chaseAttemptMessage(2)).toBe('Loading earlier comments (attempt 2 of 3)…');
    expect(chaseAttemptMessage(3)).toBe('Loading earlier comments (attempt 3 of 3)…');

    const a0to9 = Array.from({ length: 10 }, (_, index) => comment(`A${index}`, -index));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => page(a0to9, '10') });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
    });
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    expect(result.current.commentsMessage).toBeNull();
    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(result.current.commentsMessage).toBeNull();
    expect(fetchedCommentCursors()).toEqual([null, '10']);
  });

  it('stops after one failed older-page request without the chase-exhaustion message', async () => {
    const a0to9 = Array.from({ length: 10 }, (_, index) => comment(`A${index}`, -index));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        const cursor = new URL(String(url), 'https://local.dev').searchParams.get('cursor');
        if (cursor === '10') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ message: 'Comments could not be loaded.' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => page(a0to9, '10') });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
    });
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    await act(async () => {
      await result.current.loadEarlier();
    });

    expect(fetchedCommentCursors()).toEqual([null, '10']);
    expect(result.current.chronologicalComments.map((entry) => entry.remoteId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `A${9 - index}`),
    );
    const data = result.current.comments.data;
    expect(data?.pages[data.pages.length - 1]?.nextCursor).toBe('10');
    expect(result.current.comments.isFetchNextPageError).toBe(true);
    expect(result.current.comments.error).toBeInstanceOf(Error);
    expect(result.current.commentsMessage).toBeNull();
  });

  it('resets only the initial comments page after successful creation and clears the draft', async () => {
    const a0to9 = Array.from({ length: 10 }, (_, index) => comment(`A${index}`, -index));
    let creations = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        const cursor = new URL(String(url), 'https://local.dev').searchParams.get('cursor');
        if (cursor === '20') {
          return Promise.resolve({ ok: true, json: async () => page([], null) });
        }
        return Promise.resolve({ ok: true, json: async () => page(a0to9, '20') });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      creations += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action: 'add_comment',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
    });
    const cancelQueries = jest.spyOn(queryClient, 'cancelQueries');
    const resetQueries = jest.spyOn(queryClient, 'resetQueries');
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));
    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(result.current.chronologicalComments).toHaveLength(10);
    await act(async () => {
      result.current.setCommentText('Draft comment');
    });
    fetchMock.mockClear();

    await act(async () => {
      await result.current.mutation.mutateAsync({
        action: 'add_comment',
        input: { text: 'New comment', notifyAll: false },
      });
    });

    expect(creations).toBe(1);
    expect(result.current.commentText).toBe('');
    expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));
    expect(result.current.comments.data?.pageParams).toEqual([null]);
    expect(result.current.comments.data?.pages).toHaveLength(1);
    expect(fetchedCommentCursors()).toEqual([null]);
  });
});

describe('comment page helpers', () => {
  it('keeps the first (newest) copy of a duplicated remote ID across pages', () => {
    const newest = comment('dup', 0);
    const older = { ...comment('dup', -5), body: 'older copy' };
    const unique = comment('unique', -1);

    const merged = mergeExternalTaskCommentPages([
      page([newest, unique], '10'),
      page([older], null),
    ]);

    expect(merged).toEqual([newest, unique]);
  });

  it('stops pagination on a missing or repeated cursor and otherwise returns it', () => {
    expect(nextCommentPageParam(page([], null), [null])).toBeUndefined();
    expect(nextCommentPageParam(page([], '10'), [null, '10'])).toBeUndefined();
    expect(nextCommentPageParam(page([], '10'), [null])).toBe('10');
  });
});

describe('expected Epic identity gating', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
      }
      if (!init?.method) return Promise.resolve({ ok: true, json: async () => detail });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
    });
  });

  afterEach(() => queryClient.clear());

  it.each([
    { linked: false, epicId: null },
    { linked: true, epicId: 'epic-other' },
  ])(
    'exposes nothing beyond the detail read while linkState %p does not resolve to the expected Epic',
    async (linkState) => {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (!init?.method) {
          return Promise.resolve({ ok: true, json: async () => ({ ...detail, linkState }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      // A dormant query still exposes cached pages; the projection must not.
      queryClient.setQueryData(
        externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
        {
          pageParams: [null],
          pages: [page([comment('C1', 0)], null)],
        },
      );

      const { result } = renderHook(
        () =>
          useExternalTaskController('jira', 'ENG-1', {
            enabled: true,
            connectionEpoch,
            projectId: PROJECT_ID,
            expectedLinkedEpicId: 'epic-1',
          }),
        { wrapper: wrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));

      expect(result.current.identityAccepted).toBe(false);
      expect(result.current.identityMismatch).toBe(true);
      expect(result.current.detail.data).toBeUndefined();
      expect(result.current.comments.data).toBeUndefined();
      expect(result.current.chronologicalComments).toEqual([]);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/comments')),
      ).toHaveLength(0);

      await act(async () => {
        await result.current.loadEarlier();
      });
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/comments')),
      ).toHaveLength(0);

      await act(async () => {
        await expect(
          result.current.mutation.mutateAsync({
            action: 'change_status',
            input: { status: '31' },
          }),
        ).rejects.toThrow('Linked task unavailable for the current connection.');
      });
      expect(fetchMock.mock.calls.filter(([, init]) => Boolean(init?.method))).toHaveLength(0);
    },
  );

  it('runs the detail query first and enables comments and mutations once the link resolves to the expected Epic', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && !init?.method) {
        return Promise.resolve({ ok: true, json: async () => emptyCommentsPage });
      }
      if (!init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...detail, linkState: { linked: true, epicId: 'epic-1' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
    });

    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
          expectedLinkedEpicId: 'epic-1',
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.identityAccepted).toBe(true));

    expect(result.current.identityMismatch).toBe(false);
    expect(result.current.detail.data?.linkState.epicId).toBe('epic-1');
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(commentsUrl(null), {
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      await result.current.mutation.mutateAsync({
        action: 'change_status',
        input: { status: '31' },
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/my-work/jira/tasks/ENG-1/status?projectId=${PROJECT_ID}`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('stays accepted without an expected Epic even while the task is unlinked', async () => {
    const { result } = renderHook(
      () =>
        useExternalTaskController('jira', 'ENG-1', {
          enabled: true,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));

    expect(result.current.identityAccepted).toBe(true);
    expect(result.current.identityMismatch).toBe(false);
    expect(result.current.detail.data).toEqual(detail);
  });
});
