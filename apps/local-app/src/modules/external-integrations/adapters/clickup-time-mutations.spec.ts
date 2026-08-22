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

  it('confirms a documented create receipt that carries no entry id', async () => {
    const { provider } = mutationTransport({ create: () => createReceipt() });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).resolves.toEqual({ remoteEntryId: null });
  });

  it('keeps the entry id when a compatible create response carries one', async () => {
    const { provider } = mutationTransport({ create: () => createReceipt({ id: 8127 }) });

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: 'Implementation',
      }),
    ).resolves.toEqual({ remoteEntryId: '8127' });
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

  it.each([
    ['a receipt naming a different task', createReceipt({ tid: 'other-task' })],
    ['a receipt without the documented time fields', { id: '8127' }],
    ['a body without the documented receipt', { noId: true }],
    ['a non-object body', 'not-json-shape'],
  ])('treats a create response with %s as unknown', async (_case, body) => {
    const { provider } = mutationTransport({ create: () => body });

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
  });
});
