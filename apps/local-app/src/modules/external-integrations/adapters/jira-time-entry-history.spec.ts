import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
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
    author: {
      accountId: 'jira-account-1',
      displayName: 'Grace',
      avatarUrls: { '48x48': 'https://private.example/48.svg' },
    },
    started: '2026-08-19T10:00:00.000+0000',
    created: '2026-08-19T10:05:00.000+0000',
    updated: '2026-08-19T10:05:00.000+0000',
    timeSpent: '1h',
    timeSpentSeconds: 3_600,
    comment: adf('Implementation'),
    updateAuthor: { accountId: 'jira-account-2', displayName: 'Other' },
    ...overrides,
  };
}

function worklogPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { startAt: 0, maxResults: 100, total: 0, worklogs: [], ...overrides };
}

function providerWith(requestJson: jest.Mock): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({
    requestJson,
    requestNoContent: requestJson,
  } as unknown as SafeVendorHttpClient);
}

/** Identity plus own-worklog permissions served from fixed fixtures. */
function historyTransport(
  worklogHandler: (params: URLSearchParams) => unknown,
  permissions: { edit?: boolean; delete?: boolean } = {},
) {
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
          EDIT_OWN_WORKLOGS: {
            id: 47,
            key: 'EDIT_OWN_WORKLOGS',
            enabled: permissions.edit ?? true,
          },
          DELETE_OWN_WORKLOGS: {
            id: 48,
            key: 'DELETE_OWN_WORKLOGS',
            enabled: permissions.delete ?? true,
          },
        },
      };
    }
    if (url.pathname === '/rest/api/3/issue/ENG-1/worklog') {
      return worklogHandler(url.searchParams);
    }
    throw new Error(`unexpected Jira request: ${url.toString()}`);
  });
  return { provider: providerWith(requestJson), requestJson, requests };
}

function worklogRequests(requests: SafeVendorJsonRequest[]): SafeVendorJsonRequest[] {
  return requests.filter(
    (request) => new URL(request.url).pathname === '/rest/api/3/issue/ENG-1/worklog',
  );
}

