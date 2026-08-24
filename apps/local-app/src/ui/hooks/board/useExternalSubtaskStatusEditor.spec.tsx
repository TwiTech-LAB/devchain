import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ExternalMyWorkResult,
  ExternalTaskDetail,
  ExternalTaskStatusOption,
} from '@/modules/external-integrations/models/external-provider.models';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalSubtaskStatusEditor } from './useExternalSubtaskStatusEditor';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
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

const epochOne = 'connection-jira-a:1';
const epochTwo = 'connection-jira-a:2';
const parentTaskId = 'PARENT-1';
const childTaskId = 'CHILD-1';

function option(
  actionValue: string,
  name: string,
  category: 'active' | 'completed' = 'active',
): ExternalTaskStatusOption {
  const remoteId = category === 'completed' ? 'done' : 'progress';
  return {
    actionValue,
    actionLabel: `Transition to ${name}`,
    remoteId,
    remoteStatusIds: [remoteId],
    name,
    color: '#64748b',
    category,
    position: 1,
  };
}

function detail(
  taskId: string,
  options: ExternalTaskStatusOption[],
  supported = true,
  currentCategory: 'active' | 'completed' = 'active',
): ExternalTaskDetail {
  const currentStatus =
    currentCategory === 'completed'
      ? { remoteId: 'done', name: 'Done' }
      : { remoteId: 'open', name: 'Open' };
  return {
    remoteId: taskId,
    remoteKey: taskId,
    title: `Task ${taskId}`,
    description: null,
    descriptionTruncated: false,
    status: {
      remoteId: currentStatus.remoteId,
      remoteStatusIds: [currentStatus.remoteId],
      name: currentStatus.name,
      color: '#64748b',
      category: currentCategory,
      position: 0,
    },
    dueAt: null,
    priority: null,
    subtasks: [],
    subtasksTruncated: false,
    taskTotalDurationMs: null,
    webUrl: `https://acme.atlassian.net/browse/${taskId}`,
    location: { scopeKey: 'site', workAreaId: 'board-1', workAreaName: 'Board 1' },
    allowedStatuses: options,
    actions: [
      { action: 'change_status', supported },
      { action: 'add_comment', supported: true },
      { action: 'log_time', supported: true },
    ],
    linkState: { linked: false, epicId: null },
  };
}

function workArea(assignedTaskCount: number) {
  return {
    remoteId: 'board-1',
    scopeKey: 'site',
    name: 'Board 1',
    kind: 'board' as const,
    description: null,
    assignedTaskCount,
    hierarchy: [],
    workflow: { isOverridden: false, columns: [] },
    refresh: {
      state: 'fresh' as const,
      refreshedAt: '2026-08-24T10:00:00.000Z',
      retryable: false,
      retryAt: null,
    },
  };
}

function snapshot(): SupportedSnapshot {
  const area = workArea(2);
  const task = (remoteId: string) => ({
    remoteId,
    parentRemoteTaskId: remoteId === childTaskId ? parentTaskId : null,
    title: remoteId,
    status: { remoteId: 'open', name: 'Open', category: 'active' as const },
    updatedAt: '2026-08-24T10:00:00.000Z',
    dueAt: null,
    completedAt: null,
    webUrl: null,
  });
  return {
    provider: 'jira',
    descriptor: {
      provider: 'jira',
      displayName: 'Jira',
      capabilities: { myWork: true },
    },
    supported: true,
    capabilities: { timeTrackingEnabled: true },
    workAreas: [area],
    tasks: [
      { workArea: area, task: task(parentTaskId) },
      { workArea: area, task: task(childTaskId) },
    ],
    refreshedAt: '2026-08-24T10:00:00.000Z',
  };
}

function response(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => body };
}

function detailReads(): string[] {
  return fetchMock.mock.calls.filter(([_url, init]) => !init?.method).map(([url]) => String(url));
}

function statusWrites(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([_url, init]) => init?.method === 'PUT');
}

