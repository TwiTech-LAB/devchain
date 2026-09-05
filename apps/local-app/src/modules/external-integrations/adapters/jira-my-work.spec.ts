import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { JiraProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalMyWorkOptions } from '../models/external-provider.models';
import { ExternalMyWorkService } from '../my-work/external-my-work.service';
import {
  SafeVendorHttpClient,
  SafeVendorHttpError,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

const credentials: JiraIntegrationCredentials = {
  provider: 'jira',
  siteUrl: 'https://Acme.Atlassian.Net',
  email: 'private@example.com',
  token: 'jira-secret-token',
};
const options: ExternalMyWorkOptions = {
  includeCompleted: true,
  connectionId: 'connection-jira',
  connectionGeneration: 2,
};

function issue(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: key === 'ENG-1' ? '10001' : `id-${key}`,
    key,
    fields: {
      summary: `Issue ${key}`,
      status: {
        id: 'status-progress',
        name: 'In Progress',
        statusCategory: { key: 'indeterminate' },
      },
      assignee: { accountId: 'account-1', emailAddress: 'private@example.com' },
      updated: '2026-08-19T10:00:00.000Z',
      duedate: '2026-08-22',
      resolutiondate: null,
      project: { id: 'project-1', key: 'ENG', name: 'Engineering' },
      parent: null,
      issuetype: { id: '10000', name: 'Task', subtask: false },
      ...((overrides.fields as Record<string, unknown> | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'fields')),
  };
}

function providerWith(requestJson: jest.Mock): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

describe('Jira My Work capability', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('normalizes the tenant, validates classic Basic auth, and returns only safe identity', async () => {
    const requestJson = jest.fn(async () => ({
      accountId: 'account-1',
      displayName: 'Grace',
      emailAddress: 'private@example.com',
      avatarUrls: { '48x48': 'https://example.com/private.png' },
    }));
    const provider = providerWith(requestJson);

    await expect(provider.verifyCredentials(credentials)).resolves.toEqual({
      provider: 'jira',
      remoteId: 'account-1',
      displayName: 'Grace',
    });
    expect(requestJson).toHaveBeenCalledWith({
      url: 'https://acme.atlassian.net/rest/api/3/myself',
      allowedOrigins: ['https://acme.atlassian.net'],
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from('private@example.com:jira-secret-token').toString(
          'base64',
        )}`,
      },
    });
  });

  it.each([
    'http://acme.atlassian.net',
    'https://atlassian.net',
    'https://nested.acme.atlassian.net',
    'https://acme.atlassian.net.',
    'https://user@acme.atlassian.net',
    'https://acme.atlassian.net:443',
    'https://acme.atlassian.net/path',
    'https://acme.atlassian.net?private=value',
    'https://acme.atlassian.net#fragment',
    'https://api.atlassian.com',
    'https://127.0.0.1',
  ])('rejects unsupported Jira site %s before transport', async (siteUrl) => {
    const requestJson = jest.fn();
    const provider = providerWith(requestJson);

    await expect(
      provider.verifyCredentials({ ...credentials, siteUrl }),
    ).rejects.toMatchObject<JiraProviderError>({ code: 'jira_request_rejected' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('reports bad email/token and scoped-token incompatibility only as possible 401 causes', async () => {
    const requestJson = jest.fn(async () => {
      throw new SafeVendorHttpError('http_error', 401);
    });
    const provider = providerWith(requestJson);

    await expect(provider.verifyCredentials(credentials)).rejects.toMatchObject({
      code: 'jira_authentication_failed',
      details: expect.objectContaining({
        provider: 'jira',
        reason: 'authentication_failed',
        possibleCauses: ['bad_email', 'bad_token', 'scoped_token_unsupported'],
      }),
    });
  });

  it('searches current-user work account-wide with token pagination and normalized project cards', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const searchBodies: Array<Record<string, unknown>> = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path === '/rest/api/3/myself') {
        return { accountId: 'account-1', displayName: 'Grace' };
      }
      if (path === '/rest/api/3/configuration') {
        return { timeTrackingEnabled: true, attachmentsEnabled: true };
      }
      if (path === '/rest/api/3/search/jql') {
        const body = JSON.parse(String(request.body)) as Record<string, unknown>;
        searchBodies.push(body);
        if (!body.nextPageToken) {
          return {
            issues: [
              issue('ENG-1', {
                fields: {
                  parent: { id: '9999', key: 'ENG-0' },
                  issuetype: { id: '10001', name: 'Subtask', subtask: true },
                },
              }),
              issue('ENG-2', {
                fields: {
                  parent: { id: '9000', key: 'ENG-EPIC' },
                  issuetype: { id: '10000', name: 'Story', subtask: false },
                },
              }),
            ],
            nextPageToken: 'page-2',
          };
        }
        return {
          issues: [
            issue('ENG-2'),
            issue('ENG-3', {
              fields: {
                status: {
                  id: 'status-done',
                  name: 'Done',
                  statusCategory: { key: 'done' },
                },
                resolutiondate: '2026-08-10T12:00:00.000Z',
                parent: { id: 'malformed-key', key: 42 },
                issuetype: { id: '10001', name: 'Subtask', subtask: true },
              },
            }),
            issue('OLD-1', {
              fields: {
                status: {
                  id: 'status-done',
                  name: 'Done',
                  statusCategory: { key: 'done' },
                },
                resolutiondate: '2026-07-01T12:00:00.000Z',
              },
            }),
            issue('OTHER-1', {
              fields: { assignee: { accountId: 'different-account' } },
            }),
          ],
        };
      }
      if (path === '/rest/agile/1.0/board') {
        return { values: [], isLast: true };
      }
      throw new Error(`unexpected Jira path: ${path}`);
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, options);

    expect(result.capabilities).toEqual({ timeTrackingEnabled: true });
    expect(result.tasks.map(({ task }) => [task.remoteId, task.status.category])).toEqual([
      ['ENG-1', 'active'],
      ['ENG-2', 'active'],
      ['ENG-3', 'completed'],
    ]);
    expect(result.workAreas).toEqual([
      expect.objectContaining({
        remoteId: 'other-assigned',
        scopeKey: 'acme.atlassian.net',
        name: 'Other assigned issues',
        kind: 'board',
        assignedTaskCount: 3,
        hierarchy: [
          {
            kind: 'workspace',
            remoteId: 'acme.atlassian.net',
            name: 'acme.atlassian.net',
          },
        ],
      }),
    ]);
    expect(result.tasks[0].task).toEqual({
      remoteId: 'ENG-1',
      parentRemoteTaskId: 'ENG-0',
      title: 'Issue ENG-1',
      status: { remoteId: 'status-progress', name: 'In Progress', category: 'active' },
      updatedAt: '2026-08-19T10:00:00.000Z',
      dueAt: '2026-08-22T00:00:00.000Z',
      completedAt: null,
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    });
    expect(result.tasks[1].task.parentRemoteTaskId).toBeNull();
    expect(result.tasks[2].task.parentRemoteTaskId).toBeNull();
    expect(searchBodies).toEqual([
      {
        jql: 'assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -30d) ORDER BY updated DESC',
        fields: [
          'summary',
          'status',
          'assignee',
          'updated',
          'duedate',
          'resolutiondate',
          'project',
          'parent',
          'issuetype',
        ],
        maxResults: 100,
      },
      expect.objectContaining({ nextPageToken: 'page-2' }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /emailAddress|private@example.com|statusCategory|resolutiondate|jql|authorization/i,
    );
    for (const [request] of requestJson.mock.calls) {
      expect(request.allowedOrigins).toEqual(['https://acme.atlassian.net']);
      expect(request.url).not.toMatch(/_edge|api\.atlassian\.com/);
    }
  });

  it('uses active-only JQL and records disabled time tracking safely', async () => {
    let searchBody: Record<string, unknown> | undefined;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/myself')) {
        return { accountId: 'account-1', displayName: 'Grace' };
      }
      if (path.endsWith('/configuration')) {
        return { timeTrackingEnabled: false };
      }
      searchBody = JSON.parse(String(request.body)) as Record<string, unknown>;
      return { issues: [] };
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.discover(credentials, {
      ...options,
      includeCompleted: false,
    });

    expect(result.capabilities).toEqual({ timeTrackingEnabled: false });
    expect(searchBody?.jql).toBe(
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    );
  });

  it('dispatches Jira through the provider-neutral My Work service contract', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/myself')) {
        return { accountId: 'account-1', displayName: 'Grace' };
      }
      if (path.endsWith('/configuration')) {
        return { timeTrackingEnabled: true };
      }
      return { issues: [] };
    });
    const provider = providerWith(requestJson);
    const connection = {
      id: 'connection-jira',
      projectId: 'project-1',
      legacySourceConnectionId: null,
      provider: 'jira' as const,
      generation: 2,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    };
    const storage = {
      getProject: jest.fn(async () => ({ id: 'project-1' })),
      getIntegrationConnection: jest.fn(async () => connection),
      getIntegrationConnectionCredentials: jest.fn(async () => credentials),
    };
    const service = new ExternalMyWorkService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([provider]),
    );

    await expect(
      service.getMyWork('project-1', 'jira', { includeCompleted: false }),
    ).resolves.toEqual(
      expect.objectContaining({
        provider: 'jira',
        descriptor: {
          provider: 'jira',
          displayName: 'Jira',
          capabilities: { myWork: true },
        },
        supported: true,
        capabilities: { timeTrackingEnabled: true },
        workAreas: [],
        tasks: [],
      }),
    );
  });

  it('fails the full refresh when a later enhanced-search page fails', async () => {
    let searchCalls = 0;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/myself')) {
        return { accountId: 'account-1', displayName: 'Grace' };
      }
      if (path.endsWith('/configuration')) {
        return { timeTrackingEnabled: true };
      }
      searchCalls += 1;
      if (searchCalls === 1) {
        return { issues: [issue('ENG-1')], nextPageToken: 'page-2' };
      }
      throw new SafeVendorHttpError('timeout');
    });
    const provider = providerWith(requestJson);

    await expect(provider.myWork!.discover(credentials, options)).rejects.toMatchObject({
      code: 'jira_timeout',
    });
    expect(searchCalls).toBe(2);
  });
});
