import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';

const credentials: ClickUpIntegrationCredentials = {
  provider: 'clickup',
  token: 'clickup-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-clickup',
  connectionGeneration: 3,
};
const BASE_DATE = 1_787_400_000_000;

function timeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '8127',
    task: { id: 'task-1', name: 'Ship remote actions' },
    task_id: 'task-1',
    start: String(BASE_DATE),
    end: String(BASE_DATE + 3_600_000),
    duration: 3_600_000,
    description: 'Implementation',
    billable: false,
    user: { id: 42, username: 'Ada', email: 'private@example.com' },
    task_url: 'https://app.clickup.com/t/task-1',
    timer_start: null,
    ...overrides,
  };
}

function providerWith(requestJson: jest.Mock): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

/** Serves the identity, task, and team range endpoints from plain fixtures. */
function historyTransport(payload: unknown, taskOverrides: Record<string, unknown> = {}) {
  const requests: SafeVendorJsonRequest[] = [];
  const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/v2/user') {
      return { user: { id: 42, username: 'Ada', email: 'private@example.com' } };
    }
    if (url.pathname === '/api/v2/task/task-1') {
      return { id: 'task-1', team_id: 'workspace-1', time_spent: 7_200_000, ...taskOverrides };
    }
    if (url.pathname === '/api/v2/team/workspace-1/time_entries') {
      return payload;
    }
    throw new Error(`unexpected ClickUp request: ${url.toString()}`);
  });
  return { provider: providerWith(requestJson), requestJson, requests };
}

