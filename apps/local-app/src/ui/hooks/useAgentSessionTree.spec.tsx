import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SessionTreeNode } from '@/ui/lib/sessions';
import { useAgentSessionTree } from './useAgentSessionTree';

function root(id: string): SessionTreeNode {
  return {
    id,
    name: id,
    kind: 'session',
    status: 'stopped',
    parentSessionId: null,
    providerSessionId: `provider-${id}`,
    providerNameAtLaunch: 'claude',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    lastActivityAt: null,
    sizeBytes: null,
    transcriptAvailable: true,
    beforeRollback: false,
  };
}

// The live root sorts onto the third page, so both consumers page forward to find it.
const pages: Record<string, { items: SessionTreeNode[]; nextCursor: string | null }> = {
  first: { items: [root('newest')], nextCursor: 'page-2' },
  'page-2': { items: [root('older')], nextCursor: 'page-3' },
  'page-3': { items: [root('live')], nextCursor: null },
};

describe('useAgentSessionTree', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // The bar and the Sessions table mount the same tree while its first page loads.
  it('requests each live-path page once when two consumers page forward together', async () => {
    const cursors: Array<string | null> = [];
    let releaseFirstPage!: () => void;
    const firstPageHeld = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'http://localhost').searchParams.get('cursor');
      cursors.push(cursor);
      if (cursor === null) await firstPageHeld;
      const page = pages[cursor ?? 'first'];
      return {
        ok: true,
        json: async () => ({
          items: page.items,
          savePoints: { available: true },
          hasMore: page.nextCursor !== null,
          nextCursor: page.nextCursor,
          total: 3,
        }),
      } as Response;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => [
        useAgentSessionTree('agent-1', 'project-1', 'live'),
        useAgentSessionTree('agent-1', 'project-1', 'live'),
      ],
      { wrapper },
    );
    await act(async () => releaseFirstPage());

    await waitFor(() => expect(result.current[1].byId.has('live')).toBe(true));
    expect(cursors).toEqual([null, 'page-2', 'page-3']);
  });

  // The hook owns the order that both the bar list and the table rows read.
  it('lists save points with the Before rollback record first, then newest first', async () => {
    const save = (id: string, startedAt: string, beforeRollback = false): SessionTreeNode => ({
      ...root(id),
      kind: 'save_point',
      parentSessionId: 'live',
      startedAt,
      beforeRollback,
    });
    const fork = { ...root('fork'), parentSessionId: 'live' };
    const items = [
      root('live'),
      save('older', '2026-01-01T10:00:00.000Z'),
      fork,
      save('record', '2026-01-01T09:00:00.000Z', true),
      save('newer', '2026-01-01T11:00:00.000Z'),
    ];
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            items,
            savePoints: { available: true },
            hasMore: false,
            nextCursor: null,
            total: 1,
          }),
        }) as Response,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAgentSessionTree('agent-1', 'project-1', 'live'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.byId.has('live')).toBe(true));
    const live = result.current.byId.get('live')!;
    expect(live.savePoints.map((node) => node.id)).toEqual(['record', 'newer', 'older']);
    expect(live.children.map(({ node }) => node.id)).toEqual(['older', 'fork', 'record', 'newer']);
  });
});
