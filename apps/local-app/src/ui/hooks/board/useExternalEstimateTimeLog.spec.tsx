import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalEstimateTimeLog } from './useExternalEstimateTimeLog';

const fetchMock = jest.fn();
const runtime = { runtimeResolved: true, apiBase: '' };

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));
jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => runtime,
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const connectionEpoch = 'connection-jira:4';
const scopeKey = 'acme.atlassian.net';
const readyState = {
  initialized: true,
  revision: 3,
  loggedMinutes: 90,
  pendingDisposition: 'none' as const,
  canVerify: false,
  verifyExpiresAt: null,
  pending: null,
};

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderEstimateLog(client: QueryClient, enabled = true) {
  return renderHook(
    () =>
      useExternalEstimateTimeLog('jira', 'ENG-1', {
        enabled,
        connectionEpoch,
        projectId: PROJECT_ID,
        remoteScopeKey: scopeKey,
      }),
    { wrapper: wrapper(client) },
  );
}

// Layer: hook unit. Fetch/runtime mocks own cache isolation, immutable request
// construction, and targeted invalidation without mounting the larger dialog.
describe('useExternalEstimateTimeLog', () => {
  let client: QueryClient;
  let uuidSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    runtime.runtimeResolved = true;
    runtime.apiBase = '';
    uuidSpy = jest.spyOn(window.crypto, 'randomUUID').mockReturnValue('estimate-operation-1');
  });

  afterEach(() => {
    uuidSpy.mockRestore();
    client.clear();
  });

  it('loads the guarded checkpoint with project, scope, and epoch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(readyState));
    const { result } = renderEstimateLog(client);

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.admitted).toBe(true);
    expect(result.current.state).toEqual(readyState);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/my-work/jira/tasks/ENG-1/estimate-log-state?scopeKey=${encodeURIComponent(scopeKey)}&projectId=${PROJECT_ID}`,
      {
        signal: expect.any(AbortSignal),
        headers: { 'X-DevChain-Connection-Epoch': '4' },
      },
    );
  });

  it('never exposes a primed main checkpoint in worktree, unresolved, or disabled scope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(readyState));
    const { result, rerender } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    runtime.apiBase = '/wt/demo';
    rerender();
    expect(result.current.admitted).toBe(false);
    expect(result.current.state).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.query.isSuccess).toBe(false);

    runtime.apiBase = '';
    runtime.runtimeResolved = false;
    rerender();
    expect(result.current.state).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const disabled = renderEstimateLog(client, false);
    expect(disabled.result.current.admitted).toBe(false);
    expect(disabled.result.current.query.data).toBeUndefined();
  });

  it('submits one immutable create snapshot and invalidates checkpoint, detail, and history', async () => {
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ outcome: 'logged', state: readyState }));
      }
      return Promise.resolve(
        jsonResponse({ ...readyState, initialized: false, revision: 0, loggedMinutes: 0 }),
      );
    });
    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    // Let the initial read's links refresh land before the mutation window.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
      }),
    );
    invalidate.mockClear();

    act(() => {
      result.current.submitCreate({
        estimateTotalMinutes: 120,
        expectedRevision: 0,
        timeZone: 'Europe/Madrid',
        remoteScopeKey: scopeKey,
        dailySnapshot: [
          { activityDate: '2026-08-28', minutes: 30 },
          { activityDate: '2026-08-29', minutes: 90 },
        ],
      });
    });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/estimate-time-entries?') && init?.method === 'POST',
    )!;
    expect((createCall[1] as RequestInit).headers).toEqual({
      'X-DevChain-Connection-Epoch': '4',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'estimate-operation-1',
    });
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({
        scopeKey,
        requestKey: 'estimate-operation-1',
        timeZone: 'Europe/Madrid',
        estimateTotalMinutes: 120,
        expectedRevision: 0,
        dailySnapshot: [
          { activityDate: '2026-08-28', minutes: 30 },
          { activityDate: '2026-08-29', minutes: 90 },
        ],
      }),
    );
    // The mutation settles through both the explicit captured-prefix refresh
    // and the new-snapshot effect; both hit the same links family, so the
    // exact call count can reach five while the set of targets stays fixed.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskEstimateLogState(
        'jira',
        connectionEpoch,
        PROJECT_ID,
        'ENG-1',
        scopeKey,
        'main',
      ),
      exact: true,
    });
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('sets logged minutes locally and resolves the exact durable operation', async () => {
    const pendingState = {
      ...readyState,
      revision: 4,
      pendingDisposition: 'outcome_unknown' as const,
      canVerify: true,
      pending: {
        operationId: 'pending-1',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown' as const,
        resolution: null,
      },
    };
    let state = readyState;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        state = { ...readyState, revision: 4, loggedMinutes: 60 };
        return Promise.resolve(jsonResponse(state));
      }
      if (init?.method === 'POST') {
        state = readyState;
        return Promise.resolve(jsonResponse({ outcome: 'logged', state }));
      }
      return Promise.resolve(jsonResponse(state));
    });
    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    act(() => result.current.setLoggedMinutes(60, 3));
    await waitFor(() => expect(result.current.setLogged.isSuccess).toBe(true));
    const setCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect((setCall[1] as RequestInit).body).toBe(
      JSON.stringify({ scopeKey, loggedMinutes: 60, expectedRevision: 3 }),
    );

    client.setQueryData(
      externalMyWorkQueryKeys.taskEstimateLogState(
        'jira',
        connectionEpoch,
        PROJECT_ID,
        'ENG-1',
        scopeKey,
        'main',
      ),
      pendingState,
    );
    await waitFor(() => expect(result.current.state?.pending).not.toBeNull());
    act(() => result.current.resolveOperation('pending-1', 'logged', 4));
    await waitFor(() => expect(result.current.resolve.isSuccess).toBe(true));
    const resolveCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/pending-1/resolve?') && init?.method === 'POST',
    )!;
    expect((resolveCall[1] as RequestInit).headers).toEqual(
      expect.objectContaining({ 'Idempotency-Key': 'pending-1' }),
    );
    expect((resolveCall[1] as RequestInit).body).toBe(
      JSON.stringify({ scopeKey, action: 'logged', expectedRevision: 4 }),
    );
  });

  it('refetches the checkpoint exactly once at the server-owned Verify deadline', async () => {
    const deadline = Date.now() + 300;
    const pendingState = {
      ...readyState,
      revision: 4,
      pendingDisposition: 'outcome_unknown' as const,
      canVerify: true,
      verifyExpiresAt: new Date(deadline).toISOString(),
      pending: {
        operationId: 'pending-1',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown' as const,
        resolution: null,
      },
    };
    const manualReviewState = {
      ...pendingState,
      pendingDisposition: 'manual_review' as const,
      canVerify: false,
      verifyExpiresAt: null,
    };
    let stateServed = 0;
    const stateFetchUrls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimate-log-state?'));
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/estimate-log-state?')) {
        stateServed += 1;
        return Promise.resolve(jsonResponse(stateServed === 1 ? pendingState : manualReviewState));
      }
      return Promise.resolve(jsonResponse(readyState));
    });

    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.state?.canVerify).toBe(true));
    expect(stateFetchUrls()).toHaveLength(1);

    // One deadline transition: the receipt-absolute refetch flips the
    // snapshot to server-derived manual review.
    await waitFor(
      () => {
        expect(result.current.state?.canVerify).toBe(false);
        expect(result.current.state?.pendingDisposition).toBe('manual_review');
        expect(result.current.state?.verifyExpiresAt).toBeNull();
      },
      { timeout: 2_000 },
    );
    expect(stateFetchUrls()).toHaveLength(2);

    // No polling: further waiting adds no checkpoint requests.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stateFetchUrls()).toHaveLength(2);
  });

  it('expires Verify locally when the one deadline refetch fails', async () => {
    const deadline = Date.now() + 300;
    const pendingState = {
      ...readyState,
      revision: 4,
      pendingDisposition: 'outcome_unknown' as const,
      canVerify: true,
      verifyExpiresAt: new Date(deadline).toISOString(),
      pending: {
        operationId: 'pending-expiry-failure',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown' as const,
        resolution: null,
      },
    };
    let stateFetches = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/estimate-log-state?')) {
        stateFetches += 1;
        return stateFetches === 1
          ? Promise.resolve(jsonResponse(pendingState))
          : Promise.reject(new Error('checkpoint unavailable'));
      }
      if (init?.method) {
        return Promise.reject(new Error('provider mutation must not run'));
      }
      return Promise.resolve(jsonResponse(readyState));
    });

    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.state?.canVerify).toBe(true));

    await waitFor(
      () => {
        expect(result.current.state?.canVerify).toBe(false);
        expect(result.current.query.data?.canVerify).toBe(false);
        expect(result.current.query.isError).toBe(true);
      },
      { timeout: 2_000 },
    );
    expect(result.current.state?.pending?.operationId).toBe('pending-expiry-failure');
    expect(result.current.writeBlocked).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => Boolean(init?.method))).toBe(false);
    expect(stateFetches).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stateFetches).toBe(2);
  });

  it('blocks every estimate mutation while durable pending state exists', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...readyState,
        pendingDisposition: 'manual_review',
        pending: {
          operationId: 'pending-1',
          deltaMinutes: 30,
          estimateTotalMinutes: 120,
          startedAt: '2026-08-30T10:00:00.000Z',
          phase: 'prepared',
          resolution: null,
        },
      }),
    );
    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.writeBlocked).toBe(true);
    act(() => {
      result.current.submitCreate({
        estimateTotalMinutes: 120,
        expectedRevision: 3,
        timeZone: 'UTC',
        remoteScopeKey: scopeKey,
      });
      result.current.setLoggedMinutes(60, 3);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it('fails closed after estimate response loss until a checkpoint read succeeds', async () => {
    let initialCheckpointLoaded = false;
    let reconciliationFails = true;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.reject(new Error('response lost'));
      }
      if (!initialCheckpointLoaded) {
        initialCheckpointLoaded = true;
        return Promise.resolve(jsonResponse(readyState));
      }
      if (reconciliationFails) {
        return Promise.reject(new Error('checkpoint unavailable'));
      }
      return Promise.resolve(jsonResponse(readyState));
    });
    const reset = jest.spyOn(client, 'resetQueries');
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    uuidSpy.mockReturnValueOnce('request-key-1').mockReturnValueOnce('request-key-2');
    const { result } = renderEstimateLog(client);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    act(() => {
      result.current.submitCreate({
        estimateTotalMinutes: 120,
        expectedRevision: 3,
        timeZone: 'Europe/Madrid',
        remoteScopeKey: scopeKey,
        dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
      });
    });

    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.state).toBeUndefined();
    expect(result.current.writeBlocked).toBe(true);
    // Fail-closed reset plus every provider-derived family a possibly
    // settled or unknown prefix could touch — no retry, ever.
    const stateKey = externalMyWorkQueryKeys.taskEstimateLogState(
      'jira',
      connectionEpoch,
      PROJECT_ID,
      'ENG-1',
      scopeKey,
      'main',
    );
    expect(reset).toHaveBeenCalledWith({ queryKey: stateKey, exact: true });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
    });

    reconciliationFails = false;
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.state).toEqual(readyState);
    expect(result.current.writeBlocked).toBe(false);

    // The next explicit click uses a fresh request key — never a replay.
    act(() => {
      result.current.submitCreate({
        estimateTotalMinutes: 120,
        expectedRevision: 3,
        timeZone: 'Europe/Madrid',
        remoteScopeKey: scopeKey,
        dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
      });
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length).toBe(2),
    );
    const bodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { requestKey: string });
    expect(bodies.map((body) => body.requestKey)).toEqual(['request-key-1', 'request-key-2']);
  });

  describe('link decoration invalidation', () => {
    it('refreshes the captured provider/epoch links prefix exactly once per successful fetch', async () => {
      fetchMock.mockResolvedValue(jsonResponse(readyState));
      const invalidate = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderEstimateLog(client);
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
        }),
      );
      // One fetch, one settled success, exactly one decoration refresh.
      expect(invalidate).toHaveBeenCalledTimes(1);
      // The read path refreshes link decoration only: it never invalidates
      // any checkpoint query, so the reconciliation cannot loop.
      const stateKey = externalMyWorkQueryKeys.taskEstimateLogState(
        'jira',
        connectionEpoch,
        PROJECT_ID,
        'ENG-1',
        scopeKey,
        'main',
      );
      for (const [filters] of invalidate.mock.calls) {
        expect((filters as { queryKey: readonly unknown[] }).queryKey).not.toEqual(stateKey);
      }
    });

    it('invalidates again on an equal success-to-success refetch, exactly once per fetch and without a loop', async () => {
      // Both responses are structurally equal: TanStack structural sharing
      // keeps the data reference stable, so only the successful data-update
      // timestamp can prove the second successful read reconciles decoration.
      // A strictly increasing clock keeps that timestamp collision-free even
      // when both fetches settle within one real millisecond.
      const realNow = Date.now;
      let clock = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + clock++ * 10);
      try {
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(readyState)));
        const invalidate = jest.spyOn(client, 'invalidateQueries');
        const linksInvalidations = () =>
          invalidate.mock.calls.filter(
            ([filters]) =>
              JSON.stringify((filters as { queryKey?: readonly unknown[] }).queryKey) ===
              JSON.stringify(externalMyWorkQueryKeys.links('jira', connectionEpoch)),
          ).length;
        const { result } = renderEstimateLog(client);
        await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
        await waitFor(() => expect(linksInvalidations()).toBe(1));

        await act(async () => {
          await result.current.query.refetch();
        });
        // The equal success-to-success refetch still adds exactly one
        // captured-prefix invalidation.
        await waitFor(() => expect(linksInvalidations()).toBe(2));

        // Nothing further arrives once both sides settle — no invalidation or
        // fetch loop.
        const settledCalls = invalidate.mock.calls.length;
        await act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
        });
        expect(invalidate.mock.calls.length).toBe(settledCalls);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('refreshes the links prefix after a successful Set and a resolved durable operation', async () => {
      const pendingState = {
        ...readyState,
        revision: 4,
        pendingDisposition: 'outcome_unknown' as const,
        canVerify: true,
        pending: {
          operationId: 'pending-1',
          deltaMinutes: 30,
          estimateTotalMinutes: 120,
          startedAt: '2026-08-30T10:00:00.000Z',
          phase: 'outcome_unknown' as const,
          resolution: null,
        },
      };
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return Promise.resolve(jsonResponse({ ...readyState, revision: 4, loggedMinutes: 60 }));
        }
        if (String(init?.method).toUpperCase() === 'POST') {
          return Promise.resolve(jsonResponse({ outcome: 'logged', state: readyState }));
        }
        return Promise.resolve(jsonResponse(readyState));
      });
      const invalidate = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderEstimateLog(client);
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      invalidate.mockClear();

      act(() => result.current.setLoggedMinutes(60, 3));
      await waitFor(() => expect(result.current.setLogged.isSuccess).toBe(true));
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
        }),
      );

      invalidate.mockClear();
      client.setQueryData(
        externalMyWorkQueryKeys.taskEstimateLogState(
          'jira',
          connectionEpoch,
          PROJECT_ID,
          'ENG-1',
          scopeKey,
          'main',
        ),
        pendingState,
      );
      await waitFor(() => expect(result.current.state?.pending).not.toBeNull());
      act(() => result.current.resolveOperation('pending-1', 'logged', 4));
      await waitFor(() => expect(result.current.resolve.isSuccess).toBe(true));
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
        }),
      );
    });

    it('reconciles links again after response-loss recovery', async () => {
      let initialCheckpointLoaded = false;
      let reconciliationFails = true;
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.reject(new Error('response lost'));
        }
        if (!initialCheckpointLoaded) {
          initialCheckpointLoaded = true;
          return Promise.resolve(jsonResponse(readyState));
        }
        return reconciliationFails
          ? Promise.reject(new Error('checkpoint unavailable'))
          : Promise.resolve(jsonResponse(readyState));
      });
      const invalidate = jest.spyOn(client, 'invalidateQueries');
      const linksPrefixInvalidated = () =>
        invalidate.mock.calls.some(
          ([filters]) =>
            JSON.stringify((filters as { queryKey?: readonly unknown[] }).queryKey) ===
            JSON.stringify(externalMyWorkQueryKeys.links('jira', connectionEpoch)),
        );
      const { result } = renderEstimateLog(client);
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      await waitFor(() => expect(linksPrefixInvalidated()).toBe(true));
      const callsAfterFirstRead = invalidate.mock.calls.length;

      act(() => {
        result.current.submitCreate({
          estimateTotalMinutes: 120,
          expectedRevision: 3,
          timeZone: 'UTC',
          remoteScopeKey: scopeKey,
          dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
        });
      });
      await waitFor(() => expect(result.current.create.isError).toBe(true));
      await waitFor(() => expect(result.current.query.isError).toBe(true));
      // Response loss conservatively refreshes every provider-derived family
      // a possibly settled or unknown prefix could touch.
      expect(invalidate.mock.calls.length).toBeGreaterThan(callsAfterFirstRead);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.taskDetail('jira', connectionEpoch, 'ENG-1'),
        exact: true,
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: externalMyWorkQueryKeys.taskTimeEntries('jira', connectionEpoch, 'ENG-1'),
        exact: true,
      });
      expect(linksPrefixInvalidated()).toBe(true);

      reconciliationFails = false;
      await act(async () => {
        await result.current.query.refetch();
      });
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      // The recovered snapshot is new checkpoint knowledge: link decoration
      // refreshes once more.
      await waitFor(() => expect(linksPrefixInvalidated()).toBe(true));
      expect(invalidate.mock.calls.length).toBeGreaterThan(callsAfterFirstRead);
    });

    it('settles a deferred mutation against the captured epoch prefix after the epoch switches', async () => {
      const createResponse = deferred<{ ok: true; json: () => Promise<unknown> }>();
      const nextEpochRead = deferred<{ ok: true; json: () => Promise<unknown> }>();
      let initialLoaded = false;
      let epochSwitched = false;
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return createResponse.promise;
        }
        if (!initialLoaded) {
          initialLoaded = true;
          return Promise.resolve(jsonResponse(readyState));
        }
        // The replacement epoch's own checkpoint read stays pending so only
        // the deferred settlement can invalidate in this window.
        return epochSwitched ? nextEpochRead.promise : Promise.resolve(jsonResponse(readyState));
      });
      const nextEpoch = 'connection-jira:5';
      const { result, rerender } = renderHook(
        ({ epoch }: { epoch: string }) =>
          useExternalEstimateTimeLog('jira', 'ENG-1', {
            enabled: true,
            connectionEpoch: epoch,
            projectId: PROJECT_ID,
            remoteScopeKey: scopeKey,
          }),
        { wrapper: wrapper(client), initialProps: { epoch: connectionEpoch } },
      );
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      const invalidate = jest.spyOn(client, 'invalidateQueries');
      invalidate.mockClear();

      act(() => {
        result.current.submitCreate({
          estimateTotalMinutes: 120,
          expectedRevision: 3,
          timeZone: 'UTC',
          remoteScopeKey: scopeKey,
        });
      });
      await waitFor(() => expect(result.current.create.isPending).toBe(true));
      epochSwitched = true;
      rerender({ epoch: nextEpoch });
      await act(async () => {
        createResponse.resolve(jsonResponse({ outcome: 'logged', state: readyState }));
      });

      // The settlement refreshes the captured epoch's link decoration, never
      // the replacement epoch's family. The settled mutation is presented
      // only for its own scope, so the invalidation is the observable.
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: externalMyWorkQueryKeys.links('jira', connectionEpoch),
        }),
      );
      expect(invalidate.mock.calls.map(([filters]) => filters)).not.toContainEqual({
        queryKey: externalMyWorkQueryKeys.links('jira', nextEpoch),
      });
      expect(result.current.create.data).toBeUndefined();
      expect(result.current.create.isSuccess).toBe(false);
    });
  });
});
