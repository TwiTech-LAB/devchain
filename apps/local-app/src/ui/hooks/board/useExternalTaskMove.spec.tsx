import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ExternalMyWorkResult,
  ExternalTaskDetail,
  ExternalTaskStatusOption,
} from '@/modules/external-integrations/models/external-provider.models';
import { fetchJsonOrThrow, type FetchFn } from '@/ui/lib/sessions';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  MOVE_BOUNDARY_ANNOUNCEMENT,
  MOVE_CANCELED_ANNOUNCEMENT,
  MOVE_CHOICE_ANNOUNCEMENT,
  MOVE_FAILED_ANNOUNCEMENT,
  MOVE_PENDING_ANNOUNCEMENT,
  MOVE_SUCCESS_ANNOUNCEMENT,
  MOVE_UNAVAILABLE_ANNOUNCEMENT,
  applyOptimisticMoveSnapshot,
  resolveExternalMoveOptions,
  useExternalTaskMove,
  type ExternalTaskMoveSource,
  type ExternalTaskMoveTarget,
} from './useExternalTaskMove';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const connectionEpoch = 'connection-jira-a:1';
const landingActiveKey = externalMyWorkQueryKeys.landingSnapshot('jira', connectionEpoch, false);
const landingCompletedKey = externalMyWorkQueryKeys.landingSnapshot('jira', connectionEpoch, true);
const detailKey = externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1');

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

function optionFixture(
  actionValue: string,
  name: string,
  statusId: string,
  category: 'active' | 'completed',
): ExternalTaskStatusOption {
  return {
    actionValue,
    actionLabel: `Label ${actionValue}`,
    remoteId: statusId,
    remoteStatusIds: [statusId],
    name,
    color: '#6b778c',
    category,
    position: 0,
  };
}

function detailFixture(allowedStatuses: ExternalTaskStatusOption[]): ExternalTaskDetail {
  return {
    remoteId: 'ENG-1',
    remoteKey: 'ENG-1',
    title: 'Ship moves',
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
    location: { scopeKey: 'site', workAreaId: 'board-1', workAreaName: 'Board 1' },
    allowedStatuses,
    actions: [
      { action: 'change_status', supported: true },
      { action: 'add_comment', supported: true },
      { action: 'log_time', supported: true },
    ],
    linkState: { linked: false, epicId: null },
  };
}

function workAreaFixture(remoteId: string, assignedTaskCount: number) {
  return {
    remoteId,
    scopeKey: 'site',
    name: `Board ${remoteId}`,
    kind: 'board' as const,
    description: null,
    assignedTaskCount,
    hierarchy: [{ kind: 'workspace' as const, remoteId: 'site', name: 'site' }],
    workflow: { isOverridden: false, columns: [] },
    refresh: {
      state: 'fresh' as const,
      refreshedAt: '2026-08-21T12:00:00.000Z',
      retryable: false,
      retryAt: null,
    },
  };
}

function taskFixture(remoteId: string) {
  return {
    remoteId,
    title: `Task ${remoteId}`,
    status: { remoteId: 'status-open', name: 'Open', category: 'active' as const },
    updatedAt: '2026-08-21T12:00:00.000Z',
    dueAt: null,
    completedAt: null,
    webUrl: null,
  };
}

function snapshotFixture(): SupportedSnapshot {
  const board1 = workAreaFixture('board-1', 2);
  const board2 = workAreaFixture('board-2', 1);
  return {
    provider: 'jira',
    descriptor: {
      provider: 'jira',
      displayName: 'Jira',
      capabilities: { myWork: true },
    },
    supported: true,
    capabilities: { timeTrackingEnabled: true },
    workAreas: [board1, board2],
    tasks: [
      { workArea: board1, task: taskFixture('ENG-1') },
      { workArea: board1, task: taskFixture('ENG-2') },
      { workArea: board2, task: taskFixture('ENG-1') },
    ],
    refreshedAt: '2026-08-21T12:00:00.000Z',
  };
}

const source: ExternalTaskMoveSource = { taskId: 'ENG-1', columnKey: 'col-open' };
const progressTarget: ExternalTaskMoveTarget = {
  columnKey: 'col-progress',
  name: 'In Progress',
  remoteId: null,
  remoteStatusIds: ['status-progress'],
  synthetic: false,
};
const doneTarget: ExternalTaskMoveTarget = {
  columnKey: 'col-done',
  name: 'Done',
  remoteId: null,
  remoteStatusIds: ['status-done'],
  synthetic: false,
};

