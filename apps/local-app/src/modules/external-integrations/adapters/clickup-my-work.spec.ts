import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import { SafeVendorHttpClient } from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';

const credentials: ClickUpIntegrationCredentials = {
  provider: 'clickup',
  token: 'clickup-secret-token',
};

const myWorkOptions = {
  includeCompleted: false,
  connectionId: 'connection-clickup',
  connectionGeneration: 1,
};

function listMetadata(
  id = 'list-1',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id === 'list-1' ? 'Sprint' : `List ${id}`,
    content: '',
    folder: { id: 'folder-1', name: 'Delivery' },
    space: { id: 'space-1', name: 'Product' },
    override_statuses: false,
    statuses: [
      { id: 'open', status: 'to do', color: '#d3d3d3', orderindex: 0, type: 'open' },
      { id: 'closed', status: 'complete', color: '#6bc950', orderindex: 1, type: 'closed' },
    ],
    ...overrides,
  };
}

function task(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Task ${id}`,
    status: { id: 'custom', status: 'in progress', type: 'custom' },
    date_updated: '1787133600000',
    date_done: null,
    date_closed: null,
    due_date: null,
    url: `https://app.clickup.com/t/${id}`,
    list: { id: 'list-1', name: 'Sprint' },
    assignees: [{ id: 42, email: 'private@example.com' }],
    ...overrides,
  };
}

function providerWith(
  requestJson: jest.Mock<Promise<unknown>, [request: { url: string }]>,
): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

