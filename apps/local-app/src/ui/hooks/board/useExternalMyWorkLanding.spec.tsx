import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  ExternalMyWorkResult,
  ExternalTaskSummary,
  ExternalWorkArea,
  ExternalWorkAreaTask,
} from '@/modules/external-integrations/models/external-provider.models';
import { useExternalMyWorkLanding } from './useExternalMyWorkLanding';
import { integrationConnectionQueryKeys } from '@/ui/lib/integration-connections';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';

const mockProjectId = '11111111-1111-4111-8111-111111111111';

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockProjectId }),
}));

// Layer: hook unit. The data hook is exercised through a fetch double (not module-mocked)
// because the landing controller's status machine is the contract under test; the data
// hook's own suite owns URL/key/error projections.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

function wrapper(queryClient: QueryClient, initialEntry = '/board/clickup') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const connectionItems = (connected: { clickup?: boolean; jira?: boolean }) => [
  {
    provider: 'clickup' as const,
    connected: connected.clickup ?? false,
    connectionId: connected.clickup ? 'connection-clickup-a' : null,
    generation: connected.clickup ? 1 : null,
    updatedAt: connected.clickup ? '2026-08-19T00:00:00.000Z' : null,
  },
  {
    provider: 'jira' as const,
    connected: connected.jira ?? false,
    connectionId: connected.jira ? 'connection-jira-a' : null,
    generation: connected.jira ? 1 : null,
    updatedAt: connected.jira ? '2026-08-19T00:00:00.000Z' : null,
  },
];

function snapshotResult(
  workAreas: ExternalWorkArea[],
  tasks: ExternalWorkAreaTask[] = [],
): ExternalMyWorkResult {
  return {
    provider: 'clickup',
    descriptor: { provider: 'clickup', displayName: 'ClickUp', capabilities: { myWork: true } },
    supported: true,
    capabilities: { timeTrackingEnabled: false },
    workAreas,
    tasks,
    refreshedAt: '2026-08-19T00:00:00.000Z',
  };
}

const workArea = (overrides: Partial<ExternalWorkArea> = {}): ExternalWorkArea => ({
  remoteId: 'list-1',
  scopeKey: 'team-1',
  name: 'Sprint board',
  kind: 'list',
  description: 'Current sprint work',
  assignedTaskCount: 3,
  hierarchy: [
    { kind: 'workspace', remoteId: 'w1', name: 'Workspace' },
    { kind: 'space', remoteId: 's1', name: 'Product' },
  ],
  workflow: {
    isOverridden: false,
    columns: [
      { remoteId: 'c1', name: 'To do', color: '#888888', category: 'active', position: 0 },
      { remoteId: 'c2', name: 'Doing', color: '#888888', category: 'active', position: 1 },
    ],
  },
  refresh: { state: 'fresh', refreshedAt: null, retryable: false, retryAt: null },
  ...overrides,
});

const task = (
  remoteId: string,
  parentRemoteTaskId: string | null,
  overrides: Partial<ExternalTaskSummary> = {},
): ExternalTaskSummary => ({
  remoteId,
  parentRemoteTaskId,
  title: `Task ${remoteId}`,
  status: { remoteId: 'c1', name: 'To do', category: 'active' },
  updatedAt: '2026-08-19T10:00:00.000Z',
  dueAt: null,
  completedAt: null,
  webUrl: null,
  ...overrides,
});

function linksResult(items: Array<{ scopeKey: string; taskId: string; linked: boolean }>) {
  return {
    ok: true,
    json: async () => ({
      items: items.map((item) => ({
        scopeKey: item.scopeKey,
        taskId: item.taskId,
        linked: item.linked,
        epicId: item.linked ? `epic-${item.scopeKey}-${item.taskId}` : null,
        projectId: item.linked ? mockProjectId : null,
        projectName: item.linked ? 'Product' : null,
        loggedMinutes: null,
      })),
    }),
  };
}

