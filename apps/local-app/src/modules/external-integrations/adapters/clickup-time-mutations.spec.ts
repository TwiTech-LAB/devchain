import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
  SafeVendorHttpError,
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

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '8127',
    start: String(BASE_DATE),
    duration: 3_600_000,
    description: 'Implementation',
    user: { id: 42, username: 'Ada' },
    ...overrides,
  };
}

function providerWith(requestJson: jest.Mock): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

type EntryBody = Record<string, unknown>;

const ENTRY_SHAPES: [string, (entry: EntryBody) => unknown][] = [
  ['the documented data object', (entry) => ({ data: entry })],
  ['a one-element data array', (entry) => ({ data: [entry] })],
  ['a flat entry object', (entry) => entry],
];

/** Serves identity + task reads; delegates team time-entry paths to handlers. */
function mutationTransport(handlers: {
  singular?: (entryId: string, method?: string) => unknown;
  range?: (params: URLSearchParams) => unknown;
  create?: () => unknown;
}) {
  const requests: SafeVendorJsonRequest[] = [];
  const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/v2/user') {
      return { user: { id: 42, username: 'Ada' } };
    }
    if (url.pathname === '/api/v2/task/task-1' && request.method === undefined) {
      return { id: 'task-1', team_id: 'workspace-1' };
    }
    if (url.pathname === '/api/v2/team/workspace-1/time_entries' && request.method === undefined) {
      return handlers.range?.(url.searchParams);
    }
    if (url.pathname === '/api/v2/team/workspace-1/time_entries' && request.method === 'POST') {
      return handlers.create?.();
    }
    const match = url.pathname.match(/^\/api\/v2\/team\/workspace-1\/time_entries\/(.+)$/);
    if (match) {
      return handlers.singular?.(decodeURIComponent(match[1]!), request.method);
    }
    throw new Error(`unexpected ClickUp request: ${url.toString()}`);
  });
  return { provider: providerWith(requestJson), requestJson, requests };
}