function detailFetchCount(): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith('/tasks/ENG-1') && !init?.method,
  ).length;
}

function statusWriteCount(): number {
  return fetchMock.mock.calls.filter(([url, _init]) => String(url).endsWith('/status')).length;
}

describe('resolveExternalMoveOptions', () => {
  it('intersects option and target status IDs before any name matching', () => {
    const options = [
      optionFixture('21', 'In Progress', 'status-progress', 'active'),
      optionFixture('todo', 'Backlog', 'status-backlog', 'active'),
    ];
    const target: ExternalTaskMoveTarget = {
      columnKey: 'col',
      name: 'Totally Different Name',
      remoteId: null,
      remoteStatusIds: ['status-progress'],
      synthetic: false,
    };

    expect(resolveExternalMoveOptions('jira', options, target)).toEqual([options[0]]);
    expect(resolveExternalMoveOptions('clickup', options, target)).toEqual([options[0]]);
  });

  it('falls back to an exact status name only for ClickUp without status IDs', () => {
    const options = [optionFixture('qa', 'QA Review', 'status-qa', 'active')];
    const noIdTarget: ExternalTaskMoveTarget = {
      columnKey: 'col-qa',
      name: 'QA Review',
      remoteId: null,
      remoteStatusIds: [],
      synthetic: false,
    };
    const mismatch: ExternalTaskMoveTarget = {
      ...noIdTarget,
      name: 'qa review',
    };

    expect(resolveExternalMoveOptions('clickup', options, noIdTarget)).toEqual([options[0]]);
    expect(resolveExternalMoveOptions('clickup', options, mismatch)).toEqual([]);
    expect(resolveExternalMoveOptions('jira', options, noIdTarget)).toEqual([]);
  });

  it('never resolves a synthetic target', () => {
    const options = [optionFixture('31', 'Done', 'status-done', 'completed')];
    const other: ExternalTaskMoveTarget = {
      columnKey: 'other',
      name: 'Other',
      remoteId: null,
      remoteStatusIds: [],
      synthetic: true,
    };

    expect(resolveExternalMoveOptions('clickup', options, other)).toEqual([]);
  });
});

describe('applyOptimisticMoveSnapshot', () => {
  it('removes every matching entry on an active-only completed move and decrements each affected count once', () => {
    const snapshot = snapshotFixture();
    const originalEng2 = snapshot.tasks[1];
    const originalBoard1 = snapshot.workAreas[0];

    const next = applyOptimisticMoveSnapshot(
      snapshot,
      'ENG-1',
      optionFixture('31', 'Done', 'status-done', 'completed'),
      true,
    );

    expect(next.tasks.map((entry) => entry.task.remoteId)).toEqual(['ENG-2']);
    expect(next.tasks[0]).toBe(originalEng2);
    expect(next.workAreas).toEqual([
      { ...originalBoard1, assignedTaskCount: 1 },
      { ...snapshot.workAreas[1]!, assignedTaskCount: 0 },
    ]);
    // The source snapshot is never mutated.
    expect(snapshot.tasks).toHaveLength(3);
    expect(originalBoard1.assignedTaskCount).toBe(2);
  });

  it('clamps decremented work-area counts at zero', () => {
    const snapshot = snapshotFixture();
    snapshot.workAreas = [workAreaFixture('board-1', 0), workAreaFixture('board-2', 1)];
    snapshot.tasks = [
      { workArea: snapshot.workAreas[0]!, task: taskFixture('ENG-1') },
      { workArea: snapshot.workAreas[1]!, task: taskFixture('ENG-1') },
    ];

    const next = applyOptimisticMoveSnapshot(
      snapshot,
      'ENG-1',
      optionFixture('31', 'Done', 'status-done', 'completed'),
      true,
    );

    expect(next.workAreas.map((workArea) => workArea.assignedTaskCount)).toEqual([0, 0]);
  });

  it('patches every same-ID task copy in place for non-removal moves', () => {
    const snapshot = snapshotFixture();
    const originalEng2 = snapshot.tasks[1];

    const next = applyOptimisticMoveSnapshot(
      snapshot,
      'ENG-1',
      optionFixture('21', 'In Progress', 'status-progress', 'active'),
      true,
    );

    const moved = next.tasks.filter((entry) => entry.task.remoteId === 'ENG-1');
    expect(moved).toHaveLength(2);
    for (const entry of moved) {
      expect(entry.task.status).toEqual({
        remoteId: 'status-progress',
        name: 'In Progress',
        category: 'active',
      });
    }
    expect(next.tasks[1]).toBe(originalEng2);
    expect(next.workAreas[0]!.assignedTaskCount).toBe(2);
  });
});