describe('useExternalMyWorkLanding', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => snapshotResult([]),
    }));
  });

  afterEach(() => queryClient.clear());

  function renderLanding(
    provider: 'clickup' | 'jira' = 'clickup',
    initialEntry = '/board/clickup',
  ) {
    return renderHook(() => useExternalMyWorkLanding(provider), {
      wrapper: wrapper(queryClient, initialEntry),
    });
  }

  it('reports disconnected while the provider has no connection', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({}) }) };
      }
      return { ok: true, json: async () => snapshotResult([]) };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('disconnected'));
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/integrations/my-work'),
    );
  });

  it('hides cached connection and My Work data without issuing requests while unavailable', () => {
    queryClient.setQueryData(integrationConnectionQueryKeys.list(mockProjectId), {
      items: connectionItems({ clickup: true }),
    });
    queryClient.setQueryData(
      externalMyWorkQueryKeys.landingSnapshot('clickup', 'connection-clickup-a:1', false),
      snapshotResult([workArea()]),
    );

    const { result } = renderHook(() => useExternalMyWorkLanding('clickup', { enabled: false }), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.cards).toEqual([]);
    expect(result.current.refreshedAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('derives ready cards with location, workflow summary, and counts', async () => {
    const area = workArea({ assignedTaskCount: 99 });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        // The grouped child is linked, but it never reaches the link read:
        // identities come from the visibleTasks projection only.
        return linksResult([
          { scopeKey: 'team-1', taskId: 'parent', linked: false },
          { scopeKey: 'team-1', taskId: 'orphan', linked: false },
          { scopeKey: 'team-1', taskId: 'child', linked: true },
        ]);
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult(
            [area],
            [
              { workArea: area, task: task('parent', null) },
              { workArea: area, task: task('child', 'parent') },
              { workArea: area, task: task('orphan', 'missing') },
            ],
          ),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0]).toMatchObject({
      key: 'team-1:list-1',
      kindLabel: 'List',
      locationLabel: 'Workspace / Product',
      workflowSummary: 'To do → Doing',
      assignedTaskCount: 2,
      linkedTaskCount: 0,
      description: 'Current sprint work',
      refreshState: 'fresh',
    });
    expect(result.current.sourceUrl).toBe('https://app.clickup.com/');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/integrations/my-work/clickup/links/batch'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            items: [
              { scopeKey: 'team-1', taskId: 'orphan' },
              { scopeKey: 'team-1', taskId: 'parent' },
            ],
            includeLoggedMinutes: false,
          }),
        }),
      ),
    );
  });

  it('derives per-area linked counts over the visible universe with compound scope identities', async () => {
    const sprintArea = workArea({ remoteId: 'list-1', scopeKey: 'team-1', name: 'Sprint board' });
    const growthArea = workArea({
      remoteId: 'list-1',
      scopeKey: 'team-2',
      name: 'Growth board',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        return linksResult([
          // Same task ID in two scopes: linked in team-1 only, so the
          // compound identity keeps the counts from colliding.
          { scopeKey: 'team-1', taskId: 'shared', linked: true },
          { scopeKey: 'team-2', taskId: 'shared', linked: false },
          { scopeKey: 'team-1', taskId: 'a-only', linked: false },
        ]);
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult(
            [sprintArea, growthArea],
            [
              { workArea: sprintArea, task: task('shared', null) },
              { workArea: sprintArea, task: task('a-only', null) },
              { workArea: growthArea, task: task('shared', null) },
            ],
          ),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(
      result.current.cards.map((card) => ({
        key: card.key,
        assigned: card.assignedTaskCount,
        linked: card.linkedTaskCount,
      })),
    ).toEqual([
      { key: 'team-1:list-1', assigned: 2, linked: 1 },
      { key: 'team-2:list-1', assigned: 1, linked: 0 },
    ]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/links/batch'),
        expect.objectContaining({
          body: JSON.stringify({
            items: [
              { scopeKey: 'team-1', taskId: 'a-only' },
              { scopeKey: 'team-1', taskId: 'shared' },
              { scopeKey: 'team-2', taskId: 'shared' },
            ],
            includeLoggedMinutes: false,
          }),
        }),
      ),
    );

    // Search narrows which cards render; it never recomputes either count.
    act(() => result.current.setSearch('growth'));
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0]).toMatchObject({
      key: 'team-2:list-1',
      assignedTaskCount: 1,
      linkedTaskCount: 0,
    });
  });

  it('derives one shared link lookup and per-List linked counts for a task on several Lists', async () => {
    const sprintList = workArea({ remoteId: 'list-1', scopeKey: 'team-1', name: 'Sprint board' });
    const operationsList = workArea({
      remoteId: 'list-2',
      scopeKey: 'team-1',
      name: 'Operations board',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        return linksResult([
          { scopeKey: 'team-1', taskId: 'shared', linked: true },
          { scopeKey: 'team-1', taskId: 'a-only', linked: false },
        ]);
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult(
            [sprintList, operationsList],
            [
              { workArea: sprintList, task: task('shared', null) },
              { workArea: sprintList, task: task('a-only', null) },
              { workArea: operationsList, task: task('shared', null) },
            ],
          ),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(
      result.current.cards.map((card) => ({
        key: card.key,
        assigned: card.assignedTaskCount,
        linked: card.linkedTaskCount,
      })),
    ).toEqual([
      { key: 'team-1:list-1', assigned: 2, linked: 1 },
      { key: 'team-1:list-2', assigned: 1, linked: 1 },
    ]);
    // One task shown on two Lists resolves through one compound link
    // identity, so the batch body lists it exactly once.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/links/batch'),
        expect.objectContaining({
          body: JSON.stringify({
            items: [
              { scopeKey: 'team-1', taskId: 'a-only' },
              { scopeKey: 'team-1', taskId: 'shared' },
            ],
            includeLoggedMinutes: false,
          }),
        }),
      ),
    );
  });

  it('keeps the linked count unknown while the link read is pending', async () => {
    const area = workArea();
    const pendingLinks = new Promise<never>(() => undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        return pendingLinks;
      }
      return {
        ok: true,
        json: async () => snapshotResult([area], [{ workArea: area, task: task('a1', null) }]),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cards[0]).toMatchObject({
      assignedTaskCount: 1,
      linkedTaskCount: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/links/batch'),
      expect.anything(),
    );
  });

  it('keeps the linked count unknown while placeholder link data covers a changed input set', async () => {
    const area = workArea();
    let completedScope = false;
    let linksCalls = 0;
    const secondLinks = new Promise<never>(() => undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        linksCalls += 1;
        if (linksCalls === 1) {
          return linksResult([{ scopeKey: 'team-1', taskId: 'a1', linked: true }]);
        }
        return secondLinks;
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult(
            [area],
            completedScope
              ? [
                  { workArea: area, task: task('a1', null) },
                  { workArea: area, task: task('a2', null) },
                ]
              : [{ workArea: area, task: task('a1', null) }],
          ),
      };
    });

    const { result } = renderLanding();
    await waitFor(() =>
      expect(result.current.cards[0]).toMatchObject({ assignedTaskCount: 1, linkedTaskCount: 1 }),
    );

    completedScope = true;
    await act(async () => {
      result.current.toggleIncludeCompleted();
    });

    // The new universe carries three identities but its link read has not
    // settled, so the previous set's count must not bleed through.
    await waitFor(() =>
      expect(result.current.cards[0]).toMatchObject({
        assignedTaskCount: 2,
        linkedTaskCount: null,
      }),
    );
  });

  it('keeps cards ready with unknown linked counts when the link batch fails', async () => {
    const area = workArea();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('/links/batch')) {
        return { ok: false, json: async () => ({ message: 'Link batch failed.' }) };
      }
      return {
        ok: true,
        json: async () => snapshotResult([area], [{ workArea: area, task: task('a1', null) }]),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() =>
      expect(result.current.cards[0]).toMatchObject({
        assignedTaskCount: 1,
        linkedTaskCount: null,
      }),
    );
    expect(result.current.error).toBeNull();
  });

  it('derives the Jira tenant link from the unfiltered provider snapshot', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ jira: true }) }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...snapshotResult([workArea({ scopeKey: 'acme.atlassian.net' })]),
          provider: 'jira',
          descriptor: { provider: 'jira', displayName: 'Jira', capabilities: { myWork: true } },
        }),
      };
    });

    const { result } = renderLanding('jira', '/board/jira');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.sourceUrl).toBe('https://acme.atlassian.net/');

    act(() => result.current.setSearch('no-match'));
    expect(result.current.cards).toEqual([]);
    expect(result.current.sourceUrl).toBe('https://acme.atlassian.net/');
  });

  it('classifies first-load failures as error', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return { ok: false, json: async () => ({ message: 'ClickUp is down.' }) };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toEqual(new Error('ClickUp is down.'));
    expect(result.current.isStale).toBe(false);
  });

  it('keeps prior data and flags stale when a later refetch fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (url.includes('includeCompleted=true')) {
        return { ok: false, json: async () => ({ message: 'Refresh failed.' }) };
      }
      return { ok: true, json: async () => snapshotResult([workArea()]) };
    });

    const { result } = renderLanding();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      result.current.toggleIncludeCompleted();
    });

    await waitFor(() => expect(result.current.isStale).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.error).toEqual(new Error('Refresh failed.'));
  });

  it('toggles the completed scope through the URL so Back and refresh restore it', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return { ok: true, json: async () => snapshotResult([workArea()]) };
    });

    const { result } = renderLanding();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.includeCompleted).toBe(false);

    await act(async () => {
      result.current.toggleIncludeCompleted();
    });

    expect(result.current.includeCompleted).toBe(true);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/integrations/my-work/clickup?includeCompleted=true&projectId=${mockProjectId}`,
        expect.anything(),
      );
    });

    await act(async () => {
      result.current.toggleIncludeCompleted();
    });
    expect(result.current.includeCompleted).toBe(false);
  });

  it('initializes the completed scope from a direct completed URL entry', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return { ok: true, json: async () => snapshotResult([workArea()]) };
    });

    const { result } = renderLanding('clickup', '/board/clickup?completed=1');

    expect(result.current.includeCompleted).toBe(true);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/integrations/my-work/clickup?includeCompleted=true&projectId=${mockProjectId}`,
        expect.anything(),
      ),
    );
  });

  it('does not expose an old connection snapshot when the new identity refresh fails', async () => {
    let newIdentity = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      if (newIdentity) {
        return { ok: false, json: async () => ({ message: 'New account unavailable.' }) };
      }
      return { ok: true, json: async () => snapshotResult([workArea({ name: 'Old tenant' })]) };
    });
    const { result } = renderLanding();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cards[0]?.name).toBe('Old tenant');
    const oldKey = externalMyWorkQueryKeys.landingSnapshot(
      'clickup',
      'connection-clickup-a:1',
      false,
    );

    newIdentity = true;
    act(() => {
      queryClient.setQueryData(integrationConnectionQueryKeys.list(mockProjectId), {
        items: [
          {
            provider: 'clickup',
            connected: true,
            connectionId: 'connection-clickup-b',
            generation: 1,
            updatedAt: '2026-08-19T01:00:00.000Z',
          },
          connectionItems({})[1],
        ],
      });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.cards).toEqual([]);
    expect(result.current.isStale).toBe(false);
    expect(result.current.error).toEqual(new Error('New account unavailable.'));
    expect(queryClient.getQueryData(oldKey)).toBeDefined();
  });

  it('caps the workflow summary at five columns', async () => {
    const columns = Array.from({ length: 7 }, (_, index) => ({
      remoteId: `c${index}`,
      name: `Column ${index}`,
      color: '#888888',
      category: 'active',
      position: index,
    }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult([workArea({ workflow: { isOverridden: false, columns } })]),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cards[0].workflowSummary).toBe(
      'Column 0 → Column 1 → Column 2 → Column 3 → Column 4 → +2 more',
    );
  });

  it('filters cards client-side across name, location, and description', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return {
        ok: true,
        json: async () =>
          snapshotResult([
            workArea({ remoteId: 'list-1', name: 'Sprint board' }),
            workArea({ remoteId: 'list-2', name: 'Backlog', description: null }),
          ]),
      };
    });

    const { result } = renderLanding();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.setSearch('product'));
    expect(result.current.cards.map((card) => card.remoteId)).toEqual(['list-1', 'list-2']);

    act(() => result.current.setSearch('backlog'));
    expect(result.current.cards.map((card) => card.remoteId)).toEqual(['list-2']);

    act(() => result.current.setSearch('no-match'));
    expect(result.current.cards).toEqual([]);
    expect(result.current.visibleCardCount).toBe(2);
  });

  it('issues no link request for an empty task universe', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return { ok: true, json: async () => snapshotResult([workArea()]) };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cards[0]).toMatchObject({
      assignedTaskCount: 0,
      linkedTaskCount: null,
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/links/batch'),
      expect.anything(),
    );
  });

  it('reports empty for a connected provider with no work areas', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return { ok: true, json: async () => snapshotResult([]) };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('empty'));
  });

  it('reports unsupported for a provider without my-work capability', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => ({ items: connectionItems({ clickup: true }) }) };
      }
      return {
        ok: true,
        json: async () => ({
          provider: 'clickup',
          descriptor: {
            provider: 'clickup',
            displayName: 'ClickUp',
            capabilities: { myWork: false },
          },
          supported: false,
          reason: 'unsupported',
        }),
      };
    });

    const { result } = renderLanding();

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
  });
});
