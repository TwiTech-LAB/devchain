import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAgentSessionHistory } from './useAgentSessionHistory';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useAgentSessionHistory', () => {
  it('pages through cursors and resets pagination when the agent or project changes', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const cursor = url.searchParams.get('cursor');
      return {
        ok: true,
        json: async () => ({
          items: [{ id: cursor ? 'second-page-session' : 'first-page-session' }],
          nextCursor: cursor ? null : 'page-two',
          hasMore: cursor === null,
          total: 21,
        }),
      } as Response;
    });
    try {
      const { result, rerender } = renderHook(
        ({ agentId, projectId }) => useAgentSessionHistory(agentId, projectId),
        { wrapper: createWrapper(), initialProps: { agentId: 'agent-1', projectId: 'project-1' } },
      );
      await waitFor(() => expect(result.current.hasNext).toBe(true));
      act(() => result.current.goNext());
      await waitFor(() => expect(result.current.items[0]?.id).toBe('second-page-session'));
      expect(result.current.currentPage).toBe(2);
      expect(result.current.hasPrev).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/sessions/agents/agent-1/history?projectId=project-1&limit=20&cursor=page-two',
        undefined,
      );

      rerender({ agentId: 'agent-2', projectId: 'project-1' });
      await waitFor(() => expect(result.current.items[0]?.id).toBe('first-page-session'));
      expect(result.current.currentPage).toBe(1);
      expect(result.current.hasPrev).toBe(false);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        '/api/sessions/agents/agent-2/history?projectId=project-1&limit=20',
        undefined,
      );

      act(() => result.current.goNext());
      await waitFor(() => expect(result.current.items[0]?.id).toBe('second-page-session'));
      expect(result.current.currentPage).toBe(2);
      rerender({ agentId: 'agent-2', projectId: 'project-2' });
      await waitFor(() => expect(result.current.items[0]?.id).toBe('first-page-session'));
      expect(result.current.currentPage).toBe(1);
      expect(result.current.hasPrev).toBe(false);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        '/api/sessions/agents/agent-2/history?projectId=project-2&limit=20',
        undefined,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