describe('useExternalTaskMove', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            remoteTaskId: 'ENG-1',
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        });
      }
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([
              optionFixture('21', 'In Progress', 'status-progress', 'active'),
              optionFixture('31', 'Done', 'status-done', 'completed'),
            ]),
        });
      }
      if (String(url).includes('includeCompleted=')) {
        return Promise.resolve({ ok: true, json: async () => snapshotFixture() });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
  });

  afterEach(() => queryClient.clear());

  function seedLanding(snapshot: SupportedSnapshot = snapshotFixture()): SupportedSnapshot {
    queryClient.setQueryData(landingActiveKey, snapshot);
    queryClient.setQueryData(landingCompletedKey, snapshot);
    return snapshot;
  }

  it('tracks drag identity without any provider request', () => {
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.startDrag(source));

    expect(result.current.dragSource).toEqual(source);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('announces keyboard boundary attempts without a provider request', () => {
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.notifyBoundary());

    expect(result.current.announcement).toBe(MOVE_BOUNDARY_ANNOUNCEMENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('performs one fresh detail load and one status write per requested move', async () => {
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    expect(detailFetchCount()).toBe(1);
    expect(statusWriteCount()).toBe(1);
    const [, init] = fetchMock.mock.calls.find(([url, _init]) => String(url).endsWith('/status'))!;
    expect(init).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: '21' }),
      }),
    );
    expect(result.current.pendingTaskId).toBeNull();
    expect(result.current.isMovePending).toBe(false);
    expect(result.current.settledMove).toEqual({
      taskId: 'ENG-1',
      removed: false,
      nonce: 1,
    });
  });

  it('issues at most one remote write for two same-tick move requests', async () => {
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    expect(detailFetchCount()).toBe(1);
    expect(statusWriteCount()).toBe(1);
  });

  it('reloads current transitions for a second consecutive move', async () => {
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));
    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    expect(detailFetchCount()).toBe(2);
    expect(statusWriteCount()).toBe(2);
  });

  it.each([
    ['missing target', { source, target: null }, MOVE_UNAVAILABLE_ANNOUNCEMENT],
    [
      'synthetic target',
      { source, target: { ...progressTarget, synthetic: true } },
      MOVE_UNAVAILABLE_ANNOUNCEMENT,
    ],
    [
      'same-column drop',
      { source, target: { ...progressTarget, columnKey: source.columnKey } },
      null,
    ],
  ])('rejects a %s before any provider request', async (_case, request, expected) => {
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove(request);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.announcement).toBe(expected);
    expect(result.current.isMovePending).toBe(false);
  });

  it.each([
    [
      'observed column without status IDs',
      {
        columnKey: 'col-observed',
        name: 'Observed',
        remoteId: null,
        remoteStatusIds: [],
        synthetic: false,
      },
    ],
    ['empty unmapped column', { ...progressTarget, remoteStatusIds: [] }],
  ])('produces no write for a %s and releases the latch', async (_case, target) => {
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_UNAVAILABLE_ANNOUNCEMENT));

    expect(detailFetchCount()).toBe(1);
    expect(statusWriteCount()).toBe(0);

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));
    expect(statusWriteCount()).toBe(1);
  });

  it('produces no write when the provider marks status change unsupported', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/tasks/ENG-1')) {
        const detail = detailFixture([
          optionFixture('21', 'In Progress', 'status-progress', 'active'),
        ]);
        detail.actions = detail.actions.map((action) =>
          action.action === 'change_status' ? { ...action, supported: false } : action,
        );
        return Promise.resolve({ ok: true, json: async () => detail });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_UNAVAILABLE_ANNOUNCEMENT));

    expect(statusWriteCount()).toBe(0);
  });

  it('snapshots choice context that survives drag-end cleanup and writes the chosen transition', async () => {
    seedLanding();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            remoteTaskId: 'ENG-1',
            action: 'change_status',
            succeeded: true,
            refresh: ['my_work', 'task_detail'],
          }),
        });
      }
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([
              optionFixture('31', 'Done', 'status-done', 'completed'),
              optionFixture('61', 'Done', 'status-done', 'completed'),
            ]),
        });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.startDrag(source));
    await act(async () => {
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.choice).not.toBeNull());

    const choice = result.current.choice!;
    expect(choice.taskId).toBe('ENG-1');
    expect(choice.taskTitle).toBe('Ship moves');
    expect(choice.target).toEqual(doneTarget);
    expect(choice.options.map((option) => option.actionValue)).toEqual(['31', '61']);
    expect(result.current.announcement).toBe(MOVE_CHOICE_ANNOUNCEMENT);

    act(() => result.current.endDrag());
    expect(result.current.dragSource).toBeNull();
    expect(result.current.choice).not.toBeNull();

    await act(async () => {
      result.current.resolveChoice(choice.options[1]!);
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    const [, init] = fetchMock.mock.calls.find(([url, _init]) => String(url).endsWith('/status'))!;
    expect(init).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: '61' }),
      }),
    );
    expect(result.current.choice).toBeNull();
    expect(result.current.pendingTaskId).toBeNull();
  });

  it('issues at most one remote write for two same-tick transition choices', async () => {
    seedLanding();
    let resolveWrite!: (response: {
      ok: boolean;
      json: () => Promise<Record<string, unknown>>;
    }) => void;
    const pendingWrite = new Promise<{
      ok: boolean;
      json: () => Promise<Record<string, unknown>>;
    }>((resolve) => {
      resolveWrite = resolve;
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return pendingWrite;
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([
              optionFixture('31', 'Done', 'status-done', 'completed'),
              optionFixture('61', 'Done', 'status-done', 'completed'),
            ]),
        });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    act(() => result.current.requestMove({ source, target: doneTarget }));
    await waitFor(() => expect(result.current.choice).not.toBeNull());
    const option = result.current.choice!.options[0]!;

    act(() => {
      result.current.resolveChoice(option);
      result.current.resolveChoice(option);
    });

    expect(statusWriteCount()).toBe(1);
    expect(result.current.isChoiceResolving).toBe(true);
    expect(result.current.announcement).toBe(MOVE_PENDING_ANNOUNCEMENT);

    await act(async () => {
      resolveWrite({
        ok: true,
        json: async () => ({
          remoteTaskId: 'ENG-1',
          action: 'change_status',
          succeeded: true,
          refresh: ['my_work', 'task_detail'],
        }),
      });
      await pendingWrite;
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    expect(result.current.isChoiceResolving).toBe(false);
    expect(result.current.choice).toBeNull();
  });

  it('releases the latch when the choice dialog is canceled', async () => {
    seedLanding();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([
              optionFixture('31', 'Done', 'status-done', 'completed'),
              optionFixture('61', 'Done', 'status-done', 'completed'),
            ]),
        });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.choice).not.toBeNull());

    act(() => result.current.cancelChoice());

    expect(result.current.choice).toBeNull();
    expect(result.current.announcement).toBe(MOVE_CANCELED_ANNOUNCEMENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('patches every same-ID task copy optimistically and keeps the patch on success', async () => {
    const snapshot = seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    const landing = queryClient.getQueryData<SupportedSnapshot>(landingActiveKey)!;
    expect(landing.tasks).not.toBe(snapshot.tasks);
    for (const entry of landing.tasks.filter((item) => item.task.remoteId === 'ENG-1')) {
      expect(entry.task.status).toEqual({
        remoteId: 'status-progress',
        name: 'In Progress',
        category: 'active',
      });
    }
    // Success marks both landing scopes stale without an immediate refetch.
    expect(queryClient.getQueryState(landingActiveKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(landingCompletedKey)?.isInvalidated).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted='))).toBe(
      false,
    );
    // The task detail cache is invalidated so the next dialog open reloads.
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it('removes active-only completed moves from the snapshot and decrements each affected count once', async () => {
    const snapshot = seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    const landing = queryClient.getQueryData<SupportedSnapshot>(landingActiveKey)!;
    expect(landing.tasks.map((entry) => entry.task.remoteId)).toEqual(['ENG-2']);
    expect(landing.workAreas.map((workArea) => workArea.assignedTaskCount)).toEqual([1, 0]);
    expect(snapshot.tasks).toHaveLength(3);
    expect(result.current.settledMove).toEqual({
      taskId: 'ENG-1',
      removed: true,
      nonce: 1,
    });
  });

  it('keeps a completed move visible in a completed-inclusive scope', async () => {
    seedLanding();
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: true }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.announcement).toBe(MOVE_SUCCESS_ANNOUNCEMENT));

    const landing = queryClient.getQueryData<SupportedSnapshot>(landingCompletedKey)!;
    expect(landing.tasks).toHaveLength(3);
    for (const entry of landing.tasks.filter((item) => item.task.remoteId === 'ENG-1')) {
      expect(entry.task.status.category).toBe('completed');
    }
    expect(landing.workAreas.map((workArea) => workArea.assignedTaskCount)).toEqual([2, 1]);
  });

  it('restores the exact prior snapshot and reconciles when the write fails', async () => {
    const snapshot = seedLanding();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ message: 'Provider unavailable' }),
        });
      }
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([optionFixture('21', 'In Progress', 'status-progress', 'active')]),
        });
      }
      if (String(url).includes('includeCompleted=')) {
        return Promise.resolve({ ok: true, json: async () => snapshotFixture() });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const { result } = renderHook(
      () => useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.requestMove({ source, target: progressTarget });
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(landingActiveKey)?.isInvalidated).toBe(true),
    );

    // The saved snapshot is restored content-exact (structural sharing keeps
    // unchanged sub-objects by reference).
    expect(queryClient.getQueryData<SupportedSnapshot>(landingActiveKey)).toStrictEqual(snapshot);
    expect(result.current.announcement).toBe(MOVE_FAILED_ANNOUNCEMENT);
    expect(result.current.pendingTaskId).toBeNull();
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it('clears in-flight state when the connection epoch changes', async () => {
    seedLanding();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([
              optionFixture('31', 'Done', 'status-done', 'completed'),
              optionFixture('61', 'Done', 'status-done', 'completed'),
            ]),
        });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const { result, rerender } = renderHook(
      (epoch: string | null) =>
        useExternalTaskMove('jira', { connectionEpoch: epoch, includeCompleted: false }),
      { wrapper: wrapper(queryClient), initialProps: connectionEpoch },
    );

    act(() => result.current.startDrag(source));
    await act(async () => {
      result.current.requestMove({ source, target: doneTarget });
    });
    await waitFor(() => expect(result.current.choice).not.toBeNull());

    rerender('connection-jira-a:2');

    expect(result.current.choice).toBeNull();
    expect(result.current.dragSource).toBeNull();
    expect(result.current.pendingTaskId).toBeNull();
  });
});

