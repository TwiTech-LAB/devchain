import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { useExternalTaskLinks } from './useExternalTaskLinks';

const fetchMock = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useFetchFactory: () => fetchMock }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
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
          },
          {
            scopeKey: 'site',
            taskId: 'ENG-2',
            linked: false,
            epicId: null,
            projectId: null,
            projectName: null,
          },
        ],
      }),
    });

    const { result } = renderHook(() => useExternalTaskLinks('jira', items, { connectionEpoch }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/my-work/jira/links/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [...items].reverse() }),
      signal: expect.any(AbortSignal),
    });
    client.clear();
  });

  it('hides cached link data and issues no request while disabled', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const inputs = [{ scopeKey: 'site', taskId: 'ENG-1' }];
    client.setQueryData([...externalMyWorkQueryKeys.links('jira', connectionEpoch), inputs], {
      items: [{ ...inputs[0], linked: true, epicId: 'epic-1' }],
    });

    const { result } = renderHook(
      () => useExternalTaskLinks('jira', inputs, { enabled: false, connectionEpoch }),
      { wrapper: wrapper(client) },
    );

    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    client.clear();
  });

  it('keeps previous link data as placeholder while a shrunk input set loads', async () => {
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
              { scopeKey: 'site', taskId: 'ENG-1', linked: true, epicId: 'epic-1' },
              { scopeKey: 'site', taskId: 'ENG-2', linked: false, epicId: null },
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
        useExternalTaskLinks('jira', inputs, { connectionEpoch }),
      { wrapper: wrapper(client), initialProps: { inputs: twoItems } },
    );

    // First load settles with both badges.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const firstItems = result.current.data!.items;
    expect(firstItems.map((item) => item.taskId)).toEqual(['ENG-1', 'ENG-2']);

    // A completed removal shrinks the input set; the remaining badge must not
    // blink off while the new query is pending.
    rerender({ inputs: [twoItems[0]!] });

    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data!.items).toBe(firstItems);

    await act(async () => {
      resolvePending?.({
        ok: true,
        json: async () => ({
          items: [{ scopeKey: 'site', taskId: 'ENG-1', linked: false, epicId: null }],
        }),
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items.map((item) => item.taskId)).toEqual(['ENG-1']);
    client.clear();
  });
});