describe('Jira time-entry history', () => {
  it('filters to myself, validates pages, and sorts by startedAt then id', async () => {
    const { provider, requestJson, requests } = historyTransport((params) => {
      if (params.get('maxResults') === '1') {
        return worklogPage({
          maxResults: 1,
          total: 4,
          worklogs: [worklog({ id: '10001' })],
        });
      }
      return worklogPage({
        total: 4,
        worklogs: [
          worklog({ id: '10001', started: '2026-08-19T09:00:00.000+0000' }),
          worklog({
            id: '10040',
            started: '2026-08-19T11:00:00.000+0000',
            timeSpentSeconds: 1_800,
            comment: adf('x'.repeat(10_500)),
          }),
          worklog({
            id: '10020',
            started: '2026-08-19T11:00:00.000+0000',
            timeSpentSeconds: 60,
            comment: null,
          }),
          worklog({ id: '10030', author: { accountId: 'jira-account-2', displayName: 'Other' } }),
        ],
      });
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    expect(result).toEqual({
      windowDays: 30,
      truncated: false,
      hasRunningTimer: false,
      entries: [
        {
          remoteId: '10020',
          durationMs: 60_000,
          startedAt: '2026-08-19T11:00:00.000Z',
          note: null,
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
        },
        {
          remoteId: '10040',
          durationMs: 1_800_000,
          startedAt: '2026-08-19T11:00:00.000Z',
          note: 'x'.repeat(10_000),
          noteTruncated: true,
          canEdit: true,
          canDelete: true,
        },
        {
          remoteId: '10001',
          durationMs: 3_600_000,
          startedAt: '2026-08-19T09:00:00.000Z',
          note: 'Implementation',
          noteTruncated: false,
          canEdit: true,
          canDelete: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /Grace|avatarUrls|updateAuthor|displayName|timeSpent"|created|updated|private\.example/i,
    );

    const permissionCalls = requests.filter(
      (request) => new URL(request.url).pathname === '/rest/api/3/mypermissions',
    );
    expect(permissionCalls).toHaveLength(1);
    expect(new URL(permissionCalls[0]!.url).searchParams.get('permissions')).toBe(
      'EDIT_OWN_WORKLOGS,DELETE_OWN_WORKLOGS',
    );

    const pages = worklogRequests(requests);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const params = new URL(page.url).searchParams;
      expect(params.get('startedAfter')).toMatch(/^\d+$/);
      expect(params.get('startedBefore')).toMatch(/^\d+$/);
      const windowMs = Number(params.get('startedBefore')) - Number(params.get('startedAfter'));
      expect(windowMs).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000);
      expect(windowMs).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    }
    expect(new URL(pages[0]!.url).searchParams.get('maxResults')).toBe('1');
    expect(requestJson).toHaveBeenCalledTimes(4);
  });

  it('denies canDelete when DELETE_OWN_WORKLOGS is not granted', async () => {
    const { provider } = historyTransport(
      () => worklogPage({ maxResults: 1, total: 1, worklogs: [worklog()] }),
      { delete: false },
    );

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.canEdit).toBe(true);
    expect(result.entries[0]!.canDelete).toBe(false);
  });

  it('consumes an all-page response directly without further pages', async () => {
    const { provider, requests } = historyTransport(() =>
      worklogPage({
        maxResults: 3,
        total: 3,
        worklogs: [worklog({ id: '1' }), worklog({ id: '2' }), worklog({ id: '3' })],
      }),
    );

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    expect(worklogRequests(requests)).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it('walks backward from the tail and stops at five pages with truncated=true', async () => {
    let pageNumber = 0;
    const { provider, requests } = historyTransport((params) => {
      if (params.get('maxResults') === '1') {
        return worklogPage({ maxResults: 1, total: 900, worklogs: [worklog({ id: '0' })] });
      }
      const startAt = Number(params.get('startAt'));
      pageNumber += 1;
      return worklogPage({
        startAt,
        total: 900,
        worklogs: Array.from({ length: 100 }, (_, index) =>
          worklog({
            id: String(startAt + index + 1),
            started: `2026-08-01T10:00:00.000+0000`,
            timeSpentSeconds: 60,
          }),
        ),
      });
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    const pages = worklogRequests(requests);
    expect(pages).toHaveLength(5);
    expect(new URL(pages[1]!.url).searchParams.get('startAt')).toBe('800');
    expect(new URL(pages[4]!.url).searchParams.get('startAt')).toBe('500');
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(100);
    expect(pageNumber).toBe(4);
  });

  it('re-anchors the coverage target when totals change mid-walk', async () => {
    const { provider, requests } = historyTransport((params) => {
      if (params.get('maxResults') === '1') {
        return worklogPage({ maxResults: 1, total: 2, worklogs: [worklog({ id: '1' })] });
      }
      return worklogPage({
        total: 5,
        worklogs: [1, 2, 3, 4, 5].map((id) => worklog({ id: String(id), timeSpentSeconds: 60 })),
      });
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    expect(worklogRequests(requests)).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(5);
  });

  it('falls back to forward short pages when the probe page is empty', async () => {
    const { provider, requests } = historyTransport((params) => {
      if (params.get('maxResults') === '1') {
        return worklogPage({ maxResults: 1, total: 3, worklogs: [] });
      }
      expect(params.get('startAt')).toBe('0');
      return worklogPage({
        total: 3,
        worklogs: [1, 2, 3].map((id) => worklog({ id: String(id), timeSpentSeconds: 60 })),
      });
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    const pages = worklogRequests(requests);
    expect(pages).toHaveLength(2);
    expect(new URL(pages[1]!.url).searchParams.get('maxResults')).toBe('100');
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it('marks an empty forward fallback truncated', async () => {
    const { provider } = historyTransport(() =>
      worklogPage({ maxResults: 1, total: 3, worklogs: [] }),
    );

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('stops on a non-advancing backward page and marks coverage incomplete', async () => {
    const repeated = Array.from({ length: 100 }, (_, index) =>
      worklog({ id: String(150 + index), timeSpentSeconds: 60 }),
    );
    const { provider, requests } = historyTransport((params) => {
      if (params.get('maxResults') === '1') {
        return worklogPage({ maxResults: 1, total: 250, worklogs: [worklog({ id: '0' })] });
      }
      return worklogPage({ startAt: 150, total: 250, worklogs: repeated });
    });

    const result = await provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1');

    const pages = worklogRequests(requests);
    expect(pages).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it.each([
    [
      'page exceeds its declared maxResults',
      { startAt: 0, maxResults: 1, total: 5, worklogs: [worklog(), worklog()] },
    ],
    [
      'page overruns its total',
      { startAt: 0, maxResults: 100, total: 1, worklogs: [worklog(), worklog()] },
    ],
    ['missing total', { startAt: 0, maxResults: 1, worklogs: [] }],
    ['negative startAt', { startAt: -1, maxResults: 1, total: 0, worklogs: [] }],
  ])('classifies a malformed envelope: %s', async (_case, payload) => {
    const { provider } = historyTransport(() => payload);

    await expect(
      provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1'),
    ).rejects.toMatchObject({ code: 'jira_invalid_response' });
  });

  it.each([
    ['malformed started', worklog({ started: 'not-a-time' })],
    ['fractional seconds', worklog({ timeSpentSeconds: 1.5 })],
    ['malformed author', worklog({ author: 'nope' })],
  ])('classifies a malformed worklog row: %s', async (_case, row) => {
    const { provider } = historyTransport(() =>
      worklogPage({ maxResults: 1, total: 1, worklogs: [row] }),
    );

    await expect(
      provider.myWork!.getTimeEntryHistory!(credentials, context, 'ENG-1'),
    ).rejects.toMatchObject({ code: 'jira_invalid_response' });
  });
});

describe('Jira task time totals', () => {
  function detailTransport(issue: unknown): { provider: JiraExternalTaskProvider } {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/api/3/issue/ENG-1') return issue;
      if (url.pathname === '/rest/api/3/issue/ENG-1/transitions') return { transitions: [] };
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });
    return { provider: providerWith(requestJson) };
  }

  function issue(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      id: '10001',
      key: 'ENG-1',
      fields: {
        summary: 'Ship',
        status: {
          id: 's1',
          name: 'In Progress',
          statusCategory: { key: 'indeterminate' },
        },
        project: { id: 'project-1', key: 'ENG', name: 'Engineering' },
        subtasks: [],
        ...fields,
      },
    };
  }

  it('reports null when the site omits the timetracking aggregate', async () => {
    const { provider } = detailTransport(issue({}));

    const result = await provider.myWork!.getTaskDetail!(credentials, context, 'ENG-1');

    expect(result.taskTotalDurationMs).toBeNull();
  });

  it('rejects a malformed timetracking aggregate', async () => {
    const { provider } = detailTransport(issue({ timetracking: { timeSpentSeconds: 'lots' } }));

    await expect(
      provider.myWork!.getTaskDetail!(credentials, context, 'ENG-1'),
    ).rejects.toMatchObject({ code: 'jira_invalid_response' });
  });
});