describe('ClickUp My Work capability', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches only token-owner work with subtasks and keeps active and unknown statuses visible', async () => {
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada', email: 'private@example.com' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering', members: [] }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata();
      }
      return {
        tasks: [
          task('open', { status: { id: 'open', status: 'to do', type: 'open' } }),
          task('custom'),
          task('unknown', {
            status: { id: 'triage', status: 'triage', type: 'future_type' },
          }),
          task('done', {
            status: { status: 'done', type: 'done' },
            date_done: '1787133600000',
          }),
          task('closed', {
            status: { status: 'closed', type: 'closed' },
            date_closed: '1787133600000',
          }),
          task('other-user', { assignees: [{ id: 7 }] }),
        ],
      };
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, myWorkOptions);

    expect(result.tasks.map(({ task: item }) => [item.remoteId, item.status.category])).toEqual([
      ['open', 'active'],
      ['custom', 'active'],
      ['unknown', 'unknown'],
    ]);
    expect(result.tasks.map(({ task: item }) => item.status.remoteId)).toEqual([
      'open',
      'custom',
      'triage',
    ]);
    expect(result.workAreas).toHaveLength(1);
    expect(result.workAreas[0]).toMatchObject({
      remoteId: 'list-1',
      scopeKey: 'workspace-1',
      name: 'Sprint',
    });
    const taskRequest = requestJson.mock.calls
      .map(([request]) => new URL(request.url))
      .find((url) => url.pathname.endsWith('/task'))!;
    expect(taskRequest.searchParams.get('assignees[]')).toBe('42');
    expect(taskRequest.searchParams.get('subtasks')).toBe('true');
    expect(taskRequest.searchParams.get('include_closed')).toBe('false');
    expect(taskRequest.searchParams.get('page')).toBe('0');
    expect(taskRequest.searchParams.get('order_by')).toBe('id');
    expect(JSON.stringify(result)).not.toMatch(
      /assignees|date_updated|date_done|date_closed|due_date|team_id|private@example.com/,
    );
  });

  it('paginates every Workspace and deduplicates repeated task cards without importing hierarchy', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      task(`task-${index}`, index === 1 ? { parent: 'parent-task' } : {}),
    );
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata();
      }
      return parsed.searchParams.get('page') === '0'
        ? { tasks: firstPage }
        : { tasks: [task('task-0'), task('task-100')] };
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, myWorkOptions);

    expect(result.tasks).toHaveLength(101);
    expect(result.tasks.filter(({ task: item }) => item.remoteId === 'task-0')).toHaveLength(1);
    expect(result.tasks[1]).not.toHaveProperty('parent');
    expect(
      requestJson.mock.calls
        .map(([request]) => new URL(request.url))
        .filter((url) => url.pathname.endsWith('/task'))
        .map((url) => url.searchParams.get('page')),
    ).toEqual(['0', '1']);
  });

  it('adds only done and closed work from the fixed previous-30-day window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const recent = String(Date.parse('2026-08-10T12:00:00.000Z'));
    const stale = String(Date.parse('2026-07-01T12:00:00.000Z'));
    const taskUrls: URL[] = [];
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata();
      }
      taskUrls.push(parsed);
      if (parsed.searchParams.get('include_closed') === 'false') {
        return {
          tasks: [task('active'), task('done-1', { status: { status: 'done', type: 'done' } })],
        };
      }
      return {
        tasks: [
          task('done-1', {
            status: { status: 'done', type: 'done' },
            date_done: recent,
          }),
          task('done-1', {
            status: { status: 'done', type: 'done' },
            date_done: recent,
          }),
          task('closed-1', {
            status: { status: 'closed', type: 'closed' },
            date_closed: recent,
          }),
          task('stale', {
            status: { status: 'done', type: 'done' },
            date_done: stale,
          }),
          task('future', {
            status: { status: 'done', type: 'done' },
            date_done: String(Date.parse('2026-08-20T12:00:00.000Z')),
          }),
          task('still-active'),
        ],
      };
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, {
      ...myWorkOptions,
      includeCompleted: true,
    });

    expect(result.tasks.map(({ task: item }) => [item.remoteId, item.status.category])).toEqual([
      ['active', 'active'],
      ['done-1', 'completed'],
      ['closed-1', 'completed'],
    ]);
    expect(result.workAreas[0]).toMatchObject({ assignedTaskCount: 3 });
    const completedRequest = taskUrls.find(
      (url) => url.searchParams.get('include_closed') === 'true',
    )!;
    expect(completedRequest.searchParams.get('date_done_gt')).toBe(
      String(Date.parse('2026-07-20T12:00:00.000Z')),
    );
    expect(completedRequest.searchParams.get('date_done_lt')).toBe(
      String(Date.parse('2026-08-19T12:00:00.000Z')),
    );
    expect(completedRequest.searchParams.get('assignees[]')).toBe('42');
    expect(completedRequest.searchParams.get('subtasks')).toBe('true');
  });

  it('builds provider-neutral home-List cards with computed counts and exact ordered workflows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata('list-1', {
          content: 'Current sprint delivery work.',
          task_count: '999',
          markdown_content: '# must not be claimed by Get List',
          status: { status: 'red', color: '#e50000' },
          override_statuses: true,
          statuses: [
            {
              id: 'complete',
              status: 'Complete',
              color: '#6bc950',
              orderindex: 2,
              type: 'closed',
            },
            {
              id: 'todo',
              status: 'To Do',
              color: '#d3d3d3',
              orderindex: 0,
              type: 'open',
            },
            {
              id: 'progress',
              status: 'In Progress',
              color: '#7c4dff',
              orderindex: 1,
              type: 'custom',
            },
          ],
        });
      }
      return {
        tasks: [
          task('task-1', { locations: [{ id: 'secondary-list', name: 'Secondary' }] }),
          task('task-2'),
        ],
      };
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, myWorkOptions);

    expect(result.workAreas).toEqual([
      {
        remoteId: 'list-1',
        scopeKey: 'workspace-1',
        name: 'Sprint',
        kind: 'list',
        description: 'Current sprint delivery work.',
        assignedTaskCount: 2,
        hierarchy: [
          { kind: 'workspace', remoteId: 'workspace-1', name: 'Engineering' },
          { kind: 'space', remoteId: 'space-1', name: 'Product' },
          { kind: 'folder', remoteId: 'folder-1', name: 'Delivery' },
        ],
        workflow: {
          isOverridden: true,
          columns: [
            {
              remoteId: 'todo',
              name: 'To Do',
              color: '#d3d3d3',
              category: 'active',
              position: 0,
            },
            {
              remoteId: 'progress',
              name: 'In Progress',
              color: '#7c4dff',
              category: 'active',
              position: 1,
            },
            {
              remoteId: 'complete',
              name: 'Complete',
              color: '#6bc950',
              category: 'completed',
              position: 2,
            },
          ],
        },
        refresh: {
          state: 'fresh',
          refreshedAt: '2026-08-19T12:00:00.000Z',
          retryable: false,
          retryAt: null,
        },
      },
    ]);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every(({ workArea }) => workArea === result.workAreas[0])).toBe(true);
    expect(
      requestJson.mock.calls.filter(([request]) =>
        new URL(request.url).pathname.startsWith('/api/v2/list/'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(result.workAreas)).not.toMatch(
      /task_count|markdown_content|secondary-list|"status":\{"status":"red"/,
    );
  });

  it('reuses valid List metadata and refetches it after connection generation changes', async () => {
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata();
      }
      return { tasks: [task('task-1')] };
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.discover(credentials, myWorkOptions);
    await provider.myWork!.discover(credentials, myWorkOptions);
    await provider.myWork!.discover(credentials, {
      ...myWorkOptions,
      connectionGeneration: 2,
    });

    expect(
      requestJson.mock.calls.filter(([request]) =>
        new URL(request.url).pathname.startsWith('/api/v2/list/'),
      ),
    ).toHaveLength(2);
  });

  it('returns retryable metadata error cards without negative-caching the failure', async () => {
    let listAttempts = 0;
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        listAttempts += 1;
        if (listAttempts === 1) {
          throw new Error('private metadata failure');
        }
        return listMetadata();
      }
      return { tasks: [task('task-1')] };
    });
    const provider = providerWith(requestJson);

    const failed = await provider.myWork!.discover(credentials, myWorkOptions);
    const retried = await provider.myWork!.discover(credentials, myWorkOptions);

    expect(failed.workAreas[0]).toMatchObject({
      assignedTaskCount: 1,
      refresh: { state: 'error', refreshedAt: null, retryable: true, retryAt: null },
    });
    expect(retried.workAreas[0]).toMatchObject({
      refresh: { state: 'fresh', retryable: false },
    });
    expect(listAttempts).toBe(2);
  });

  it('serves stale List metadata after a refresh failure and retries it later', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    let failMetadata = false;
    let listAttempts = 0;
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        listAttempts += 1;
        if (failMetadata) {
          throw new Error('private metadata failure');
        }
        return listMetadata('list-1', { content: 'Cached description' });
      }
      return { tasks: [task('task-1')] };
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.discover(credentials, myWorkOptions);
    jest.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    failMetadata = true;
    const stale = await provider.myWork!.discover(credentials, myWorkOptions);
    await provider.myWork!.discover(credentials, myWorkOptions);

    expect(stale.workAreas[0]).toMatchObject({
      description: 'Cached description',
      refresh: {
        state: 'stale',
        refreshedAt: '2026-08-19T12:00:00.000Z',
        retryable: true,
        retryAt: null,
      },
    });
    expect(listAttempts).toBe(3);
  });

  it('evicts the least-recently-used List metadata after the bounded cache reaches capacity', async () => {
    let discovery = 0;
    const listAttempts = new Map<string, number>();
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        discovery += 1;
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return { teams: [{ id: 'workspace-1', name: 'Engineering' }] };
      }
      if (parsed.pathname.startsWith('/api/v2/list/')) {
        const id = decodeURIComponent(parsed.pathname.split('/').at(-1)!);
        listAttempts.set(id, (listAttempts.get(id) ?? 0) + 1);
        return listMetadata(id);
      }
      if (discovery === 1) {
        const page = Number(parsed.searchParams.get('page'));
        const start = page * 100;
        const count = page === 0 ? 100 : 29;
        return {
          tasks: Array.from({ length: count }, (_, offset) => {
            const index = start + offset;
            return task(`task-${index}`, {
              list: { id: `list-${index}`, name: `List ${index}` },
            });
          }),
        };
      }
      return {
        tasks: [task('task-0', { list: { id: 'list-0', name: 'List 0' } })],
      };
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.discover(credentials, myWorkOptions);
    await provider.myWork!.discover(credentials, myWorkOptions);

    expect(listAttempts.get('list-0')).toBe(2);
    expect(listAttempts.get('list-128')).toBe(1);
    expect([...listAttempts.values()].reduce((sum, value) => sum + value, 0)).toBe(130);
  });

  it('fails the complete refresh when any Workspace page fails', async () => {
    const requestJson = jest.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v2/user') {
        return { user: { id: 42, username: 'Ada' } };
      }
      if (parsed.pathname === '/api/v2/team') {
        return {
          teams: [
            { id: 'workspace-1', name: 'Engineering' },
            { id: 'workspace-2', name: 'Operations' },
          ],
        };
      }
      if (parsed.pathname === '/api/v2/list/list-1') {
        return listMetadata();
      }
      if (parsed.pathname.includes('workspace-2')) {
        throw new Error('private vendor failure');
      }
      return { tasks: [task('task-1')] };
    });
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.discover(credentials, myWorkOptions),
    ).rejects.toMatchObject<ClickUpProviderError>({
      code: 'clickup_unavailable',
      details: expect.objectContaining({ provider: 'clickup', reason: 'unavailable' }),
    });
  });
});