describe('ClickUp time-entry mutations', () => {
  it.each(ENTRY_SHAPES)('reads one exact entry from %s', async (_shape, wrap) => {
    const { provider, requests } = mutationTransport({
      singular: (entryId) => wrap(entry({ id: entryId })),
    });

    const read = await provider.timeEntryMutations!.readTimeEntryExact!(
      credentials,
      context,
      'task-1',
      '8127',
    );

    expect(read).toEqual({
      remoteId: '8127',
      startedAt: new Date(BASE_DATE).toISOString(),
      durationMs: 3_600_000,
      note: 'Implementation',
      owned: true,
    });
    const singular = requests.find(
      (request) => new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries/8127',
    )!;
    expect(singular.method).toBeUndefined();
  });

  it('normalizes numeric ids and foreign owners on the exact read', async () => {
    const { provider } = mutationTransport({
      singular: (entryId) => ({ data: entry({ id: Number(entryId), user: { id: 43 } }) }),
    });

    const read = await provider.timeEntryMutations!.readTimeEntryExact!(
      credentials,
      context,
      'task-1',
      '8127',
    );

    expect(read).toMatchObject({ remoteId: '8127', owned: false });
  });

  it('updates one owned entry without changing its task association', async () => {
    const { provider, requests } = mutationTransport({
      singular: (entryId) => ({ data: entry({ id: entryId }) }),
    });

    await provider.timeEntryMutations!.updateTimeEntry!(credentials, context, 'task-1', '8127', {
      startedAt: '2026-08-19T10:00:00.000Z',
      durationMs: 5_400_000,
      note: 'Revised',
    });

    const update = requests.find((request) => request.method === 'PUT')!;
    expect(new URL(update.url).pathname).toBe('/api/v2/team/workspace-1/time_entries/8127');
    expect(JSON.parse(String(update.body))).toEqual({
      start: Date.parse('2026-08-19T10:00:00.000Z'),
      end: Date.parse('2026-08-19T10:00:00.000Z') + 5_400_000,
      duration: 5_400_000,
      description: 'Revised',
    });
    expect(JSON.parse(String(update.body))).not.toHaveProperty('tid');
  });

  it('proves editability through the task-filtered own-entry range and exact read', async () => {
    const { provider } = mutationTransport({
      range: () => ({ data: [entry()] }),
      singular: (entryId) => ({ data: entry({ id: entryId }) }),
    });

    await expect(
      provider.timeEntryMutations!.assertTimeEntryEditable!(credentials, context, 'task-1', '8127'),
    ).resolves.toMatchObject({ remoteId: '8127', owned: true });
  });

  it('returns null only for a classified exact-resource 404', async () => {
    const { provider } = mutationTransport({
      singular: () => {
        throw new SafeVendorHttpError('http_error', 404);
      },
    });

    await expect(
      provider.timeEntryMutations!.readTimeEntryExact!(credentials, context, 'task-1', '8127'),
    ).resolves.toBeNull();
  });

  it.each([
    ['a mismatched entry in the data object', { data: entry({ id: 'other' }) }],
    ['an empty data array', { data: [] }],
    ['a multi-entry data array', { data: [entry(), entry({ id: '8128' })] }],
    ['a non-object data value', { data: 'unusable' }],
    ['a flat entry naming a different entry', entry({ id: 'other' })],
  ])('rejects an exact read with %s', async (_case, body) => {
    const { provider } = mutationTransport({ singular: () => body });

    await expect(
      provider.timeEntryMutations!.readTimeEntryExact!(credentials, context, 'task-1', '8127'),
    ).rejects.toMatchObject<ClickUpProviderError>({ code: 'clickup_invalid_response' });
  });

  it('lists own ids in a window and never claims completeness', async () => {
    const { provider, requests } = mutationTransport({
      range: () => ({ data: [entry({ id: '1' }), entry({ id: '2', user: { id: 43 } })] }),
    });

    const range = await provider.timeEntryMutations!.listOwnTimeEntryIdsInRange!(
      credentials,
      context,
      'task-1',
      BASE_DATE - 60_000,
      BASE_DATE + 60_000,
    );

    expect(range).toEqual({ ids: ['1', '2'], complete: false });
    const rangeRequest = requests.find(
      (request) =>
        new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries' &&
        request.method === undefined,
    )!;
    const params = new URL(rangeRequest.url).searchParams;
    expect(params.get('task_id')).toBe('task-1');
    expect(params.get('start_date')).toBe(String(BASE_DATE - 60_000));
    expect(params.get('end_date')).toBe(String(BASE_DATE + 60_000));
    expect(params.getAll('assignee_ids[]')).toEqual(['42']);
  });

  it('proves deletability through one fresh task-filtered range read', async () => {
    const { provider, requests } = mutationTransport({
      range: () => ({ data: [entry({ id: '8127' })] }),
    });

    await provider.timeEntryMutations!.assertTimeEntryDeletable!(
      credentials,
      context,
      'task-1',
      '8127',
    );

    const rangeCalls = requests.filter(
      (request) =>
        new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries' &&
        request.method === undefined,
    );
    expect(rangeCalls).toHaveLength(1);
  });

  it('rejects the delete preflight when the range proof lacks the entry', async () => {
    const { provider } = mutationTransport({ range: () => ({ data: [] }) });

    await expect(
      provider.timeEntryMutations!.assertTimeEntryDeletable!(
        credentials,
        context,
        'task-1',
        '8127',
      ),
    ).rejects.toMatchObject({ code: 'clickup_not_found' });
  });

  it.each(ENTRY_SHAPES)(
    'deletes through the singular team endpoint from %s',
    async (_shape, wrap) => {
      const { provider, requests } = mutationTransport({
        singular: (entryId, method) => {
          expect(method).toBe('DELETE');
          return wrap(entry({ id: entryId }));
        },
      });

      await provider.timeEntryMutations!.deleteTimeEntry!(credentials, context, 'task-1', '8127');

      const deleteRequest = requests.find((request) => request.method === 'DELETE')!;
      expect(deleteRequest.url).toBe(
        'https://api.clickup.com/api/v2/team/workspace-1/time_entries/8127',
      );
    },
  );

  it.each([
    ['a mismatched entry in the data object', { data: entry({ id: 'other' }) }],
    ['an empty data array', { data: [] }],
    ['a multi-entry data array', { data: [entry(), entry({ id: '8128' })] }],
    ['a non-object data value', { data: 41 }],
    ['a flat entry naming a different entry', entry({ id: 'other' })],
  ])('treats a delete response with %s as unknown', async (_case, body) => {
    const { provider } = mutationTransport({ singular: () => body });

    await expect(
      provider.timeEntryMutations!.deleteTimeEntry!(credentials, context, 'task-1', '8127'),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
  });

  it('treats an unusable delete response as unknown', async () => {
    const { provider } = mutationTransport({
      singular: () => 'not-json-shape',
    });

    await expect(
      provider.timeEntryMutations!.deleteTimeEntry!(credentials, context, 'task-1', '8127'),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
  });

  function createReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      start: BASE_DATE,
      duration: 60_000,
      billable: false,
      assignee: 42,
      tags: [],
      description: '',
      tid: 'task-1',
      ...overrides,
    };
  }

  const CREATE_INPUT = {
    startedAt: '2026-08-19T10:00:00.000Z',
    durationMs: 60_000,
    note: null,
  };
  const CREATE_START_MS = Date.parse(CREATE_INPUT.startedAt);

  function createdEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '8127',
      task: { id: 'task-1' },
      start: CREATE_START_MS,
      duration: 60_000,
      description: 'Implementation',
      ...overrides,
    };
  }

  function createPostCount(requests: SafeVendorJsonRequest[]): number {
    return requests.filter(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries',
    ).length;
  }

  const RECEIPT_ENVELOPES: [string, (receipt: EntryBody) => unknown][] = [
    ['a data object', (receipt) => ({ data: receipt })],
    ['a one-element data array', (receipt) => ({ data: [receipt] })],
  ];

  it('confirms a documented create receipt that carries no entry id', async () => {
    const { provider, requests } = mutationTransport({ create: () => createReceipt() });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).resolves.toEqual({ remoteEntryId: null });
    expect(createPostCount(requests)).toBe(1);
  });

  it('keeps the entry id when a compatible create response carries one', async () => {
    const { provider, requests } = mutationTransport({ create: () => createReceipt({ id: 8127 }) });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: 'Implementation',
      }),
    ).resolves.toEqual({ remoteEntryId: '8127' });
    expect(createPostCount(requests)).toBe(1);
  });

  it('accepts the documented create receipt with numeric-string fields', async () => {
    const { provider } = mutationTransport({
      create: () => createReceipt({ start: String(BASE_DATE), assignee: '42', duration: '60000' }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).resolves.toEqual({ remoteEntryId: null });
  });

  it.each(RECEIPT_ENVELOPES)(
    'confirms a complete create receipt inside %s',
    async (_shape, wrap) => {
      const { provider, requests } = mutationTransport({
        create: () => wrap(createReceipt({ id: '8127' })),
      });

      await expect(
        provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
      ).resolves.toEqual({ remoteEntryId: '8127' });
      expect(createPostCount(requests)).toBe(1);
    },
  );

  it('proves an id-only create response through exactly one exact GET', async () => {
    const { provider, requests } = mutationTransport({
      create: () => ({ id: 8127 }),
      singular: (entryId) => createdEntry({ id: entryId }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).resolves.toEqual({ remoteEntryId: '8127' });
    expect(createPostCount(requests)).toBe(1);
    const singularRequests = requests.filter(
      (request) =>
        new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries/8127' &&
        request.method === undefined,
    );
    expect(singularRequests).toHaveLength(1);
    expect(requests.some((request) => new URL(request.url).pathname === '/api/v2/user')).toBe(
      false,
    );
  });

  it('proves an id-only create response inside a data envelope', async () => {
    const { provider } = mutationTransport({
      create: () => ({ data: { id: '8127' } }),
      singular: (entryId) => ({ data: createdEntry({ id: entryId }) }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).resolves.toEqual({ remoteEntryId: '8127' });
  });

  it('proves the task through a strict production task URL instead of the task object', async () => {
    const { provider } = mutationTransport({
      create: () => ({ id: '8127' }),
      singular: () =>
        createdEntry({ task: undefined, task_url: 'https://prod.clickup.com/t/task-1' }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).resolves.toEqual({ remoteEntryId: '8127' });
  });

  it('normalizes numeric-string fields in the exact fallback proof', async () => {
    const { provider } = mutationTransport({
      create: () => ({ id: '8127' }),
      singular: (entryId) =>
        createdEntry({ id: entryId, start: String(CREATE_START_MS), duration: '60000' }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).resolves.toEqual({ remoteEntryId: '8127' });
  });

  it.each([
    ['a mismatched entry id', createdEntry({ id: 'other' })],
    ['a mismatched task object', createdEntry({ task: { id: 'other-task' } })],
    ['no task association at all', createdEntry({ task: undefined })],
    ['a mismatched start', createdEntry({ start: CREATE_START_MS + 1 })],
    ['a mismatched duration', createdEntry({ duration: 61_000 })],
    ['a non-object singular body', 'not-json-shape'],
    ['an empty data array', { data: [] }],
  ])('treats an exact fallback with %s as unknown', async (_case, body) => {
    const { provider, requests } = mutationTransport({
      create: () => ({ id: '8127' }),
      singular: () => body,
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
    expect(createPostCount(requests)).toBe(1);
  });

  it.each([
    ['an extra path segment', 'https://prod.clickup.com/t/task-1/abc123'],
    ['a query string', 'https://prod.clickup.com/t/task-1?x=1'],
    ['a fragment', 'https://prod.clickup.com/t/task-1#f'],
    ['credentials', 'https://user:pass@prod.clickup.com/t/task-1'],
    ['a port', 'https://prod.clickup.com:8443/t/task-1'],
    ['a plain-http scheme', 'http://prod.clickup.com/t/task-1'],
    ['a non-production host', 'https://app.clickup.com/t/task-1'],
    ['a mismatched task id', 'https://prod.clickup.com/t/other-task'],
  ])('rejects a task URL proof with %s', async (_case, taskUrl) => {
    const { provider, requests } = mutationTransport({
      create: () => ({ id: '8127' }),
      singular: () => createdEntry({ task: undefined, task_url: taskUrl }),
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
    expect(createPostCount(requests)).toBe(1);
  });

  it.each([
    ['a 401', new SafeVendorHttpError('http_error', 401)],
    ['a 403', new SafeVendorHttpError('http_error', 403)],
    ['a 404', new SafeVendorHttpError('http_error', 404)],
    ['a 429', new SafeVendorHttpError('http_error', 429)],
    ['a 5xx', new SafeVendorHttpError('http_error', 500)],
    ['a timeout', new SafeVendorHttpError('timeout')],
    ['a network loss', new SafeVendorHttpError('network_error')],
  ])('treats an exact fallback transport failure (%s) as unknown', async (_case, error) => {
    const { provider, requests } = mutationTransport({
      create: () => ({ id: '8127' }),
      singular: () => {
        throw error;
      },
    });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', CREATE_INPUT),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
    expect(createPostCount(requests)).toBe(1);
  });

  it.each([
    ['a receipt naming a different task', createReceipt({ tid: 'other-task' })],
    ['a multi-entry data array', { data: [createReceipt(), createReceipt()] }],
    ['a body without the documented receipt', { noId: true }],
    ['a non-object body', 'not-json-shape'],
  ])('treats a create response with %s as unknown', async (_case, body) => {
    const { provider, requests } = mutationTransport({ create: () => body });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).rejects.toMatchObject({
      code: 'clickup_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
    expect(createPostCount(requests)).toBe(1);
    expect(
      requests.some(
        (request) => new URL(request.url).pathname === '/api/v2/team/workspace-1/time_entries/8127',
      ),
    ).toBe(false);
  });
});
