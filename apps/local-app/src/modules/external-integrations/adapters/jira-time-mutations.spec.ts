import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
  SafeVendorHttpError,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

const credentials: JiraIntegrationCredentials = {
  provider: 'jira',
  siteUrl: 'https://acme.atlassian.net',
  email: 'private@example.com',
  token: 'jira-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-jira',
  connectionGeneration: 4,
};

function adf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function worklog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    author: { accountId: 'jira-account-1', displayName: 'Grace' },
    started: '2026-08-19T10:00:00.000+0000',
    timeSpentSeconds: 3_600,
    comment: adf('Implementation'),
    updateAuthor: { accountId: 'jira-account-2', displayName: 'Other' },
    ...overrides,
  };
}

function worklogPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { startAt: 0, maxResults: 100, total: 1, worklogs: [worklog()], ...overrides };
}

function providerWith(requestJson: jest.Mock): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({
    requestJson,
    requestNoContent: requestJson,
  } as unknown as SafeVendorHttpClient);
}

function mutationTransport(handlers: {
  worklogList?: (params: URLSearchParams) => unknown;
  worklogExact?: (entryId: string) => unknown;
  deleteWorklog?: (params: URLSearchParams) => unknown;
  permission?: (enabled: boolean | undefined) => unknown;
}) {
  const requests: SafeVendorJsonRequest[] = [];
  const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/rest/api/3/myself') {
      return { accountId: 'jira-account-1', displayName: 'Grace' };
    }
    if (url.pathname === '/rest/api/3/mypermissions') {
      return {
        permissions: {
          DELETE_OWN_WORKLOGS: {
            id: 48,
            key: 'DELETE_OWN_WORKLOGS',
            enabled: handlers.permission?.(true),
          },
        },
      };
    }
    if (url.pathname === '/rest/api/3/issue/ENG-1/worklog') {
      return handlers.worklogList?.(url.searchParams);
    }
    const exact = url.pathname.match(/^\/rest\/api\/3\/issue\/ENG-1\/worklog\/(.+)$/);
    if (exact && request.method === undefined) {
      return handlers.worklogExact?.(decodeURIComponent(exact[1]!));
    }
    if (exact && request.method === 'DELETE') {
      return handlers.deleteWorklog?.(url.searchParams);
    }
    throw new Error(`unexpected Jira request: ${url.toString()}`);
  });
  return { provider: providerWith(requestJson), requestJson, requests };
}

