import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalMyWorkOptions } from '../models/external-provider.models';
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
const options: ExternalMyWorkOptions = {
  includeCompleted: true,
  connectionId: 'connection-jira',
  connectionGeneration: 2,
};

function issue(
  key: string,
  project: { id: string; key: string; name: string },
): Record<string, unknown> {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `Issue ${key}`,
      status: {
        id: 'status-progress',
        name: 'In Progress',
        statusCategory: { key: 'indeterminate' },
      },
      assignee: { accountId: 'account-1' },
      updated: '2026-08-19T10:00:00.000Z',
      duedate: null,
      resolutiondate: null,
      project,
    },
  };
}

function configuration(
  id: number,
  name: string,
  filterId: string,
  project?: { id: string; key: string; name: string },
): Record<string, unknown> {
  return {
    id,
    name,
    filter: { id: filterId },
    ...(project
      ? { location: { type: 'project', id: project.id, key: project.key, name: project.name } }
      : {}),
    columnConfig: {
      columns: [
        { name: 'To Do', statuses: [{ id: 'status-open' }, { id: 'status-ready' }] },
        { name: 'In Progress', statuses: [{ id: 'status-progress' }] },
        { name: 'Done', statuses: [{ id: 'status-done' }] },
      ],
    },
  };
}

function providerWith(requestJson: jest.Mock): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

