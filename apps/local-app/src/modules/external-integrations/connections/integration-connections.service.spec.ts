import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
} from '../../storage/models/domain.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import { ExternalEditSessionStore } from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { IntegrationConnectionsService } from './integration-connections.service';
import type { EventsService } from '../../events/services/events.service';

function connection(provider: 'clickup' | 'jira', generation = 1): IntegrationConnection {
  return {
    id: `${provider}-connection`,
    provider,
    generation,
    subtaskSyncEnabled: false,
    syncSettingRevision: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

describe('IntegrationConnectionsService', () => {
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'listIntegrationConnections'
      | 'replaceIntegrationConnection'
      | 'getIntegrationConnectionCredentials'
      | 'disconnectIntegrationConnection'
      | 'updateIntegrationConnectionSyncSetting'
    >
  >;
  let clickupProvider: jest.Mocked<ExternalTaskProvider>;
  let jiraProvider: jest.Mocked<ExternalTaskProvider>;
  let service: IntegrationConnectionsService;

  beforeEach(() => {
    storage = {
      listIntegrationConnections: jest.fn(),
      replaceIntegrationConnection: jest.fn(),
      getIntegrationConnectionCredentials: jest.fn(),
      disconnectIntegrationConnection: jest.fn(),
      updateIntegrationConnectionSyncSetting: jest.fn(),
    };
    clickupProvider = {
      provider: 'clickup',
      descriptor: {
        provider: 'clickup',
        displayName: 'ClickUp',
        capabilities: { myWork: false },
      },
      verifyCredentials: jest.fn(),
    };
    jiraProvider = {
      provider: 'jira',
      descriptor: {
        provider: 'jira',
        displayName: 'Jira',
        capabilities: { myWork: false },
      },
      verifyCredentials: jest.fn(),
    };
    service = new IntegrationConnectionsService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickupProvider, jiraProvider]),
      new ProviderOperationGate(),
      new ExternalEditSessionStore(),
    );
  });

  it('always returns safe ClickUp and Jira states without credential fields', async () => {
    storage.listIntegrationConnections.mockResolvedValue([connection('jira', 3)]);

    const result = await service.listConnections();

    expect(result).toEqual({
      items: [
        {
          provider: 'clickup',
          connected: false,
          connectionId: null,
          generation: null,
          subtaskSyncEnabled: false,
          syncSettingRevision: null,
          updatedAt: null,
        },
        {
          provider: 'jira',
          connected: true,
          connectionId: 'jira-connection',
          generation: 3,
          subtaskSyncEnabled: false,
          syncSettingRevision: 1,
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/token|email|credential|ciphertext/i);
  });

  it('verifies ClickUp credentials through the provider callback before storage mutation', async () => {
    const events: string[] = [];
    clickupProvider.verifyCredentials.mockImplementation(async () => {
      events.push('provider-verified');
      return { provider: 'clickup', remoteId: '42', displayName: 'Ada' };
    });
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify) => {
      await verify(data.credentials);
      events.push('storage-mutated');
      return connection('clickup');
    });

    await expect(
      service.replaceConnection({ provider: 'clickup', token: 'test-clickup-token' }),
    ).resolves.toEqual({
      provider: 'clickup',
      connected: true,
      connectionId: 'clickup-connection',
      generation: 1,
      subtaskSyncEnabled: false,
      syncSettingRevision: 1,
      updatedAt: '2026-08-19T00:00:00.000Z',
    });
    expect(events).toEqual(['provider-verified', 'storage-mutated']);
  });

  it('keeps the previous credential unchanged when provider validation fails', async () => {
    const events: string[] = [];
    clickupProvider.verifyCredentials.mockRejectedValue(new Error('validation failed'));
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify) => {
      await verify(data.credentials);
      events.push('storage-mutated');
      return connection('clickup');
    });

    await expect(
      service.replaceConnection({ provider: 'clickup', token: 'invalid-token' }),
    ).rejects.toThrow('validation failed');
    expect(events).toEqual([]);
  });

  it('reuses encrypted Jira site and email for token-only replacement', async () => {
    const existing: IntegrationCredentials = {
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'old-token',
    };
    storage.getIntegrationConnectionCredentials.mockResolvedValue(existing);
    jiraProvider.verifyCredentials.mockResolvedValue({
      provider: 'jira',
      remoteId: 'account-1',
      displayName: 'Grace',
    });
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify) => {
      await verify(data.credentials);
      return connection('jira', 2);
    });

    await service.replaceConnection({ provider: 'jira', token: 'new-token' });

    expect(storage.replaceIntegrationConnection).toHaveBeenCalledWith(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'private@example.com',
          token: 'new-token',
        },
      },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('requires field-specific Jira identity fields for an initial connection', async () => {
    storage.getIntegrationConnectionCredentials.mockResolvedValue(null);

    await expect(
      service.replaceConnection({ provider: 'jira', token: 'new-token' }),
    ).rejects.toMatchObject<ValidationError>({
      details: { field: 'siteUrl' },
    });
    expect(storage.replaceIntegrationConnection).not.toHaveBeenCalled();
  });

  it('prepares and emits the committed connection fact through the storage transaction hook', async () => {
    const prepared = {
      id: 'connection-event',
      name: 'integration.connection.created',
      payload: {},
      requestId: null,
      publishedAt: '2026-08-23T00:00:00.000Z',
    };
    const eventsService = {
      prepareCommitted: jest.fn().mockReturnValue(prepared),
      emitCommitted: jest.fn(),
    };
    service = new IntegrationConnectionsService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickupProvider, jiraProvider]),
      new ProviderOperationGate(),
      new ExternalEditSessionStore(),
      eventsService as unknown as EventsService,
    );
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify, eventFactory) => {
      await verify(data.credentials);
      const created = connection('clickup');
      eventFactory?.(created, null);
      return created;
    });

    await service.replaceConnection({ provider: 'clickup', token: 'token' });

    expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
      'integration.connection.created',
      expect.objectContaining({
        connectionId: 'clickup-connection',
        provider: 'clickup',
        generation: 1,
      }),
    );
    expect(eventsService.emitCommitted).toHaveBeenCalledWith(prepared);
  });

  it('disconnects only the live credential so linked snapshots remain storage-owned', async () => {
    storage.disconnectIntegrationConnection.mockResolvedValue(true);

    await expect(service.disconnectConnection('jira')).resolves.toEqual({
      provider: 'jira',
      connected: false,
      connectionId: null,
      generation: null,
      subtaskSyncEnabled: false,
      syncSettingRevision: null,
      updatedAt: null,
    });
    expect(storage.disconnectIntegrationConnection).toHaveBeenCalledWith(
      'jira',
      expect.any(Function),
      { acknowledgeOrphanRisk: false },
    );
    expect(Object.keys(storage)).toEqual([
      'listIntegrationConnections',
      'replaceIntegrationConnection',
      'getIntegrationConnectionCredentials',
      'disconnectIntegrationConnection',
      'updateIntegrationConnectionSyncSetting',
    ]);
  });

  it('updates only sync settings and emits the committed factual transition', async () => {
    const before = connection('jira');
    const after = { ...before, subtaskSyncEnabled: true, syncSettingRevision: 2 };
    const prepared = {
      id: 'settings-event',
      name: 'integration.connection.updated',
      payload: {},
      requestId: null,
      publishedAt: '2026-08-23T00:00:00.000Z',
    };
    const eventsService = {
      prepareCommitted: jest.fn().mockReturnValue(prepared),
      emitCommitted: jest.fn(),
    };
    service = new IntegrationConnectionsService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([clickupProvider, jiraProvider]),
      new ProviderOperationGate(),
      new ExternalEditSessionStore(),
      eventsService as unknown as EventsService,
    );
    storage.updateIntegrationConnectionSyncSetting.mockImplementation(
      async (_provider, _enabled, eventFactory) => {
        eventFactory?.(after, before);
        return after;
      },
    );

    await expect(
      service.updateSyncSettings('jira', { subtaskSyncEnabled: true }),
    ).resolves.toMatchObject({
      subtaskSyncEnabled: true,
      syncSettingRevision: 2,
    });

    expect(storage.updateIntegrationConnectionSyncSetting).toHaveBeenCalledWith(
      'jira',
      true,
      expect.any(Function),
    );
    expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
      'integration.connection.updated',
      expect.objectContaining({
        previousSubtaskSyncEnabled: false,
        subtaskSyncEnabled: true,
        previousSyncSettingRevision: 1,
        syncSettingRevision: 2,
      }),
    );
    expect(eventsService.emitCommitted).toHaveBeenCalledWith(prepared);
    expect(jiraProvider.verifyCredentials).not.toHaveBeenCalled();
  });
});
