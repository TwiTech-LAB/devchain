import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalTaskTimeEntries } from './useExternalTaskTimeEntries';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const connectionEpoch = 'connection-jira-a:4';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const historyPayload = {
  windowDays: 30,
  entries: [
    {
      remoteId: '10001',
      durationMs: 3_600_000,
      startedAt: '2026-08-19T10:00:00.000Z',
      note: 'Implementation',
      noteTruncated: false,
      canEdit: true,
      canDelete: true,
    },
  ],
  truncated: false,
  hasRunningTimer: false,
};

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function renderTimeEntries(
  queryClient: QueryClient,
  overrides: Partial<Parameters<typeof useExternalTaskTimeEntries>[2]> = {},
) {
  return renderHook(
    () =>
      useExternalTaskTimeEntries('jira', 'ENG-1', {
        enabled: true,
        historyOpen: true,
        connectionEpoch,
        projectId: PROJECT_ID,
        remoteScopeKey: 'acme.atlassian.net',
        identityAccepted: true,
        timeTrackingEnabled: true,
        ...overrides,
      }),
    { wrapper: wrapper(queryClient) },
  );
}

describe('useExternalTaskTimeEntries', () => {
  let queryClient: QueryClient;
  let cryptoRandomUuid: jest.SpyInstance;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    cryptoRandomUuid = jest
      .spyOn(window.crypto, 'randomUUID')
      .mockReturnValue('generated-operation-id');
  });

  afterEach(() => {
    cryptoRandomUuid.mockRestore();
    jest.useRealTimers();
    queryClient.clear();
  });

  function historyCalls(): Array<[string, RequestInit | undefined]> {
    return fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/time-entries?') && !init?.method,
    ) as Array<[string, RequestInit | undefined]>;
  }

  it('loads history with the epoch precondition header', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-entries?'))
        return Promise.resolve(jsonResponse(historyPayload));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient);

    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));
    expect(result.current.history.data).toEqual(historyPayload);
    const [url, init] = historyCalls()[0]!;
    expect(url).toBe(
      `/api/integrations/my-work/jira/tasks/ENG-1/time-entries?projectId=${PROJECT_ID}`,
    );
    expect((init?.headers as Record<string, string>)['X-DevChain-Connection-Epoch']).toBe('4');
  });

  it.each([
    ['identity unaccepted', { identityAccepted: false }],
    ['log_time capability off', { timeTrackingEnabled: false }],
    ['disabled', { enabled: false }],
    ['history closed', { historyOpen: false }],
    ['remote scope unresolved', { remoteScopeKey: null }],
  ])('issues no request and hides cached data while %s', async (_case, overrides) => {
    fetchMock.mockResolvedValue(jsonResponse(historyPayload));

    // Warm the cache first under accepted conditions.
    const first = renderTimeEntries(queryClient);
    await waitFor(() => expect(first.result.current.history.isSuccess).toBe(true));
    first.unmount();

    fetchMock.mockClear();
    const suppressed = renderTimeEntries(queryClient, overrides);

    expect(suppressed.result.current.history.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    suppressed.unmount();
  });

  it('creates while history is closed and invalidates history plus exact task detail only', async () => {
    queryClient.setQueryData(externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'), {
      remoteId: 'ENG-1',
    });
    queryClient.setQueryData(
      externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
      { pages: [], pageParams: [] },
    );
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ outcome: 'created', remoteEntryId: '10002', refresh: ['task_detail'] }),
        );
      }
      if (String(url).includes('/time-entries?')) {
        return Promise.resolve(jsonResponse(historyPayload));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    expect(result.current.history.data).toBeUndefined();
    expect(historyCalls()).toHaveLength(0);
    invalidate.mockClear();
    fetchMock.mockClear();

    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(createCall[0]).toBe(
      `/api/integrations/my-work/jira/tasks/ENG-1/time-entries?scopeKey=${encodeURIComponent('acme.atlassian.net')}&projectId=${PROJECT_ID}`,
    );
    const headers = (createCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-DevChain-Connection-Epoch']).toBe('4');
    expect(headers['Idempotency-Key']).toBe('generated-operation-id');
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({ startedAt: '2026-08-22T11:30:00.000Z', durationMs: 1_800_000, note: null }),
    );
    expect(historyCalls()).toHaveLength(0);

    // Exactly two invalidations: the sibling history and the exact detail —
    // never comments or the landing family.
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
  });

  it('updates one remote entry with receipt headers and refreshes only history and detail', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries/10001?') && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ outcome: 'updated' }));
      }
      if (String(url).includes('/time-entries?') && !init?.method) {
        return Promise.resolve(jsonResponse(historyPayload));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { result } = renderTimeEntries(queryClient);
    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));
    invalidate.mockClear();

    act(() => {
      result.current.submitUpdate('10001', {
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 5_400_000,
        note: 'Revised',
      });
    });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));

    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/time-entries/10001?') && init?.method === 'PUT',
    )!;
    expect(updateCall[0]).toBe(
      `/api/integrations/my-work/jira/tasks/ENG-1/time-entries/10001?scopeKey=${encodeURIComponent('acme.atlassian.net')}&projectId=${PROJECT_ID}`,
    );
    expect((updateCall[1] as RequestInit).headers).toMatchObject({
      'X-DevChain-Connection-Epoch': '4',
      'Idempotency-Key': 'generated-operation-id',
    });
    expect(JSON.parse(String((updateCall[1] as RequestInit).body))).toEqual({
      startedAt: '2026-08-22T11:30:00.000Z',
      durationMs: 5_400_000,
      note: 'Revised',
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
  });

  it('locks the form after an unknown create until verification resolves', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/time-operations/')) {
        return Promise.resolve(
          jsonResponse({
            receipt: { operationId: 'op-1', phase: 'succeeded' },
            resolved: true,
            resolution: 'created',
          }),
        );
      }
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
          }),
        );
      }
      if (String(url).includes('/time-entries?')) {
        return Promise.resolve(jsonResponse(historyPayload));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });

    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));
    expect(result.current.unknownOperationId).toBe('op-1');

    // A new create is refused while the unknown stands — no new request.
    const callsBefore = fetchMock.mock.calls.length;
    act(() => {
      result.current.submitCreate({
        startedAt: '2026-08-22T12:00:00.000Z',
        durationMs: 60_000,
        note: null,
      });
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    await act(async () => {
      result.current.verifyUnknown('op-1');
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(false));
    const verifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/time-operations/op-1/verify'),
    )!;
    expect(verifyCall).toBeDefined();
  });

  it('unlocks through duplicate-risk acknowledgement without another dispatch', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/acknowledge')) {
        return Promise.resolve(jsonResponse({ operationId: 'op-1', phase: 'abandoned_unknown' }));
      }
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));

    await act(async () => {
      result.current.acknowledgeUnknown('op-1');
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(false));
    const acknowledgeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/time-operations/op-1/acknowledge'),
    )!;
    expect((acknowledgeCall[1] as RequestInit).method).toBe('POST');
  });

  it('clears the unknown lock and operation state when the task changes', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-task-a', phase: 'outcome_unknown' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const initialProps = { provider: 'jira' as const, taskId: 'ENG-1' };
    const { result, rerender } = renderHook(
      ({ provider, taskId }) =>
        useExternalTaskTimeEntries(provider, taskId, {
          enabled: true,
          historyOpen: true,
          connectionEpoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));
    expect(result.current.unknownOperationId).toBe('op-task-a');

    rerender({ provider: 'jira', taskId: 'ENG-2' });

    // Task B's form starts unlocked, with no leftover operation from task A.
    expect(result.current.blockedByUnknown).toBe(false);
    expect(result.current.unknownOperationId).toBeNull();
    expect(result.current.create.data).toBeUndefined();
    expect(result.current.create.isSuccess).toBe(false);
  });

  it('keeps a pending create guarded across an epoch change and carries a late unknown lock', async () => {
    let resolveCreate:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (String(url).includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'op-late', phase: 'abandoned_unknown' }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { connectionEpoch };
    const { result, rerender } = renderHook(
      ({ connectionEpoch: epoch }) =>
        useExternalTaskTimeEntries('jira', 'ENG-1', {
          enabled: true,
          historyOpen: false,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    act(() => {
      result.current.submitCreate(
        {
          startedAt: '2026-08-22T11:30:00.000Z',
          durationMs: 1_800_000,
          note: null,
        },
        'estimate',
      );
    });
    await waitFor(() => expect(result.current.create.isPending).toBe(true));

    rerender({ connectionEpoch: 'connection-jira-b:5' });
    expect(result.current.create.isPending).toBe(false);
    expect(result.current.writeBlocked).toBe(true);
    const callsBeforeCompetingWrite = fetchMock.mock.calls.length;
    act(() => result.current.submitDelete('10001'));
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeCompetingWrite);

    resolveCreate!(
      jsonResponse({
        outcome: 'outcome_unknown',
        receipt: { operationId: 'op-late', phase: 'outcome_unknown' },
      }),
    );
    await waitFor(() => expect(result.current.unknownOperationId).toBe('op-late'));
    expect(result.current.blockedByUnknown).toBe(true);
    expect(result.current.canVerifyUnknown).toBe(false);

    const callsBeforeVerify = fetchMock.mock.calls.length;
    act(() => result.current.verifyUnknown('op-late'));
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeVerify);

    act(() => result.current.acknowledgeUnknown('op-late'));
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(false));
    const acknowledgeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/time-operations/op-late/acknowledge'),
    )!;
    expect(
      ((acknowledgeCall[1] as RequestInit).headers as Record<string, string>)[
        'X-DevChain-Connection-Epoch'
      ],
    ).toBe('5');
  });

  it('keeps a pending delete guarded across an epoch change without stale invalidation', async () => {
    let resolveDelete:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Promise((resolve) => {
          resolveDelete = resolve;
        });
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { connectionEpoch };
    const { result, rerender } = renderHook(
      ({ connectionEpoch: epoch }) =>
        useExternalTaskTimeEntries('jira', 'ENG-1', {
          enabled: true,
          historyOpen: false,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    act(() => result.current.submitDelete('10001'));
    await waitFor(() => expect(result.current.delete.isPending).toBe(true));
    rerender({ connectionEpoch: 'connection-jira-b:5' });
    expect(result.current.delete.isPending).toBe(false);
    expect(result.current.writeBlocked).toBe(true);
    const callsBeforeCompetingWrite = fetchMock.mock.calls.length;
    act(() =>
      result.current.submitCreate({
        startedAt: '2026-08-22T12:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    );
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeCompetingWrite);

    invalidate.mockClear();
    resolveDelete!(
      jsonResponse({
        outcome: 'deleted',
        receipt: { operationId: 'generated-operation-id', phase: 'succeeded' },
      }),
    );
    await waitFor(() => expect(result.current.writeBlocked).toBe(false));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('clears a retained guard on a late known error without exposing stale failure state', async () => {
    let resolveCreate:
      | ((response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)
      | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { connectionEpoch };
    const { result, rerender } = renderHook(
      ({ connectionEpoch: epoch }) =>
        useExternalTaskTimeEntries('jira', 'ENG-1', {
          enabled: true,
          historyOpen: false,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    act(() =>
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      }),
    );
    await waitFor(() => expect(result.current.writeBlocked).toBe(true));
    rerender({ connectionEpoch: 'connection-jira-b:5' });
    expect(result.current.create.isPending).toBe(false);

    resolveCreate!({
      ok: false,
      status: 409,
      json: async () => ({ message: 'The connection epoch was replaced.' }),
    });
    await waitFor(() => expect(result.current.writeBlocked).toBe(false));
    expect(result.current.create.isError).toBe(false);
    expect(result.current.create.error).toBeNull();
  });

  it('hides settled operation presentation after the operation scope changes', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ outcome: 'created', remoteEntryId: '10002', refresh: ['task_detail'] }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { connectionEpoch };
    const { result, rerender } = renderHook(
      ({ connectionEpoch: epoch }) =>
        useExternalTaskTimeEntries('jira', 'ENG-1', {
          enabled: true,
          historyOpen: false,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    act(() =>
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      }),
    );
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    expect(result.current.create.data?.outcome).toBe('created');

    rerender({ connectionEpoch: 'connection-jira-b:5' });
    expect(result.current.create.isSuccess).toBe(false);
    expect(result.current.create.data).toBeUndefined();
  });

  it('ignores a late unknown result after the provider task changes', async () => {
    let resolveCreate:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { taskId: 'ENG-1' };
    const { result, rerender } = renderHook(
      ({ taskId }) =>
        useExternalTaskTimeEntries('jira', taskId, {
          enabled: true,
          historyOpen: false,
          connectionEpoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    act(() =>
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      }),
    );
    await waitFor(() => expect(result.current.writeBlocked).toBe(true));
    rerender({ taskId: 'ENG-2' });
    await waitFor(() => expect(result.current.writeBlocked).toBe(false));

    resolveCreate!(
      jsonResponse({
        outcome: 'outcome_unknown',
        receipt: { operationId: 'op-old-task', phase: 'outcome_unknown' },
      }),
    );
    await waitFor(() => expect(result.current.create.isPending).toBe(false));
    expect(result.current.blockedByUnknown).toBe(false);
    expect(result.current.unknownOperationId).toBeNull();
  });

  it('deletes with both headers and refetches the sibling history', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'deleted',
            receipt: { operationId: 'op-2', phase: 'succeeded' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient);
    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));
    invalidate.mockClear();

    await act(async () => {
      result.current.submitDelete('10001');
    });
    await waitFor(() => expect(result.current.delete.isSuccess).toBe(true));

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )!;
    expect(deleteCall[0]).toBe(
      `/api/integrations/my-work/jira/tasks/ENG-1/time-entries/10001?scopeKey=${encodeURIComponent('acme.atlassian.net')}&projectId=${PROJECT_ID}`,
    );
    const headers = (deleteCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-DevChain-Connection-Epoch']).toBe('4');
    expect(headers['Idempotency-Key']).toBe('generated-operation-id');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
  });

  it.each([
    ['identity unaccepted', { identityAccepted: false }],
    ['time capability off', { timeTrackingEnabled: false }],
    ['disabled', { enabled: false }],
  ])('refuses every mutation while %s', async (_case, overrides) => {
    const { result } = renderTimeEntries(queryClient, overrides);

    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 60_000,
        note: null,
      });
      result.current.submitDelete('10001');
      result.current.verifyUnknown('op-x');
      result.current.acknowledgeUnknown('op-x');
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.create.isIdle ?? true).toBe(true);
  });

  it.each([
    ['a supported create receipt', 'create', true],
    ['an unprovable create receipt', 'create', false],
    ['an unknown delete receipt', 'delete', true],
  ])('mirrors receipt verify availability for %s', async (_case, kind, canVerify) => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          }),
        );
      }
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      if (kind === 'delete') {
        result.current.submitDelete('10001');
      } else {
        result.current.submitCreate({
          startedAt: '2026-08-22T11:30:00.000Z',
          durationMs: 1_800_000,
          note: null,
        });
      }
    });

    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));
    expect(result.current.canVerifyUnknown).toBe(canVerify);
  });

  it('keeps Verify off for an already-expired receipt while keeping the lock', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });

    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));
    expect(result.current.canVerifyUnknown).toBe(false);
  });

  it('hides Verify when the deadline timer fires but keeps the unknown lock', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T10:00:00Z'));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: '2026-09-01T11:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });

    expect(result.current.blockedByUnknown).toBe(true);
    expect(result.current.canVerifyUnknown).toBe(true);

    act(() => {
      jest.setSystemTime(new Date('2026-09-01T11:00:01.000Z'));
      jest.advanceTimersByTime(3_601_000);
    });

    expect(result.current.canVerifyUnknown).toBe(false);
    expect(result.current.blockedByUnknown).toBe(true);
  });

  it('re-checks the wall clock when a suspended tab regains focus or visibility', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T10:00:00Z'));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: '2026-09-01T11:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });

    expect(result.current.canVerifyUnknown).toBe(true);

    // The tab slept through the deadline: no timer fired, so the stale
    // presentation stands until a resume event re-reads the clock.
    jest.setSystemTime(new Date('2026-09-01T11:30:00.000Z'));
    expect(result.current.canVerifyUnknown).toBe(true);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current.canVerifyUnknown).toBe(false);
    expect(result.current.blockedByUnknown).toBe(true);
  });

  it('re-checks the wall clock on the visibilitychange resume', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T10:00:00Z'));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'generated-operation-id',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: '2026-09-01T11:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });

    jest.setSystemTime(new Date('2026-09-01T11:30:00.000Z'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.canVerifyUnknown).toBe(false);
  });

  it.each([
    [
      'an unexpired receipt still uses the server acknowledgement endpoint',
      '2027-01-01T00:00:00.000Z',
      true,
    ],
    [
      'an already-expired receipt clears only the matching local guard',
      '2020-01-01T00:00:00.000Z',
      false,
    ],
  ])('acknowledges %s', async (_case, expiresAt, expectsServerCall) => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/acknowledge')) {
        return Promise.resolve(jsonResponse({ operationId: 'op-1', phase: 'abandoned_unknown' }));
      }
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'op-1',
              phase: 'outcome_unknown',
              canVerify: false,
              expiresAt,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));

    const callsBeforeAcknowledge = fetchMock.mock.calls.length;
    await act(async () => {
      result.current.acknowledgeUnknown('op-1');
    });

    const acknowledgeCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/acknowledge'),
    );
    if (expectsServerCall) {
      expect(acknowledgeCalls).toHaveLength(1);
    } else {
      // Expired: no receipt endpoint, no provider endpoint — the explicit
      // user action cleared the exact local guard with zero requests.
      expect(acknowledgeCalls).toHaveLength(0);
      expect(fetchMock.mock.calls).toHaveLength(callsBeforeAcknowledge);
    }
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(false));
    expect(result.current.writeBlocked).toBe(false);
  });

  it('cannot clear an expired guard through a nonmatching operation id', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'op-real',
              phase: 'outcome_unknown',
              canVerify: false,
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient, { historyOpen: false });
    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.blockedByUnknown).toBe(true));

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      result.current.acknowledgeUnknown('op-other');
    });

    expect(fetchMock.mock.calls).toHaveLength(callsBefore);
    expect(result.current.blockedByUnknown).toBe(true);
    expect(result.current.unknownOperationId).toBe('op-real');
  });

  it('cannot clear an expired guard retained across a connection-epoch change', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'op-epoch-expired', phase: 'abandoned_unknown' }),
        );
      }
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'op-epoch-expired',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });
    const initialProps = { connectionEpoch };
    const { result, rerender } = renderHook(
      ({ connectionEpoch: epoch }) =>
        useExternalTaskTimeEntries('jira', 'ENG-1', {
          enabled: true,
          historyOpen: false,
          connectionEpoch: epoch,
          projectId: PROJECT_ID,
          remoteScopeKey: 'acme.atlassian.net',
          identityAccepted: true,
          timeTrackingEnabled: true,
        }),
      { initialProps, wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 1_800_000,
        note: null,
      });
    });
    await waitFor(() => expect(result.current.unknownOperationId).toBe('op-epoch-expired'));

    // The guard survives the epoch change (duplicate risk is task-scoped),
    // but its receipt belonged to the replaced connection: the current
    // epoch's Acknowledge must neither call anything nor clear it.
    rerender({ connectionEpoch: 'connection-jira-b:5' });
    expect(result.current.blockedByUnknown).toBe(true);

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      result.current.acknowledgeUnknown('op-epoch-expired');
    });

    expect(fetchMock.mock.calls).toHaveLength(callsBefore);
    expect(result.current.blockedByUnknown).toBe(true);
    expect(result.current.unknownOperationId).toBe('op-epoch-expired');
  });
});