describe('Jira time-entry mutations', () => {
  it('reads one exact worklog with ownership against /myself', async () => {
    const { provider } = mutationTransport({
      worklogExact: (entryId) => worklog({ id: entryId }),
    });

    const read = await provider.timeEntryMutations!.readTimeEntryExact!(
      credentials,
      context,
      'ENG-1',
      '10001',
    );

    expect(read).toEqual({
      remoteId: '10001',
      startedAt: '2026-08-19T10:00:00.000Z',
      durationMs: 3_600_000,
      owned: true,
    });
  });

  it('marks foreign worklogs unowned and returns null on exact 404', async () => {
    const foreign = mutationTransport({
      worklogExact: () => worklog({ author: { accountId: 'other' } }),
    });
    await expect(
      foreign.provider.timeEntryMutations!.readTimeEntryExact!(
        credentials,
        context,
        'ENG-1',
        '10001',
      ),
    ).resolves.toMatchObject({ owned: false });

    const missing = mutationTransport({
      worklogExact: () => {
        throw new SafeVendorHttpError('http_error', 404);
      },
    });
    await expect(
      missing.provider.timeEntryMutations!.readTimeEntryExact!(
        credentials,
        context,
        'ENG-1',
        '10001',
      ),
    ).resolves.toBeNull();
  });

  it('lists own ids with completeness proven by a short page', async () => {
    const { provider, requests } = mutationTransport({
      worklogList: () =>
        worklogPage({
          total: 2,
          worklogs: [
            worklog({ id: '10001' }),
            worklog({ id: '10002', author: { accountId: 'x' } }),
          ],
        }),
    });

    const range = await provider.timeEntryMutations!.listOwnTimeEntryIdsInRange!(
      credentials,
      context,
      'ENG-1',
      1_000,
      2_000,
    );

    expect(range).toEqual({ ids: ['10001'], complete: true });
    const listUrl = new URL(
      requests.find((request) => new URL(request.url).pathname.endsWith('/worklog'))!.url,
    );
    expect(listUrl.searchParams.get('startedAfter')).toBe('1000');
    expect(listUrl.searchParams.get('startedBefore')).toBe('2000');
  });

  it('marks completeness unproven when pages keep advancing', async () => {
    let calls = 0;
    const { provider } = mutationTransport({
      worklogList: (params) => {
        calls += 1;
        const startAt = Number(params.get('startAt'));
        return worklogPage({
          startAt,
          total: 10_000,
          worklogs: Array.from({ length: 100 }, (_, index) =>
            worklog({ id: String(startAt + index + 1), timeSpentSeconds: 60 }),
          ),
        });
      },
    });

    const range = await provider.timeEntryMutations!.listOwnTimeEntryIdsInRange!(
      credentials,
      context,
      'ENG-1',
      1_000,
      2_000,
    );

    expect(range.complete).toBe(false);
    expect(calls).toBe(5);
  });

  it('preflights delete with exact read, /myself ownership, and DELETE_OWN_WORKLOGS', async () => {
    const { provider, requests } = mutationTransport({
      worklogExact: () => worklog(),
      permission: () => true,
    });

    await provider.timeEntryMutations!.assertTimeEntryDeletable!(
      credentials,
      context,
      'ENG-1',
      '10001',
    );

    expect(
      requests.filter((request) => new URL(request.url).pathname === '/rest/api/3/mypermissions'),
    ).toHaveLength(1);
  });

  it('rejects the delete preflight when permission is missing or the entry is foreign', async () => {
    const noPermission = mutationTransport({
      worklogExact: () => worklog(),
      permission: () => false,
    });
    await expect(
      noPermission.provider.timeEntryMutations!.assertTimeEntryDeletable!(
        credentials,
        context,
        'ENG-1',
        '10001',
      ),
    ).rejects.toMatchObject({ code: 'jira_permission_denied' });

    const missing = mutationTransport({
      worklogExact: () => {
        throw new SafeVendorHttpError('http_error', 404);
      },
      permission: () => true,
    });
    await expect(
      missing.provider.timeEntryMutations!.assertTimeEntryDeletable!(
        credentials,
        context,
        'ENG-1',
        '10001',
      ),
    ).rejects.toMatchObject({ code: 'jira_not_found' });
  });

  it('deletes with adjustEstimate=leave and notifyUsers=false expecting exact 204', async () => {
    const seen: URLSearchParams[] = [];
    const { provider } = mutationTransport({
      deleteWorklog: (params) => {
        seen.push(params);
        return undefined;
      },
    });

    await provider.timeEntryMutations!.deleteTimeEntry!(credentials, context, 'ENG-1', '10001');

    expect(seen[0]!.get('adjustEstimate')).toBe('leave');
    expect(seen[0]!.get('notifyUsers')).toBe('false');
  });

  it('issues the delete as an exact no-content request to the singular worklog', async () => {
    const deletes: SafeVendorJsonRequest[] = [];
    const recording = providerWith(
      jest.fn(async (request: SafeVendorJsonRequest) => {
        if (request.method === 'DELETE') {
          deletes.push(request);
          return undefined;
        }
        if (new URL(request.url).pathname === '/rest/api/3/myself') {
          return { accountId: 'jira-account-1', displayName: 'Grace' };
        }
        return {};
      }),
    );

    await recording.timeEntryMutations!.deleteTimeEntry!(credentials, context, 'ENG-1', '10001');

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.method).toBe('DELETE');
    expect(deletes[0]!.url).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/ENG-1/worklog/10001?adjustEstimate=leave&notifyUsers=false',
    );
  });

  it('proves creates from the returned worklog JSON', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      if (new URL(request.url).pathname === '/rest/api/3/configuration') {
        return { timeTrackingEnabled: true };
      }
      return { id: 10042 };
    });
    const provider = providerWith(requestJson);

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'ENG-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).resolves.toEqual({ remoteEntryId: '10042' });
  });
});
