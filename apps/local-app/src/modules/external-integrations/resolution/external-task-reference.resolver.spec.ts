import { storageCredentialSource } from '../connections/integration-credential-source';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { JiraExternalTaskProvider } from '../adapters/jira-external-task.provider';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalProviderTaskDetail } from '../models/external-provider.models';
import { ExternalMyWorkService } from '../my-work/external-my-work.service';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import type {
  SafeVendorHttpClient,
  SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { ExternalTaskReferenceResolver } from './external-task-reference.resolver';

const projectId = 'project-1';

const credentials: Record<IntegrationProvider, IntegrationCredentials> = {
  clickup: { provider: 'clickup', token: 'clickup-secret' } as IntegrationCredentials,
  jira: {
    provider: 'jira',
    siteUrl: 'https://acme.atlassian.net',
    email: 'private@example.com',
    token: 'jira-secret',
  },
};

function connectionFor(provider: IntegrationProvider): IntegrationConnection {
  return {
    id: `connection-${provider}`,
    projectId,
    provider,
    legacySourceConnectionId: null,
    generation: provider === 'jira' ? 4 : 7,
    subtaskSyncEnabled: true,
    syncSettingRevision: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const jiraStatus = {
  id: 'status-progress',
  name: 'In Progress',
  statusCategory: { key: 'indeterminate' },
};

/** Jira returns the same issue for its key in any case and for its numeric id. */
function jiraIssue(): Record<string, unknown> {
  return {
    id: '10001',
    key: 'ENG-1',
    fields: {
      summary: 'Ship links',
      description: null,
      status: jiraStatus,
      duedate: null,
      priority: null,
      project: { id: 'project-eng', key: 'ENG', name: 'Engineering' },
      subtasks: [
        { id: '10002', key: 'ENG-2', fields: { summary: 'Rich child', status: jiraStatus } },
        // Incomplete reference: the fallback read proves its parent by key.
        { id: '10003', key: 'ENG-3', fields: {} },
      ],
      timetracking: {},
    },
  };
}

function fakeJiraHttp(): jest.Mock {
  return jest.fn(async (request: SafeVendorJsonRequest) => {
    const path = new URL(request.url).pathname;
    if (
      ['/rest/api/3/issue/ENG-1', '/rest/api/3/issue/eng-1', '/rest/api/3/issue/10001'].includes(
        path,
      )
    ) {
      return jiraIssue();
    }
    if (path === '/rest/api/3/issue/ENG-1/transitions') return { transitions: [] };
    if (path === '/rest/api/3/issue/ENG-3') {
      return {
        id: '10003',
        key: 'ENG-3',
        fields: { summary: 'Fallback child', status: jiraStatus, parent: { key: 'ENG-1' } },
      };
    }
    if (path === '/rest/api/3/configuration') return { timeTrackingEnabled: false };
    throw new Error(`unexpected Jira request: ${path}`);
  });
}

function clickupDetail(): ExternalProviderTaskDetail {
  return {
    remoteId: 'abc123',
    remoteKey: 'abc123',
    title: 'ClickUp task',
    description: 'Body',
    descriptionTruncated: false,
    status: { remoteId: 's1', name: 'open', color: '#000000', category: 'active', position: 0 },
    dueAt: null,
    priority: null,
    subtasks: [],
    subtasksTruncated: false,
    taskTotalDurationMs: null,
    webUrl: 'https://app.clickup.com/t/abc123',
    location: { scopeKey: 'team-9', workAreaId: 'list-5', workAreaName: 'Sprint' },
    allowedStatuses: [],
    actions: [],
  };
}

function setup(connected: IntegrationProvider[] = ['clickup', 'jira']) {
  const jiraHttp = fakeJiraHttp();
  const jira = new JiraExternalTaskProvider({
    requestJson: jiraHttp,
    requestNoContent: jiraHttp,
  } as unknown as SafeVendorHttpClient);
  const clickupGetTaskDetail = jest.fn(async (_c: unknown, _ctx: unknown, id: string) => {
    if (id !== 'abc123') throw new Error(`unexpected ClickUp task ${id}`);
    return clickupDetail();
  });
  const clickup = {
    provider: 'clickup',
    descriptor: { provider: 'clickup', displayName: 'ClickUp', capabilities: { myWork: true } },
    myWork: { getTaskDetail: clickupGetTaskDetail },
    verifyCredentials: jest.fn(),
  } as unknown as ExternalTaskProvider;

  const findExternalTaskLink = jest.fn(
    async (..._args: unknown[]): Promise<ExternalTaskLink | null> => null,
  );
  const storage = {
    getProject: jest.fn(async () => ({ id: projectId })),
    listIntegrationConnections: jest.fn(async () => connected.map(connectionFor)),
    getIntegrationConnection: jest.fn(async ({ provider }: { provider: IntegrationProvider }) =>
      connected.includes(provider) ? connectionFor(provider) : null,
    ),
    getIntegrationConnectionCredentials: jest.fn(
      async ({ provider }: { provider: IntegrationProvider }) =>
        connected.includes(provider) ? credentials[provider] : null,
    ),
    findExternalTaskLink,
  };
  const myWork = new ExternalMyWorkService(
    storage as unknown as StorageService,
    new ExternalTaskProviderRegistry([clickup, jira]),
    storageCredentialSource(storage as unknown as StorageService),
  );
  const resolver = new ExternalTaskReferenceResolver(storage as unknown as StorageService, myWork);
  return { resolver, storage, jiraHttp, clickupGetTaskDetail, findExternalTaskLink };
}

describe('ExternalTaskReferenceResolver', () => {
  it.each<
    [string, IntegrationProvider[], IntegrationProvider | undefined, string, IntegrationProvider]
  >([
    ['explicit provider', ['clickup', 'jira'], 'clickup', 'abc123', 'clickup'],
    ['ClickUp URL', ['clickup', 'jira'], undefined, 'https://app.clickup.com/t/abc123', 'clickup'],
    [
      'ClickUp URL with trailing slash, query and hash',
      ['clickup', 'jira'],
      undefined,
      'https://app.clickup.com/t/abc123/?comment=1#x',
      'clickup',
    ],
    ['Jira URL', ['clickup', 'jira'], undefined, 'https://acme.atlassian.net/browse/ENG-1', 'jira'],
    ['the only connected provider', ['clickup'], undefined, 'abc123', 'clickup'],
  ])('resolves the provider from %s', async (_name, connected, provider, ref, expected) => {
    const { resolver } = setup(connected);

    const result = await resolver.resolve({ projectId, ref, provider });

    expect(result.provider).toBe(expected);
  });

  it.each<
    [
      string,
      IntegrationProvider[],
      IntegrationProvider | undefined,
      string,
      Record<string, unknown>,
    ]
  >([
    [
      'several connected providers and a bare id',
      ['clickup', 'jira'],
      undefined,
      'abc123',
      { code: 'PROVIDER_REQUIRED', details: { connectedProviders: ['clickup', 'jira'] } },
    ],
    [
      'an unknown host',
      ['clickup', 'jira'],
      undefined,
      'https://github.com/t/abc123',
      { code: 'UNSUPPORTED_PROVIDER' },
    ],
    [
      'a provider not connected in the project',
      ['clickup'],
      'jira',
      'ENG-1',
      { code: 'INTEGRATION_NOT_CONNECTED', details: { provider: 'jira' } },
    ],
    [
      'a URL of a provider not connected in the project',
      ['jira'],
      undefined,
      'https://app.clickup.com/t/abc123',
      { code: 'INTEGRATION_NOT_CONNECTED', details: { provider: 'clickup' } },
    ],
    [
      'a bare id when no integration is connected',
      [],
      undefined,
      'abc123',
      { code: 'PROVIDER_REQUIRED', details: { connectedProviders: [] } },
    ],
    [
      'a Jira URL on another site',
      ['jira'],
      undefined,
      'https://other.atlassian.net/browse/ENG-1',
      { code: 'EXTERNAL_TASK_WRONG_SITE' },
    ],
    [
      'a ClickUp custom-id URL',
      ['clickup'],
      undefined,
      'https://app.clickup.com/t/9012/ENG-42',
      {
        code: 'EXTERNAL_TASK_REF_INVALID',
        message: expect.stringContaining('Custom task ids are not supported'),
      },
    ],
  ])('refuses %s without a vendor read', async (_name, connected, provider, ref, error) => {
    const { resolver, jiraHttp, clickupGetTaskDetail } = setup(connected);

    await expect(resolver.resolve({ projectId, ref, provider })).rejects.toMatchObject(error);
    expect(jiraHttp).not.toHaveBeenCalled();
    expect(clickupGetTaskDetail).not.toHaveBeenCalled();
  });

  describe('when the Jira connection is replaced after provider discovery', () => {
    function replaceJiraConnection(
      storage: ReturnType<typeof setup>['storage'],
      siteUrl: string,
    ): void {
      const replaced = { ...connectionFor('jira'), id: 'connection-jira-2', generation: 5 };
      storage.getIntegrationConnection.mockResolvedValue(replaced);
      storage.getIntegrationConnectionCredentials.mockResolvedValue({
        ...credentials.jira,
        siteUrl,
      } as IntegrationCredentials);
    }

    it('checks the URL site against the credentials that serve the read', async () => {
      const { resolver, storage, jiraHttp } = setup(['jira']);
      replaceJiraConnection(storage, 'https://other.atlassian.net');

      await expect(
        resolver.resolve({ projectId, ref: 'https://acme.atlassian.net/browse/ENG-1' }),
      ).rejects.toMatchObject({
        code: 'EXTERNAL_TASK_WRONG_SITE',
        details: { site: 'acme.atlassian.net', connectedSite: 'other.atlassian.net' },
      });
      expect(jiraHttp).not.toHaveBeenCalled();
    });

    it('returns the epoch of the replacement connection that served the read', async () => {
      const { resolver, storage } = setup(['jira']);
      replaceJiraConnection(storage, 'https://acme.atlassian.net');

      const result = await resolver.resolve({
        projectId,
        ref: 'https://acme.atlassian.net/browse/ENG-1',
      });

      expect(result.link).toMatchObject({
        connectionId: 'connection-jira-2',
        connectionGeneration: 5,
      });
    });
  });

  it('resolves a Jira key in any case, a numeric id and a URL to the canonical key identity', async () => {
    const refs = ['ENG-1', 'eng-1', '10001', 'https://acme.atlassian.net/browse/ENG-1'];
    const results = [];
    for (const ref of refs) {
      const { resolver, jiraHttp } = setup(['jira']);
      results.push(await resolver.resolve({ projectId, ref }));
      // Every read after the issue itself uses the canonical key.
      const laterPaths = jiraHttp.mock.calls
        .slice(1)
        .map(([request]: [SafeVendorJsonRequest]) => new URL(request.url).pathname);
      expect(laterPaths).toEqual(
        expect.arrayContaining(['/rest/api/3/issue/ENG-1/transitions', '/rest/api/3/issue/ENG-3']),
      );
    }

    for (const result of results) {
      expect(result.link).toEqual(results[0].link);
      expect(result.detail.remoteId).toBe('ENG-1');
      expect(result.detail.subtasks.map((subtask) => subtask.remoteKey).sort()).toEqual([
        'ENG-2',
        'ENG-3',
      ]);
      expect(result.detail.subtasksTruncated).toBe(false);
    }
    expect(results[0].link).toEqual({
      connectionId: 'connection-jira',
      connectionGeneration: 4,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-1',
      sourceSnapshot: {
        remoteKey: 'ENG-1',
        title: 'Ship links',
        description: null,
        webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        workAreaId: 'project-eng',
        workAreaName: 'Engineering',
        statusName: 'In Progress',
      },
    });
  });

  it('resolves a ClickUp id and a ClickUp URL to the same link payload', async () => {
    const { resolver } = setup(['clickup']);

    const byId = await resolver.resolve({ projectId, ref: 'abc123' });
    const byUrl = await resolver.resolve({ projectId, ref: 'https://app.clickup.com/t/abc123' });

    expect(byUrl.link).toEqual(byId.link);
    expect(byId.link).toEqual({
      connectionId: 'connection-clickup',
      connectionGeneration: 7,
      provider: 'clickup',
      remoteScopeKey: 'team-9',
      remoteTaskId: 'abc123',
      sourceSnapshot: {
        remoteKey: 'abc123',
        title: 'ClickUp task',
        description: 'Body',
        webUrl: 'https://app.clickup.com/t/abc123',
        workAreaId: 'list-5',
        workAreaName: 'Sprint',
        statusName: 'open',
      },
    });
  });

  it('reports the linked Epic even when the link lost its connection on disconnect', async () => {
    const { resolver, findExternalTaskLink } = setup(['clickup']);
    findExternalTaskLink.mockResolvedValue({
      id: 'link-1',
      epicId: 'epic-1',
      projectId,
      connectionId: null,
      provider: 'clickup',
      remoteScopeKey: 'team-9',
      remoteTaskId: 'abc123',
      sourceSnapshot: {},
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    const result = await resolver.resolve({ projectId, ref: 'abc123' });

    expect(result.linkedEpicId).toBe('epic-1');
    expect(findExternalTaskLink).toHaveBeenCalledWith(projectId, 'clickup', 'team-9', 'abc123');
  });
});