describe('useExternalTaskMove landing reconciliation', () => {
  it('refetches the active landing query after a failed write', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ message: 'Provider unavailable' }),
        });
      }
      if (String(url).endsWith('/tasks/ENG-1')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            detailFixture([optionFixture('21', 'In Progress', 'status-progress', 'active')]),
        });
      }
      if (String(url).includes('includeCompleted=false')) {
        return Promise.resolve({ ok: true, json: async () => snapshotFixture() });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    });
    const snapshot = snapshotFixture();
    queryClient.setQueryData(landingActiveKey, snapshot);

    const { result } = renderHook(
      () => ({
        move: useExternalTaskMove('jira', { connectionEpoch, includeCompleted: false }),
        landing: useQuery({
          queryKey: landingActiveKey,
          queryFn: ({ signal }) =>
            fetchJsonOrThrow<ExternalMyWorkResult>(
              '/api/integrations/my-work/jira?includeCompleted=false',
              { signal },
              'Assigned work could not be loaded.',
              '',
              fetchMock as unknown as FetchFn,
            ),
        }),
      }),
      { wrapper: wrapper(queryClient) },
    );

    expect(result.current.landing.data).toBe(snapshot);

    await act(async () => {
      result.current.move.requestMove({ source, target: progressTarget });
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('includeCompleted=false')),
      ).toBe(true),
    );
    await waitFor(() => expect(result.current.landing.isSuccess).toBe(true));

    expect(queryClient.getQueryData<SupportedSnapshot>(landingActiveKey)!.tasks).toHaveLength(3);
    queryClient.clear();
  });
});