describe('ClickUp time-entry history', () => {
  it('normalizes only own completed entries through the team range endpoint', async () => {
    const { provider, requests } = historyTransport({
      data: [
        timeEntry({ id: 9001, start: String(BASE_DATE - 60_000), duration: '600000' }),
        timeEntry({ id: '8127', description: null }),
        timeEntry({ id: 9500, user: { id: 43, username: 'Someone Else' } }),
        timeEntry({
          id: 8000,
          start: String(BASE_DATE - 120_000),
          duration: 900_000,
          description: 'x'.repeat(10_001),
        }),
      ],
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'task-1');

    expect(result).toEqual({
      windowDays: 30,
      truncated: false,
      hasRunningTimer: false,
      entries: [
        {
          remoteId: '8127',
          durationMs: 3_600_000,
          startedAt: new Date(BASE_DATE).toISOString(),
          note: null,
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
        },
        {
          remoteId: '9001',
          durationMs: 600_000,
          startedAt: new Date(BASE_DATE - 60_000).toISOString(),
          note: 'Implementation',
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
        },
        {
          remoteId: '8000',
          durationMs: 900_000,
          startedAt: new Date(BASE_DATE - 120_000).toISOString(),
          note: 'x'.repeat(10_000),
          noteTruncated: true,
          canEdit: true,
          canDelete: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|Someone Else|task_url|billable|timer_start|username/i,
    );

    const range = requests.find(
      (request) => new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries',
    )!;
    const params = new URL(range.url).searchParams;
    expect(params.get('task_id')).toBe('task-1');
    expect(params.getAll('assignee_ids[]')).toEqual(['42']);
    expect(params.get('start_date')).toMatch(/^\d+$/);
    expect(params.get('end_date')).toMatch(/^\d+$/);
    const windowMs = Number(params.get('end_date')) - Number(params.get('start_date'));
    expect(windowMs).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000);
    expect(windowMs).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    // The legacy per-task time endpoints stay untouched.
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v2/user',
      '/api/v2/task/task-1',
      '/api/v2/team/workspace-1/time_entries',
    ]);
  });

  it('flags a running timer without letting it become a completed row', async () => {
    const { provider } = historyTransport({
      data: [
        timeEntry({ id: 'running', duration: -45_000, timer_start: String(BASE_DATE) }),
        timeEntry({ id: 8127 }),
      ],
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'task-1');

    expect(result.hasRunningTimer).toBe(true);
    expect(result.entries.map((entry) => entry.remoteId)).toEqual(['8127']);
  });

  it('caps the history at 100 rows and marks it truncated', async () => {
    const { provider } = historyTransport({
      data: Array.from({ length: 105 }, (_, index) =>
        timeEntry({ id: String(index), start: String(BASE_DATE - index * 60_000) }),
      ),
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'task-1');

    expect(result.entries).toHaveLength(100);
    expect(result.truncated).toBe(true);
    // Newest first: the newest 100 of 105 survive.
    expect(result.entries[0]!.remoteId).toBe('0');
    expect(result.entries[99]!.remoteId).toBe('99');
  });

  it('breaks startedAt ties by ascending numeric id', async () => {
    const { provider } = historyTransport({
      data: [
        timeEntry({ id: 9100, start: String(BASE_DATE), duration: 60_000 }),
        timeEntry({ id: '1200', start: String(BASE_DATE), duration: 60_000 }),
        timeEntry({ id: 8300, start: String(BASE_DATE), duration: 60_000 }),
      ],
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'task-1');

    expect(result.entries.map((entry) => entry.remoteId)).toEqual(['1200', '8300', '9100']);
  });

  it.each([
    ['non-array data', { data: null }],
    ['malformed duration', { data: [timeEntry({ duration: 'abc' })] }],
    ['malformed start', { data: [timeEntry({ start: 'not-a-time' })] }],
    ['missing user', { data: [{ ...timeEntry(), user: null }] }],
    ['non-record entry', { data: ['nope'] }],
  ])('classifies a malformed history payload: %s', async (_case, payload) => {
    const { provider } = historyTransport(payload);

    await expect(
      provider.myWork!.getTimeEntryHistory!(credentials, context, 'task-1'),
    ).rejects.toMatchObject({ code: 'clickup_invalid_response' });
  });

  it('rejects a mismatched task read before the range request', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/user') return { user: { id: 42, username: 'Ada' } };
      if (url.pathname === '/api/v2/task/task-1') return { id: 'other-task', team_id: 'w' };
      throw new Error('unexpected request');
    });

    await expect(
      providerWith(requestJson).myWork!.getTimeEntryHistory!(credentials, context, 'task-1'),
    ).rejects.toMatchObject<ClickUpProviderError>({ code: 'clickup_invalid_response' });
  });
});

describe('ClickUp task time totals', () => {
  function detailTransport(task: Record<string, unknown>): {
    provider: ClickUpExternalTaskProvider;
  } {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/task/task-1') return task;
      if (url.pathname === '/api/v2/list/list-1') {
        return { id: 'list-1', name: 'Sprint', override_statuses: true, statuses: [] };
      }
      throw new Error(`unexpected ClickUp request: ${url.toString()}`);
    });
    return { provider: providerWith(requestJson) };
  }

  function taskDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'task-1',
      name: 'Ship remote actions',
      status: {
        id: 'progress',
        status: 'In Progress',
        color: '#7c4dff',
        orderindex: 1,
        type: 'custom',
      },
      url: 'https://app.clickup.com/t/task-1',
      team_id: 'workspace-1',
      list: { id: 'list-1', name: 'Sprint' },
      ...overrides,
    };
  }

  it('reports null when the task carries no time_spent', async () => {
    const { provider } = detailTransport(taskDetail());

    const result = await provider.myWork!.getTaskDetail!(credentials, context, 'task-1');

    expect(result.taskTotalDurationMs).toBeNull();
  });

  it('rejects a malformed time_spent payload', async () => {
    const { provider } = detailTransport(taskDetail({ time_spent: 'lots' }));

    await expect(
      provider.myWork!.getTaskDetail!(credentials, context, 'task-1'),
    ).rejects.toMatchObject({ code: 'clickup_invalid_response' });
  });
});
