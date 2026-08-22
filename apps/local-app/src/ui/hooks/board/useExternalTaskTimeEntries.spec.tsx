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
const historyPayload = {
  windowDays: 30,
  entries: [
    {
      remoteId: '10001',
      durationMs: 3_600_000,
      startedAt: '2026-08-19T10:00:00.000Z',
      note: 'Implementation',
      noteTruncated: false,
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
        connectionEpoch,
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
    queryClient.clear();
  });

  function historyCalls(): Array<[string, RequestInit | undefined]> {
    return fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/time-entries') && !init?.method,
    ) as Array<[string, RequestInit | undefined]>;
  }

  it('loads history with the epoch precondition header', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/time-entries'))
        return Promise.resolve(jsonResponse(historyPayload));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient);

    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));
    expect(result.current.history.data).toEqual(historyPayload);
    const [url, init] = historyCalls()[0]!;
    expect(url).toBe('/api/integrations/my-work/jira/tasks/ENG-1/time-entries');
    expect((init?.headers as Record<string, string>)['X-DevChain-Connection-Epoch']).toBe('4');
  });

  it.each([
    ['identity unaccepted', { identityAccepted: false }],
    ['log_time capability off', { timeTrackingEnabled: false }],
    ['disabled', { enabled: false }],
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

  it('creates with both headers and refetches history plus exact task detail only', async () => {
    queryClient.setQueryData(externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'), {
      remoteId: 'ENG-1',
    });
    queryClient.setQueryData(
      externalMyWorkQueryKeys.taskComments('jira', connectionEpoch, 'ENG-1'),
      { pages: [], pageParams: [] },
    );
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ outcome: 'created', remoteEntryId: '10002', refresh: ['task_detail'] }),
        );
      }
      if (String(url).endsWith('/time-entries')) {
        return Promise.resolve(jsonResponse(historyPayload));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient);
    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));
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
    const headers = (createCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-DevChain-Connection-Epoch']).toBe('4');
    expect(headers['Idempotency-Key']).toBe('generated-operation-id');
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({ startedAt: '2026-08-22T11:30:00.000Z', durationMs: 1_800_000, note: null }),
    );

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
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
          }),
        );
      }
      if (String(url).endsWith('/time-entries')) {
        return Promise.resolve(jsonResponse(historyPayload));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { result } = renderTimeEntries(queryClient);
    await waitFor(() => expect(result.current.history.isSuccess).toBe(true));

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
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload));
    });

    const { result } = renderTimeEntries(queryClient);
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
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
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
          connectionEpoch,
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
    expect(deleteCall[0]).toBe('/api/integrations/my-work/jira/tasks/ENG-1/time-entries/10001');
    const headers = (deleteCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-DevChain-Connection-Epoch']).toBe('4');
    expect(headers['Idempotency-Key']).toBe('generated-operation-id');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
  });

  it('refuses create and delete while suppressed', () => {
    const { result } = renderTimeEntries(queryClient, { identityAccepted: false });

    act(() => {
      result.current.submitCreate({
        startedAt: '2026-08-22T11:30:00.000Z',
        durationMs: 60_000,
        note: null,
      });
      result.current.submitDelete('10001');
      result.current.verifyUnknown('op-x');
      result.current.acknowledgeUnknown('op-x');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.create.isIdle ?? true).toBe(true);
  });
});