describe('Jira relevant board discovery', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('discovers project boards after account search, deduplicates them, and routes unmatched work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const engineering = { id: 'project-1', key: 'ENG', name: 'Engineering' };
    const operations = { id: 'project-2', key: 'OPS', name: 'Operations' };
    const calls: string[] = [];
    const boardIssueRequests: URL[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      calls.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/myself')) {
        return { accountId: 'account-1', displayName: 'Grace' };
      }
      if (url.pathname.endsWith('/configuration') && url.pathname.startsWith('/rest/api/3')) {
        return { timeTrackingEnabled: true };
      }
      if (url.pathname === '/rest/api/3/search/jql') {
        return {
          issues: [
            issue('ENG-1', engineering),
            issue('ENG-2', engineering),
            issue('OPS-1', operations),
            issue('ENG-EPIC', engineering),
          ],
        };
      }
      if (url.pathname === '/rest/agile/1.0/board') {
        const project = url.searchParams.get('projectKeyOrId');
        if (project === 'ENG' && url.searchParams.get('startAt') === '0') {
          return {
            values: [
              { id: 42, name: 'Engineering delivery', type: 'scrum' },
              { id: 99, name: 'Shared operations', type: 'kanban' },
            ],
            isLast: false,
          };
        }
        if (project === 'ENG' && url.searchParams.get('startAt') === '2') {
          return { values: [{ id: 43, name: 'Engineering empty', type: 'kanban' }], isLast: true };
        }
        if (project === 'OPS') {
          return {
            values: [{ id: 99, name: 'Shared operations duplicate', type: 'kanban' }],
            isLast: true,
          };
        }
      }
      if (url.pathname.startsWith('/rest/software/1.0/board/')) {
        boardIssueRequests.push(url);
        if (url.pathname.includes('/42/')) {
          return url.searchParams.has('nextPageToken')
            ? { issues: [{ key: 'ENG-2' }] }
            : { issues: [{ key: 'ENG-1' }], nextPageToken: 'board-42-page-2' };
        }
        if (url.pathname.includes('/99/')) {
          return { issues: [{ key: 'OPS-1' }, { key: 'NOT-ASSIGNED' }] };
        }
        return { issues: [] };
      }
      if (url.pathname === '/rest/agile/1.0/board/42/configuration') {
        return configuration(42, 'Engineering delivery', 'filter-42', engineering);
      }
      if (url.pathname === '/rest/agile/1.0/board/99/configuration') {
        return configuration(99, 'Shared operations', 'filter-99');
      }
      if (url.pathname === '/rest/api/3/filter/filter-42') {
        return { id: 'filter-42', description: 'Delivery flow', jql: 'private = vendor' };
      }
      if (url.pathname === '/rest/api/3/filter/filter-99') {
        return { id: 'filter-99', name: 'Shared filter' };
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });

    const result = await providerWith(requestJson).myWork!.discover(credentials, options);

    const accountSearchIndex = calls.findIndex((call) =>
      call.startsWith('POST /rest/api/3/search/jql'),
    );
    const firstBoardIndex = calls.findIndex((call) =>
      call.startsWith('GET /rest/agile/1.0/board?'),
    );
    expect(accountSearchIndex).toBeGreaterThanOrEqual(0);
    expect(firstBoardIndex).toBeGreaterThan(accountSearchIndex);
    expect(calls.filter((call) => call.startsWith('GET /rest/agile/1.0/board?')).sort()).toEqual([
      'GET /rest/agile/1.0/board?projectKeyOrId=ENG&startAt=0&maxResults=100',
      'GET /rest/agile/1.0/board?projectKeyOrId=ENG&startAt=2&maxResults=100',
      'GET /rest/agile/1.0/board?projectKeyOrId=OPS&startAt=0&maxResults=100',
    ]);
    expect(boardIssueRequests).toHaveLength(4);
    for (const url of boardIssueRequests) {
      expect(url.searchParams.get('maxResults')).toBe('100');
      expect(url.searchParams.get('fields')).toBe('key');
      expect(url.searchParams.get('jql')).toBe(
        'assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -30d) ORDER BY updated DESC',
      );
    }
    expect(
      boardIssueRequests.filter((url) => url.searchParams.get('nextPageToken') !== null),
    ).toHaveLength(1);
    expect(
      boardIssueRequests
        .find((url) => url.searchParams.has('nextPageToken'))
        ?.searchParams.get('nextPageToken'),
    ).toBe('board-42-page-2');

    expect(result.workAreas.map(({ remoteId }) => remoteId)).toEqual([
      '42',
      '99',
      'other-assigned',
    ]);
    expect(result.workAreas[0]).toEqual({
      remoteId: '42',
      scopeKey: 'acme.atlassian.net',
      name: 'Engineering delivery',
      kind: 'board',
      description: 'Delivery flow',
      assignedTaskCount: 2,
      hierarchy: [
        { kind: 'workspace', remoteId: 'acme.atlassian.net', name: 'acme.atlassian.net' },
        { kind: 'project', remoteId: 'project-1', name: 'Engineering' },
      ],
      workflow: {
        isOverridden: true,
        columns: [
          {
            remoteId: null,
            remoteStatusIds: ['status-open', 'status-ready'],
            name: 'To Do',
            color: '#6b778c',
            category: 'active',
            position: 0,
          },
          {
            remoteId: null,
            remoteStatusIds: ['status-progress'],
            name: 'In Progress',
            color: '#6b778c',
            category: 'active',
            position: 1,
          },
          {
            remoteId: null,
            remoteStatusIds: ['status-done'],
            name: 'Done',
            color: '#36b37e',
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
    });
    expect(result.workAreas[1]).toEqual(
      expect.objectContaining({ description: null, assignedTaskCount: 1 }),
    );
    expect(result.workAreas[2]).toEqual(
      expect.objectContaining({
        remoteId: 'other-assigned',
        name: 'Other assigned issues',
        kind: 'board',
        assignedTaskCount: 1,
      }),
    );
    expect(result.tasks.map(({ workArea, task }) => [workArea.remoteId, task.remoteId])).toEqual([
      ['42', 'ENG-1'],
      ['42', 'ENG-2'],
      ['99', 'OPS-1'],
      ['other-assigned', 'ENG-EPIC'],
    ]);
    expect(result.tasks.map(({ task }) => task.status.remoteId)).toEqual([
      'status-progress',
      'status-progress',
      'status-progress',
      'status-progress',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/columnConfig|private = vendor|filterId|isLast/);
  });

  it('keys successful board metadata cache entries by connection generation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const engineering = { id: 'project-1', key: 'ENG', name: 'Engineering' };
    let configurationCalls = 0;
    let filterCalls = 0;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/myself')) return { accountId: 'account-1', displayName: 'Grace' };
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      if (url.pathname === '/rest/api/3/search/jql')
        return { issues: [issue('ENG-1', engineering)] };
      if (url.pathname === '/rest/agile/1.0/board') {
        return { values: [{ id: 42, name: 'Delivery' }], isLast: true };
      }
      if (url.pathname === '/rest/software/1.0/board/42/issue') {
        return { issues: [{ key: 'ENG-1' }] };
      }
      if (url.pathname === '/rest/agile/1.0/board/42/configuration') {
        configurationCalls += 1;
        return configuration(42, 'Delivery', 'filter-42', engineering);
      }
      if (url.pathname === '/rest/api/3/filter/filter-42') {
        filterCalls += 1;
        return { description: 'Cached description' };
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.discover(credentials, options);
    await provider.myWork!.discover(credentials, options);
    await provider.myWork!.discover(credentials, { ...options, connectionGeneration: 3 });

    expect(configurationCalls).toBe(2);
    expect(filterCalls).toBe(2);
  });

  it.each(['configuration', 'filter'] as const)(
    'keeps a retryable error card and retries a failed %s request on the next refresh',
    async (failurePoint) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
      const engineering = { id: 'project-1', key: 'ENG', name: 'Engineering' };
      let failed = false;
      let configurationCalls = 0;
      let filterCalls = 0;
      const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/myself')) {
          return { accountId: 'account-1', displayName: 'Grace' };
        }
        if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
        if (url.pathname === '/rest/api/3/search/jql') {
          return { issues: [issue('ENG-1', engineering)] };
        }
        if (url.pathname === '/rest/agile/1.0/board') {
          return { values: [{ id: 42, name: 'Delivery' }], isLast: true };
        }
        if (url.pathname === '/rest/software/1.0/board/42/issue') {
          return { issues: [{ key: 'ENG-1' }] };
        }
        if (url.pathname === '/rest/agile/1.0/board/42/configuration') {
          configurationCalls += 1;
          if (failurePoint === 'configuration' && !failed) {
            failed = true;
            throw new SafeVendorHttpError('timeout');
          }
          return configuration(42, 'Delivery', 'filter-42', engineering);
        }
        if (url.pathname === '/rest/api/3/filter/filter-42') {
          filterCalls += 1;
          if (failurePoint === 'filter' && !failed) {
            failed = true;
            throw new SafeVendorHttpError('timeout');
          }
          return { description: 'Recovered metadata' };
        }
        throw new Error(`unexpected Jira request: ${url.toString()}`);
      });
      const provider = providerWith(requestJson);

      const failedResult = await provider.myWork!.discover(credentials, options);
      expect(failedResult.workAreas).toEqual([
        expect.objectContaining({
          remoteId: '42',
          description: null,
          workflow: { isOverridden: false, columns: [] },
          refresh: { state: 'error', refreshedAt: null, retryable: true, retryAt: null },
        }),
      ]);
      expect(failedResult.tasks[0].workArea).toBe(failedResult.workAreas[0]);

      const recovered = await provider.myWork!.discover(credentials, options);
      expect(recovered.workAreas[0]).toEqual(
        expect.objectContaining({
          description: 'Recovered metadata',
          refresh: expect.objectContaining({ state: 'fresh', retryable: false }),
        }),
      );
      expect(configurationCalls).toBe(2);
      expect(filterCalls).toBe(failurePoint === 'filter' ? 2 : 1);
    },
  );

  it('fails the full refresh when a later enhanced board-issue page fails', async () => {
    const engineering = { id: 'project-1', key: 'ENG', name: 'Engineering' };
    let boardIssueCalls = 0;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/myself')) return { accountId: 'account-1', displayName: 'Grace' };
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      if (url.pathname === '/rest/api/3/search/jql')
        return { issues: [issue('ENG-1', engineering)] };
      if (url.pathname === '/rest/agile/1.0/board') {
        return { values: [{ id: 42, name: 'Delivery' }], isLast: true };
      }
      if (url.pathname === '/rest/software/1.0/board/42/issue') {
        boardIssueCalls += 1;
        if (boardIssueCalls === 1) {
          return { issues: [{ key: 'ENG-1' }], nextPageToken: 'page-2' };
        }
        throw new SafeVendorHttpError('timeout');
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });

    await expect(
      providerWith(requestJson).myWork!.discover(credentials, options),
    ).rejects.toMatchObject({ code: 'jira_timeout' });
    expect(boardIssueCalls).toBe(2);
  });
});
