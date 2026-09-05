import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalTaskLinks } from './useExternalTaskLinks';

const fetchMock = jest.fn();
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Echo server: resolves each request with a summary for every requested item. */
function echoLinkStates(
  url: string,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}> {
  void url;
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    items: Array<{ scopeKey: string; taskId: string }>;
  };
  return Promise.resolve({
    ok: true,
    json: async () => ({
      items: body.items.map((item) => ({
        ...item,
        linked: true,
        epicId: `epic-${item.taskId}`,
        projectId: 'project-1',
        projectName: 'Product',
        loggedMinutes: 30,
      })),
    }),
  });
}

describe('useExternalTaskLinks', () => {
  const connectionEpoch = 'connection-jira-a:1';
  beforeEach(() => fetchMock.mockReset());

  it('loads all card link states in one provider request', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const items = [
      { scopeKey: 'site', taskId: 'ENG-2' },
      { scopeKey: 'site', taskId: 'ENG-1' },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            scopeKey: 'site',
            taskId: 'ENG-1',
            linked: true,
            epicId: 'epic-1',
            projectId: 'project-1',
            projectName: 'Product',
            loggedMinutes: 75,
          },
          {
            scopeKey: 'site',
            taskId: 'ENG-2',
            linked: false,
            epicId: null,
            projectId: null,
            projectName: null,
            loggedMinutes: null,
          },
        ],
      }),
    });

    const { result } = renderHook(
      () => useExternalTaskLinks('jira', items, { connectionEpoch, projectId: PROJECT_ID }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integrations/my-work/jira/links/batch?projectId=${PROJECT_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [...items].reverse(),
          includeLoggedMinutes: false,
        }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(result.current.data?.items[0]).toMatchObject({ taskId: 'ENG-1', loggedMinutes: 75 });
    client.clear();
  });

  it('hides cached link data and issues no request while disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const inputs = [{ scopeKey: 'site', taskId: 'ENG-1' }];
    client.setQueryData(
      [...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false), inputs],
      {
        items: [{ ...inputs[0], linked: true, epicId: 'epic-1', loggedMinutes: null }],
      },
    );

    const { result } = renderHook(
      () =>
        useExternalTaskLinks('jira', inputs, {
          enabled: false,
          connectionEpoch,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    client.clear();
  });

  it('keeps previous badges as placeholder data but suppresses placeholder time figures', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    let resolvePending: ((value: { ok: true; json: () => Promise<unknown> }) => void) | null = null;
    fetchMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                scopeKey: 'site',
                taskId: 'ENG-1',
                linked: true,
                epicId: 'epic-1',
                loggedMinutes: 75,
              },
              { scopeKey: 'site', taskId: 'ENG-2', linked: false, epicId: null, loggedMinutes: 0 },
            ],
          }),
        });
      }
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    });
    const twoItems = [
      { scopeKey: 'site', taskId: 'ENG-1' },
      { scopeKey: 'site', taskId: 'ENG-2' },
    ];
    const { result, rerender } = renderHook(
      ({ inputs }: { inputs: typeof twoItems }) =>
        useExternalTaskLinks('jira', inputs, { connectionEpoch, projectId: PROJECT_ID }),
      { wrapper: wrapper(client), initialProps: { inputs: twoItems } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items).toEqual([
      expect.objectContaining({ taskId: 'ENG-1', loggedMinutes: 75 }),
      expect.objectContaining({ taskId: 'ENG-2', loggedMinutes: 0 }),
    ]);

    // A completed removal shrinks the input set; the remaining badge must not
    // blink off while the new query is pending, but time figures never render
    // from the previous input set.
    rerender({ inputs: [twoItems[0]!] });

    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data!.items.map((item) => item.taskId)).toEqual(['ENG-1', 'ENG-2']);
    expect(result.current.data!.items.every((item) => item.loggedMinutes === null)).toBe(true);

    await act(async () => {
      resolvePending?.({
        ok: true,
        json: async () => ({
          items: [
            { scopeKey: 'site', taskId: 'ENG-1', linked: false, epicId: null, loggedMinutes: 0 },
          ],
        }),
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items.map((item) => item.taskId)).toEqual(['ENG-1']);
    expect(result.current.data!.items[0]!.loggedMinutes).toBe(0);
    client.clear();
  });

  it('sends exactly one request for a 1,000-identity board', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockImplementation(echoLinkStates);
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      scopeKey: 'site',
      taskId: `ENG-${index}`,
    }));

    const { result } = renderHook(
      () => useExternalTaskLinks('jira', items, { connectionEpoch, projectId: PROJECT_ID }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/integrations/my-work/jira/links/batch?projectId=${PROJECT_ID}`);
    expect((JSON.parse(String(init.body)) as { items: unknown[] }).items).toHaveLength(1_000);
    expect(result.current.data?.items).toHaveLength(1_000);
    client.clear();
  });

  it('splits a 1,001-identity board into deterministic chunks and merges them in order', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockImplementation(echoLinkStates);
    // Reverse order proves normalization: the first chunk starts at ENG-0.
    const items = Array.from({ length: 1_001 }, (_, index) => ({
      scopeKey: 'site',
      taskId: `ENG-${String(1_000 - index).padStart(4, '0')}`,
    }));

    const { result } = renderHook(
      () => useExternalTaskLinks('jira', items, { connectionEpoch, projectId: PROJECT_ID }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstChunk = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      items: string[];
    };
    const secondChunk = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as {
      items: string[];
    };
    expect(firstChunk.items).toHaveLength(1_000);
    expect(secondChunk.items).toHaveLength(1);
    expect(result.current.data?.items).toHaveLength(1_001);
    expect(result.current.data?.items.map((item) => item.taskId)).toEqual(
      items.map((item) => item.taskId).sort(),
    );
    client.clear();
  });

  it('deduplicates repeated identities into one request item', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockImplementation(echoLinkStates);

    const { result } = renderHook(
      () =>
        useExternalTaskLinks(
          'jira',
          [
            { scopeKey: 'site', taskId: 'ENG-2' },
            { scopeKey: 'site', taskId: 'ENG-1' },
            { scopeKey: 'site', taskId: 'ENG-2' },
          ],
          { connectionEpoch, projectId: PROJECT_ID },
        ),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      items: Array<{ taskId: string }>;
    };
    expect(body.items.map((item) => item.taskId)).toEqual(['ENG-1', 'ENG-2']);
    expect(result.current.data?.items).toHaveLength(2);
    client.clear();
  });

  it('fails the whole decoration query when a later chunk fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.reject(new Error('network failed'));
      }
      return echoLinkStates(url, init);
    });
    const items = Array.from({ length: 1_001 }, (_, index) => ({
      scopeKey: 'site',
      taskId: `ENG-${index}`,
    }));

    const { result } = renderHook(
      () => useExternalTaskLinks('jira', items, { connectionEpoch, projectId: PROJECT_ID }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBeUndefined();
    client.clear();
  });

  it('isolates pure and enriched variants in separate cache entries', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const inputs = [{ scopeKey: 'site', taskId: 'ENG-1' }];
    client.setQueryData(
      [...externalMyWorkQueryKeys.linksBatch('jira', connectionEpoch, false), inputs],
      { items: [{ ...inputs[0], linked: true, epicId: 'epic-pure', loggedMinutes: null }] },
    );
    let resolveEnriched: ((value: { ok: true; json: () => Promise<unknown> }) => void) | null =
      null;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveEnriched = resolve;
      }),
    );

    const { result } = renderHook(
      () =>
        useExternalTaskLinks('jira', inputs, {
          connectionEpoch,
          includeLoggedMinutes: true,
          projectId: PROJECT_ID,
        }),
      { wrapper: wrapper(client) },
    );

    // The enriched variant never adopts the pure variant's cached entry.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { includeLoggedMinutes: boolean })
        .includeLoggedMinutes,
    ).toBe(true);

    await act(async () => {
      resolveEnriched?.({
        ok: true,
        json: async () => ({
          items: [{ ...inputs[0], linked: true, epicId: 'epic-enriched', loggedMinutes: 75 }],
        }),
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]).toMatchObject({
      epicId: 'epic-enriched',
      loggedMinutes: 75,
    });
    client.clear();
  });
});