// Layer: hook unit with a real QueryClient. The behavior under test is
// cross-cache settlement — paired landing-snapshot patches, detail
// invalidation, refetchType:'none' staleness, and epoch fencing — so a real
// cache (with only the fetch factory mocked) is the cheapest reliable layer;
// a component mount would add DOM noise and a backend lane would retest the
// provider contract owned by the adapter suites.
describe('useExternalSubtaskStatusEditor', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(response(detail(childTaskId, [option('21', 'In progress')])));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
  });

  afterEach(() => queryClient.clear());

  it('does not request child data before activation and hides a warm detail until a fresh read completes', async () => {
    const freshRead = deferred<ReturnType<typeof response>>();
    const warm = detail(childTaskId, [option('old-transition', 'Warm cached status')]);
    queryClient.setQueryData(
      externalMyWorkQueryKeys.taskDetail('jira', epochOne, childTaskId),
      warm,
    );
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith(`/tasks/${childTaskId}`)) return freshRead.promise;
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    expect(result.current.editor).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => result.current.activate(childTaskId));

    expect(result.current.editor).toEqual({ taskId: childTaskId, phase: 'loading' });
    expect(detailReads()).toEqual([`/api/integrations/my-work/jira/tasks/${childTaskId}`]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/comments'))).toBe(false);

    await act(async () => {
      freshRead.resolve(response(detail(childTaskId, [option('fresh-transition', 'Fresh')])));
      await freshRead.promise;
    });
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));

    expect(result.current.editor).toEqual(
      expect.objectContaining({
        taskId: childTaskId,
        phase: 'ready',
        options: [expect.objectContaining({ actionValue: 'fresh-transition' })],
      }),
    );
  });

  it.each([
    ['unsupported capability', false, [option('21', 'In progress')], 'unsupported'],
    ['empty transitions', true, [], 'no_transitions'],
  ] as const)(
    'keeps %s read-only and produces no write',
    async (_case, supported, options, reason) => {
      fetchMock.mockResolvedValue(response(detail(childTaskId, [...options], supported)));
      const { result } = renderHook(
        () =>
          useExternalSubtaskStatusEditor('jira', {
            connectionEpoch: epochOne,
            parentTaskId,
          }),
        { wrapper: wrapper(queryClient) },
      );

      act(() => result.current.activate(childTaskId));
      await waitFor(() => expect(result.current.editor?.phase).toBe('unavailable'));

      expect(result.current.editor).toEqual(
        expect.objectContaining({ phase: 'unavailable', reason }),
      );
      act(() => result.current.selectStatus('21'));
      expect(statusWrites()).toHaveLength(0);
    },
  );

  it('validates the chosen action value and latches same-tick submissions to one write', async () => {
    const write = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return write.promise;
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(response(detail(childTaskId, [option('21', 'In progress')])));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('not-from-fresh-detail'));
    expect(statusWrites()).toHaveLength(0);

    act(() => {
      result.current.selectStatus('21');
      result.current.selectStatus('21');
    });

    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0]![1].body).toBe(JSON.stringify({ status: '21' }));
    expect(result.current.editor?.phase).toBe('pending');

    await act(async () => {
      write.resolve(
        response({
          remoteTaskId: childTaskId,
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      );
      await write.promise;
    });
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));
  });

  it('discards failed transitions and retries through a new fresh detail read', async () => {
    let detailCount = 0;
    let writeCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writeCount += 1;
        if (writeCount === 1) {
          return Promise.resolve(response({ message: 'Provider unavailable' }, false));
        }
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        detailCount += 1;
        const transition = detailCount === 1 ? option('old', 'Old') : option('new', 'New');
        return Promise.resolve(response(detail(childTaskId, [transition])));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('old'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('error'));

    act(() => result.current.selectStatus('old'));
    expect(statusWrites()).toHaveLength(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    expect(detailReads()).toHaveLength(2);
    expect(result.current.editor).toEqual(
      expect.objectContaining({ options: [expect.objectContaining({ actionValue: 'new' })] }),
    );

    act(() => result.current.selectStatus('old'));
    expect(statusWrites()).toHaveLength(1);
    act(() => result.current.selectStatus('new'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));
    expect(statusWrites()).toHaveLength(2);
  });

  it('requires a new fresh read after a detail failure before selection', async () => {
    let detailCount = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        detailCount += 1;
        return Promise.resolve(
          detailCount === 1
            ? response({ message: 'Detail unavailable' }, false)
            : response(detail(childTaskId, [option('21', 'In progress')])),
        );
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('error'));
    act(() => result.current.selectStatus('21'));
    expect(statusWrites()).toHaveLength(0);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    expect(detailReads()).toHaveLength(2);
  });

  it('patches both existing landing scopes after success and refreshes captured detail keys', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const inclusiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, true);
    const parentKey = externalMyWorkQueryKeys.taskDetail('jira', epochOne, parentTaskId);
    const childKey = externalMyWorkQueryKeys.taskDetail('jira', epochOne, childTaskId);
    queryClient.setQueryData(activeKey, snapshot());
    queryClient.setQueryData(inclusiveKey, snapshot());
    queryClient.setQueryData(parentKey, { cached: 'parent' });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(response(detail(childTaskId, [option('31', 'Done', 'completed')])));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('31'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));

    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(activeKey)!
        .tasks.map((entry) => entry.task.remoteId),
    ).toEqual([parentTaskId]);
    const inclusive = queryClient.getQueryData<SupportedSnapshot>(inclusiveKey)!;
    expect(
      inclusive.tasks.find((entry) => entry.task.remoteId === childTaskId)?.task.status,
    ).toEqual({
      remoteId: 'done',
      name: 'Done',
      category: 'completed',
    });
    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inclusiveKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(parentKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(childKey)?.isInvalidated).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted='))).toBe(
      false,
    );
  });

  it('updates an unassigned active child without requiring assigned-work reconstruction', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const inclusiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, true);
    const assignedWorkWithoutChild: SupportedSnapshot = {
      ...snapshot(),
      tasks: snapshot().tasks.filter((entry) => entry.task.remoteId !== childTaskId),
      workAreas: [{ ...snapshot().workAreas[0]!, assignedTaskCount: 1 }],
    };
    queryClient.setQueryData(activeKey, assignedWorkWithoutChild);
    queryClient.setQueryData(inclusiveKey, assignedWorkWithoutChild);
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));

    expect(statusWrites()).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted='))).toBe(
      false,
    );
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(activeKey)!
        .tasks.some((entry) => entry.task.remoteId === childTaskId),
    ).toBe(false);
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(inclusiveKey)!
        .tasks.some((entry) => entry.task.remoteId === childTaskId),
    ).toBe(false);
  });

  it('restores a reopened child from completed-inclusive data without a landing refetch', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const inclusiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, true);
    const inclusive: SupportedSnapshot = {
      ...snapshot(),
      tasks: snapshot().tasks.map((entry) =>
        entry.task.remoteId === childTaskId
          ? {
              ...entry,
              task: {
                ...entry.task,
                status: { remoteId: 'done', name: 'Done', category: 'completed' },
              },
            }
          : entry,
      ),
    };
    const activeOnly: SupportedSnapshot = {
      ...inclusive,
      tasks: inclusive.tasks.filter((entry) => entry.task.remoteId !== childTaskId),
      workAreas: [{ ...inclusive.workAreas[0]!, assignedTaskCount: 1 }],
    };
    queryClient.setQueryData(activeKey, activeOnly);
    queryClient.setQueryData(inclusiveKey, inclusive);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(
          response(detail(childTaskId, [option('21', 'In progress')], true, 'completed')),
        );
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));

    const activeAfter = queryClient.getQueryData<SupportedSnapshot>(activeKey)!;
    expect(activeAfter.tasks.map((entry) => entry.task.remoteId)).toEqual([
      parentTaskId,
      childTaskId,
    ]);
    expect(activeAfter.workAreas[0]?.assignedTaskCount).toBe(2);
    expect(activeAfter.tasks[1]?.task.status).toEqual({
      remoteId: 'progress',
      name: 'In progress',
      category: 'active',
    });
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(inclusiveKey)!
        .tasks.find((entry) => entry.task.remoteId === childTaskId)?.task.status.category,
    ).toBe('active');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted='))).toBe(
      false,
    );
  });

  it('loads a missing completed-inclusive source before reopening and never refetches it after', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const inclusive = snapshot();
    const activeOnly: SupportedSnapshot = {
      ...inclusive,
      tasks: inclusive.tasks.filter((entry) => entry.task.remoteId !== childTaskId),
      workAreas: [{ ...inclusive.workAreas[0]!, assignedTaskCount: 1 }],
    };
    queryClient.setQueryData(activeKey, activeOnly);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(
          response(detail(childTaskId, [option('21', 'In progress')], true, 'completed')),
        );
      }
      if (String(url).includes('includeCompleted=true')) {
        return Promise.resolve(response(inclusive));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));

    const landingReads = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('includeCompleted=true'),
    );
    const landingReadIndex = fetchMock.mock.calls.findIndex(([url]) =>
      String(url).includes('includeCompleted=true'),
    );
    const writeIndex = fetchMock.mock.calls.findIndex(([_url, init]) => init?.method === 'PUT');
    expect(landingReads).toHaveLength(1);
    expect(landingReadIndex).toBeLessThan(writeIndex);
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(activeKey)!
        .tasks.some((entry) => entry.task.remoteId === childTaskId),
    ).toBe(true);
  });

  it('refuses to reopen when the missing completed-inclusive source cannot load', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const activeOnly = snapshot();
    activeOnly.tasks = activeOnly.tasks.filter((entry) => entry.task.remoteId !== childTaskId);
    activeOnly.workAreas = [{ ...activeOnly.workAreas[0]!, assignedTaskCount: 1 }];
    queryClient.setQueryData(activeKey, activeOnly);
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(
          response(detail(childTaskId, [option('21', 'In progress')], true, 'completed')),
        );
      }
      if (String(url).includes('includeCompleted=true')) {
        return Promise.resolve(response({ message: 'Landing unavailable' }, false));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('error'));

    expect(statusWrites()).toHaveLength(0);
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(activeKey)!
        .tasks.some((entry) => entry.task.remoteId === childTaskId),
    ).toBe(false);
  });

  it('refuses an older completed child absent from both landing scopes before the write', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const activeOnly = snapshot();
    activeOnly.tasks = activeOnly.tasks.filter((entry) => entry.task.remoteId !== childTaskId);
    activeOnly.workAreas = [{ ...activeOnly.workAreas[0]!, assignedTaskCount: 1 }];
    const boundedInclusive: SupportedSnapshot = {
      ...activeOnly,
      tasks: activeOnly.tasks.filter((entry) => entry.task.remoteId !== childTaskId),
    };
    queryClient.setQueryData(activeKey, activeOnly);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          response({
            remoteTaskId: childTaskId,
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        );
      }
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(
          response(detail(childTaskId, [option('21', 'In progress')], true, 'completed')),
        );
      }
      if (String(url).includes('includeCompleted=true')) {
        return Promise.resolve(response(boundedInclusive));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('error'));

    expect(statusWrites()).toHaveLength(0);
    expect(result.current.editor).toEqual(
      expect.objectContaining({
        phase: 'error',
        error: expect.objectContaining({
          message:
            'DevChain cannot reconstruct this subtask in assigned work. Refresh the connected board, or open the task in the provider and change it there.',
        }),
      }),
    );
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(activeKey)!
        .tasks.some((entry) => entry.task.remoteId === childTaskId),
    ).toBe(false);
  });

  it('does not write through a replacement epoch after a recovery read starts', async () => {
    const activeKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const activeOnly = snapshot();
    activeOnly.tasks = activeOnly.tasks.filter((entry) => entry.task.remoteId !== childTaskId);
    activeOnly.workAreas = [{ ...activeOnly.workAreas[0]!, assignedTaskCount: 1 }];
    queryClient.setQueryData(activeKey, activeOnly);
    const recovery = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith(`/tasks/${childTaskId}`)) {
        return Promise.resolve(
          response(detail(childTaskId, [option('21', 'In progress')], true, 'completed')),
        );
      }
      if (String(url).includes('includeCompleted=true')) return recovery.promise;
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result, rerender } = renderHook(
      (epoch: string) =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epoch,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient), initialProps: epochOne },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted=true')),
      ).toBe(true),
    );

    rerender(epochTwo);
    await act(async () => {
      recovery.resolve(response(snapshot()));
      await recovery.promise;
    });

    expect(statusWrites()).toHaveLength(0);
    expect(result.current.editor).toBeNull();
  });

  it('ignores a superseded detail result in the current row presentation', async () => {
    const first = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/tasks/CHILD-1')) return first.promise;
      if (String(url).endsWith('/tasks/CHILD-2')) {
        return Promise.resolve(response(detail('CHILD-2', [option('22', 'Review')])));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate('CHILD-1'));
    act(() => result.current.activate('CHILD-2'));
    await waitFor(() => expect(result.current.editor?.taskId).toBe('CHILD-2'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));

    await act(async () => {
      first.resolve(response(detail('CHILD-1', [option('21', 'In progress')])));
      await first.promise;
    });

    expect(result.current.editor).toEqual(
      expect.objectContaining({ taskId: 'CHILD-2', phase: 'ready' }),
    );
  });

  it('does not publish a late detail result after unmount', async () => {
    const freshRead = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValue(freshRead.promise);
    const { result, unmount } = renderHook(
      () =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epochOne,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.activate(childTaskId));
    expect(result.current.editor?.phase).toBe('loading');
    unmount();

    await act(async () => {
      freshRead.resolve(response(detail(childTaskId, [option('21', 'In progress')])));
      await freshRead.promise;
    });

    expect(result.current.editor?.phase).toBe('loading');
  });

  it('does not let an old epoch operation release the latch owned by a newer write', async () => {
    const firstWrite = deferred<ReturnType<typeof response>>();
    const secondWrite = deferred<ReturnType<typeof response>>();
    let putCount = 0;
    const firstActiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochOne, false);
    const secondActiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', epochTwo, false);
    queryClient.setQueryData(firstActiveKey, snapshot());
    const secondSnapshot = snapshot();
    const childTwoEntry = secondSnapshot.tasks.find(
      (entry) => entry.task.remoteId === childTaskId,
    )!;
    secondSnapshot.tasks = [
      ...secondSnapshot.tasks,
      { ...childTwoEntry, task: { ...childTwoEntry.task, remoteId: 'CHILD-2' } },
    ];
    secondSnapshot.workAreas = [{ ...secondSnapshot.workAreas[0]!, assignedTaskCount: 3 }];
    queryClient.setQueryData(secondActiveKey, secondSnapshot);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount += 1;
        return putCount === 1 ? firstWrite.promise : secondWrite.promise;
      }
      const taskId = String(url).split('/').pop()!;
      return Promise.resolve(response(detail(taskId, [option('21', 'In progress')])));
    });
    const { result, rerender } = renderHook(
      (epoch: string) =>
        useExternalSubtaskStatusEditor('jira', {
          connectionEpoch: epoch,
          parentTaskId,
        }),
      { wrapper: wrapper(queryClient), initialProps: epochOne },
    );

    act(() => result.current.activate(childTaskId));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    expect(statusWrites()).toHaveLength(1);

    rerender(epochTwo);
    act(() => result.current.activate('CHILD-2'));
    await waitFor(() => expect(result.current.editor?.phase).toBe('ready'));
    act(() => result.current.selectStatus('21'));
    expect(statusWrites()).toHaveLength(2);

    await act(async () => {
      firstWrite.resolve(
        response({
          remoteTaskId: childTaskId,
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      );
      await firstWrite.promise;
    });
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(firstActiveKey)!
        .tasks.find((entry) => entry.task.remoteId === childTaskId)?.task.status.remoteId,
    ).toBe('progress');
    expect(
      queryClient
        .getQueryData<SupportedSnapshot>(secondActiveKey)!
        .tasks.find((entry) => entry.task.remoteId === childTaskId)?.task.status.remoteId,
    ).toBe('open');
    act(() => result.current.activate('CHILD-3'));
    expect(detailReads().some((url) => url.endsWith('/tasks/CHILD-3'))).toBe(false);

    await act(async () => {
      secondWrite.resolve(
        response({
          remoteTaskId: 'CHILD-2',
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      );
      await secondWrite.promise;
    });
    await waitFor(() => expect(result.current.editor?.phase).toBe('success'));
  });
});
