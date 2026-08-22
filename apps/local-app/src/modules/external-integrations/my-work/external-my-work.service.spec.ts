import { BusyError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { IntegrationCredentials } from '../../storage/models/domain.models';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalMyWorkCapability,
  ExternalMyWorkSnapshot,
  ExternalProviderDescriptor,
} from '../models/external-provider.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ExternalMyWorkService } from './external-my-work.service';

describe('ExternalMyWorkService', () => {
  const clickupDescriptor: ExternalProviderDescriptor = {
    provider: 'clickup',
    displayName: 'ClickUp',
    capabilities: { myWork: true },
  };
  const jiraDescriptor: ExternalProviderDescriptor = {
    provider: 'jira',
    displayName: 'Jira',
    capabilities: { myWork: false },
  };
  const workArea = {
    remoteId: 'list-1',
    scopeKey: 'workspace-1',
    name: 'Sprint',
    kind: 'list' as const,
    description: 'Current sprint',
    assignedTaskCount: 1,
    hierarchy: [{ kind: 'workspace' as const, remoteId: 'workspace-1', name: 'Engineering' }],
    workflow: {
      isOverridden: false,
      columns: [
        {
          remoteId: 'progress',
          name: 'In progress',
          color: '#7c4dff',
          category: 'active' as const,
          position: 0,
        },
      ],
    },
    refresh: {
      state: 'fresh' as const,
      refreshedAt: '2026-08-19T12:00:00.000Z',
      retryable: false,
      retryAt: null,
    },
  };
  const snapshot: ExternalMyWorkSnapshot = {
    capabilities: { timeTrackingEnabled: true },
    workAreas: [workArea],
    tasks: [
      {
        workArea,
        task: {
          remoteId: 'task-1',
          title: 'Ship provider-neutral work',
          status: { name: 'In progress', category: 'active' },
          updatedAt: '2026-08-19T10:00:00.000Z',
          dueAt: null,
          completedAt: null,
          webUrl: 'https://app.clickup.com/t/task-1',
        },
      },
    ],
    refreshedAt: '2026-08-19T12:00:00.000Z',
  };

  let storage: jest.Mocked<
    Pick<StorageService, 'getIntegrationConnection' | 'getIntegrationConnectionCredentials'>
  >;
  let discover: jest.MockedFunction<ExternalMyWorkCapability['discover']>;
  let service: ExternalMyWorkService;

  beforeEach(() => {
    storage = {
      getIntegrationConnection: jest.fn(),
      getIntegrationConnectionCredentials: jest.fn(),
    };
    discover = jest.fn();
    const clickup: ExternalTaskProvider = {
      provider: 'clickup',
      descriptor: clickupDescriptor,
      verifyCredentials: jest.fn(),
      myWork: { discover, listComments: jest.fn() },
    };
    const jira: ExternalTaskProvider = {
      provider: 'jira',
      descriptor: jiraDescriptor,
      verifyCredentials: jest.fn(),
    };
    service = new ExternalMyWorkService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickup, jira]),
    );
  });

  it('resolves credentials and delegates supported providers through the registry capability', async () => {
    const credentials: IntegrationCredentials = { provider: 'clickup', token: 'secret-token' };
    storage.getIntegrationConnection.mockResolvedValue({
      id: 'connection-clickup',
      provider: 'clickup',
      generation: 7,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    });
    storage.getIntegrationConnectionCredentials.mockResolvedValue(credentials);
    discover.mockResolvedValue({
      ...snapshot,
      vendorPayload: { token: 'must-not-cross-the-service-boundary' },
    } as ExternalMyWorkSnapshot);

    const result = await service.getMyWork('clickup', { includeCompleted: true });

    expect(result).toEqual({
      provider: 'clickup',
      descriptor: clickupDescriptor,
      supported: true,
      ...snapshot,
    });
    expect(discover).toHaveBeenCalledWith(credentials, {
      includeCompleted: true,
      connectionId: 'connection-clickup',
      connectionGeneration: 7,
    });
    expect(JSON.stringify(result)).not.toMatch(/vendorPayload|must-not-cross-the-service-boundary/);
  });

  it('returns a safe unsupported result for a connected provider without My Work', async () => {
    storage.getIntegrationConnection.mockResolvedValue({
      id: 'connection-jira',
      provider: 'jira',
      generation: 2,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    });
    storage.getIntegrationConnectionCredentials.mockResolvedValue({
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'secret-token',
    });

    const result = await service.getMyWork('jira', { includeCompleted: false });

    expect(result).toEqual({
      provider: 'jira',
      descriptor: jiraDescriptor,
      supported: false,
      reason: 'unsupported',
    });
    expect(JSON.stringify(result)).not.toMatch(/token|email|siteUrl|credential/i);
    expect(discover).not.toHaveBeenCalled();
  });

  it('retries connection context reads when replacement changes the generation mid-read', async () => {
    const connection = (generation: number) => ({
      id: 'connection-clickup',
      provider: 'clickup' as const,
      generation,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    });
    storage.getIntegrationConnection
      .mockResolvedValueOnce(connection(1))
      .mockResolvedValueOnce(connection(2))
      .mockResolvedValue(connection(2));
    storage.getIntegrationConnectionCredentials.mockResolvedValue({
      provider: 'clickup',
      token: 'replacement-token',
    });
    discover.mockResolvedValue(snapshot);

    await service.getMyWork('clickup', { includeCompleted: false });

    expect(discover).toHaveBeenCalledWith(
      { provider: 'clickup', token: 'replacement-token' },
      {
        includeCompleted: false,
        connectionId: 'connection-clickup',
        connectionGeneration: 2,
      },
    );
  });

  it('fails safely when connection replacement never stabilizes', async () => {
    const connection = (generation: number) => ({
      id: 'connection-clickup',
      provider: 'clickup' as const,
      generation,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    });
    storage.getIntegrationConnection
      .mockResolvedValueOnce(connection(1))
      .mockResolvedValueOnce(connection(2))
      .mockResolvedValueOnce(connection(2))
      .mockResolvedValueOnce(connection(3))
      .mockResolvedValueOnce(connection(3))
      .mockResolvedValueOnce(connection(4));
    storage.getIntegrationConnectionCredentials.mockResolvedValue({
      provider: 'clickup',
      token: 'replacement-token',
    });

    await expect(
      service.getMyWork('clickup', { includeCompleted: false }),
    ).rejects.toMatchObject<BusyError>({
      code: 'busy',
      details: { provider: 'clickup', reason: 'connection_changed' },
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('rejects disconnected providers before capability dispatch', async () => {
    storage.getIntegrationConnection.mockResolvedValue(null);
    storage.getIntegrationConnectionCredentials.mockResolvedValue(null);

    await expect(
      service.getMyWork('clickup', { includeCompleted: false }),
    ).rejects.toMatchObject<ValidationError>({
      code: 'validation_error',
      details: { provider: 'clickup', reason: 'not_connected' },
    });
    expect(discover).not.toHaveBeenCalled();
  });
});
