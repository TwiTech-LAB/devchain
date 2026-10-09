import { QueryClient } from '@tanstack/react-query';
import { agentQueries, agentQueryKeys, fetchAgents, fetchAgentsWithGuests } from './agents';

describe('agents resource', () => {
  // A real QueryClient verifies answer separation and prefix matching without mounting React.
  it('caches plain and guest answers separately and invalidates both for one project', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const plain = { items: [{ id: 'agent-1', profileId: 'profile-1' }], total: 1 };
    const withGuests = {
      items: [
        { id: 'agent-1', type: 'agent', providerConfig: { name: 'config' } },
        { id: 'guest-1', type: 'guest', profileId: null },
      ],
      total: 2,
    };
    const fetchFn = jest.fn(
      async (input: RequestInfo | URL) =>
        ({
          ok: true,
          json: async () => (String(input).includes('includeGuests=true') ? withGuests : plain),
        }) as Response,
    );

    try {
      const list = agentQueries.list(fetchFn, 'project/one');
      const guests = agentQueries.withGuests(fetchFn, 'project/one');
      await queryClient.fetchQuery(list);
      await queryClient.fetchQuery(guests);
      await queryClient.fetchQuery(agentQueries.list(fetchFn, 'project-two'));

      expect(queryClient.getQueryData(list.queryKey)).toEqual(plain);
      expect(queryClient.getQueryData(guests.queryKey)).toEqual(withGuests);
      expect(fetchFn).toHaveBeenCalledWith('/api/agents?projectId=project%2Fone', {});
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/agents?projectId=project%2Fone&includeGuests=true',
        {},
      );

      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.project('project/one') });

      expect(queryClient.getQueryState(list.queryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(guests.queryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(agentQueryKeys.list('project-two'))?.isInvalidated).toBe(
        false,
      );
    } finally {
      queryClient.clear();
    }
  });

  // Transport rejection belongs at the fetcher boundary, without a component or server.
  it.each([fetchAgents, fetchAgentsWithGuests])('throws server errors from %p', async (fetcher) => {
    const fetchFn = jest.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({ message: 'Project access denied' }),
        }) as Response,
    );

    await expect(fetcher(fetchFn, 'project-1')).rejects.toMatchObject({
      message: 'Project access denied',
      status: 403,
    });
  });
});
