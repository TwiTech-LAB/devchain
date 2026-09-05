import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  Project,
  ProjectWorkspace,
} from '../../storage/models/domain.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import { ExternalEditSessionStore } from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { IntegrationConnectionsService } from './integration-connections.service';
import type { EventsService } from '../../events/services/events.service';

function connection(
  provider: 'clickup' | 'jira',
  generation = 1,
  projectId = 'project-1',
): IntegrationConnection {
  return {
    id: `${projectId}-${provider}-connection`,
    projectId,
    provider,
    legacySourceConnectionId: null,
    generation,
    subtaskSyncEnabled: false,
    syncSettingRevision: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function unassignedConnection(provider: 'clickup' | 'jira' = 'jira'): IntegrationConnection {
  return {
    ...connection(provider),
    id: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    legacySourceConnectionId: null,
    subtaskSyncEnabled: true,
  };
}

const project: Project = {
  id: 'project-1',
  workspaceId: 'workspace-1',
  name: 'Project One',
  description: 'private project description',
  rootPath: '/private/project-one',
  isTemplate: false,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

const workspace: ProjectWorkspace = {
  id: 'workspace-1',
  name: 'Workspace One',
  isDefault: true,
  position: 0,
  projectCount: 1,
  deviceGrantCount: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

describe('IntegrationConnectionsService', () => {
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'listIntegrationConnections'
      | 'getProject'
      | 'listProjects'
      | 'listProjectWorkspaces'
      | 'getIntegrationConnection'
      | 'getIntegrationConnectionById'
      | 'assignUnassignedIntegrationConnection'
      | 'replaceIntegrationConnection'
      | 'getIntegrationConnectionCredentials'
      | 'disconnectIntegrationConnection'
      | 'disconnectUnassignedIntegrationConnection'
      | 'updateIntegrationConnectionSyncSetting'
    >
  >;
  let clickupProvider: jest.Mocked<ExternalTaskProvider>;
  let jiraProvider: jest.Mocked<ExternalTaskProvider>;
  let service: IntegrationConnectionsService;

  beforeEach(() => {
    storage = {
      listIntegrationConnections: jest.fn().mockResolvedValue([]),
      getProject: jest.fn().mockResolvedValue(project),
      listProjects: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      listProjectWorkspaces: jest.fn().mockResolvedValue([]),
      getIntegrationConnection: jest.fn().mockResolvedValue(null),
      getIntegrationConnectionById: jest.fn().mockResolvedValue(null),
      assignUnassignedIntegrationConnection: jest.fn(),
      replaceIntegrationConnection: jest.fn(),
      getIntegrationConnectionCredentials: jest.fn(),
      disconnectIntegrationConnection: jest.fn(),
      disconnectUnassignedIntegrationConnection: jest.fn(),
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

    const result = await service.listConnections(project.id);

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
          connectionId: 'project-1-jira-connection',
          generation: 3,
          subtaskSyncEnabled: false,
          syncSettingRevision: 1,
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/token|email|credential|ciphertext/i);
    expect(storage.listIntegrationConnections).toHaveBeenCalledWith(project.id);
  });

  it('returns a bounded directory containing only safe project/workspace connection fields', async () => {
    storage.listProjects.mockResolvedValue({
      items: [project],
      total: 101,
      limit: 100,
      offset: 0,
    });
    storage.listProjectWorkspaces.mockResolvedValue([workspace]);
    storage.listIntegrationConnections.mockResolvedValue([
      {
        ...connection('jira', 3),
        legacySourceConnectionId: 'legacy-jira',
        subtaskSyncEnabled: true,
      },
      {
        ...connection('clickup'),
        id: 'unassigned-clickup',
        projectId: null,
      },
    ]);

    const result = await service.listDirectory();

    expect(result).toEqual({
      items: [
        {
          project: { id: project.id, name: project.name },
          workspace: { id: workspace.id, name: workspace.name },
          provider: 'clickup',
          configured: false,
          updatedAt: null,
          subtaskSyncEnabled: false,
          hasMigratedSharedOrigin: false,
        },
        {
          project: { id: project.id, name: project.name },
          workspace: { id: workspace.id, name: workspace.name },
          provider: 'jira',
          configured: true,
          updatedAt: '2026-08-19T00:00:00.000Z',
          subtaskSyncEnabled: true,
          hasMigratedSharedOrigin: true,
        },
      ],
      unassignedConnections: [
        {
          provider: 'clickup',
          connected: true,
          connectionId: 'unassigned-clickup',
          generation: 1,
          subtaskSyncEnabled: false,
          syncSettingRevision: 1,
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
      truncated: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /token|email|credential|ciphertext|rootPath|description|deviceGrantCount|legacySourceConnectionId/i,
    );
    expect(storage.listProjects).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it('rejects an unknown project before connection or credential access', async () => {
    storage.getProject.mockRejectedValue(new NotFoundError('Project', 'missing-project'));

    await expect(
      service.replaceConnection({
        projectId: 'missing-project',
        provider: 'jira',
        token: 'new-token',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(storage.getIntegrationConnection).not.toHaveBeenCalled();
    expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
    expect(storage.replaceIntegrationConnection).not.toHaveBeenCalled();
  });

  it('rejects a mismatched connection row before credential access', async () => {
    storage.getIntegrationConnection.mockResolvedValue(connection('jira', 1, 'project-2'));

    await expect(
      service.replaceConnection({
        projectId: project.id,
        provider: 'jira',
        token: 'new-token',
      }),
    ).rejects.toMatchObject<ValidationError>({
      details: { projectId: project.id, provider: 'jira' },
    });

    expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
    expect(storage.replaceIntegrationConnection).not.toHaveBeenCalled();
  });

  it('rotates the same provider independently for two projects', async () => {
    const projectTwo = { ...project, id: 'project-2', name: 'Project Two' };
    const rows = new Map([
      [project.id, connection('clickup', 1, project.id)],
      [projectTwo.id, connection('clickup', 7, projectTwo.id)],
    ]);
    storage.getProject.mockImplementation(async (projectId) =>
      projectId === project.id ? project : projectTwo,
    );
    storage.getIntegrationConnection.mockImplementation(async (identity) => {
      if (typeof identity === 'string' || 'connectionId' in identity) return null;
      return rows.get(identity.projectId) ?? null;
    });
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify) => {
      await verify(data.credentials);
      const previous = rows.get(data.projectId!);
      const updated = {
        ...previous!,
        generation: previous!.generation + 1,
        updatedAt: `updated-${data.projectId}`,
      };
      rows.set(data.projectId!, updated);
      return updated;
    });

    await Promise.all([
      service.replaceConnection({
        projectId: project.id,
        provider: 'clickup',
        token: 'project-one-token',
      }),
      service.replaceConnection({
        projectId: projectTwo.id,
        provider: 'clickup',
        token: 'project-two-token',
      }),
    ]);

    expect(rows.get(project.id)?.generation).toBe(2);
    expect(rows.get(projectTwo.id)?.generation).toBe(8);
    expect(storage.replaceIntegrationConnection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: project.id, provider: 'clickup' }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(storage.replaceIntegrationConnection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ projectId: projectTwo.id, provider: 'clickup' }),
      expect.any(Function),
      expect.any(Function),
    );
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
      service.replaceConnection({
        projectId: project.id,
        provider: 'clickup',
        token: 'test-clickup-token',
      }),
    ).resolves.toEqual({
      provider: 'clickup',
      connected: true,
      connectionId: 'project-1-clickup-connection',
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
      service.replaceConnection({
        projectId: project.id,
        provider: 'clickup',
        token: 'invalid-token',
      }),
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
    storage.getIntegrationConnection.mockResolvedValue(connection('jira'));
    jiraProvider.verifyCredentials.mockResolvedValue({
      provider: 'jira',
      remoteId: 'account-1',
      displayName: 'Grace',
    });
    storage.replaceIntegrationConnection.mockImplementation(async (data, verify) => {
      await verify(data.credentials);
      return connection('jira', 2);
    });

    await service.replaceConnection({
      projectId: project.id,
      provider: 'jira',
      token: 'new-token',
    });

    expect(storage.replaceIntegrationConnection).toHaveBeenCalledWith(
      {
        projectId: project.id,
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
    storage.getIntegrationConnection.mockResolvedValue(null);

    await expect(
      service.replaceConnection({
        projectId: project.id,
        provider: 'jira',
        token: 'new-token',
      }),
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

    await service.replaceConnection({
      projectId: project.id,
      provider: 'clickup',
      token: 'token',
    });

    expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
      'integration.connection.created',
      expect.objectContaining({
        connectionId: 'project-1-clickup-connection',
        projectId: 'project-1',
        provider: 'clickup',
        generation: 1,
      }),
    );
    expect(eventsService.emitCommitted).toHaveBeenCalledWith(prepared);
  });

  it('disconnects only the live credential so linked snapshots remain storage-owned', async () => {
    storage.getIntegrationConnection.mockResolvedValue(connection('jira'));
    storage.disconnectIntegrationConnection.mockResolvedValue(true);

    await expect(service.disconnectConnection(project.id, 'jira')).resolves.toEqual({
      provider: 'jira',
      connected: false,
      connectionId: null,
      generation: null,
      subtaskSyncEnabled: false,
      syncSettingRevision: null,
      updatedAt: null,
    });
    expect(storage.disconnectIntegrationConnection).toHaveBeenCalledWith(
      { projectId: project.id, provider: 'jira' },
      expect.any(Function),
      { acknowledgeOrphanRisk: false },
    );
    expect(Object.keys(storage)).toEqual([
      'listIntegrationConnections',
      'getProject',
      'listProjects',
      'listProjectWorkspaces',
      'getIntegrationConnection',
      'getIntegrationConnectionById',
      'assignUnassignedIntegrationConnection',
      'replaceIntegrationConnection',
      'getIntegrationConnectionCredentials',
      'disconnectIntegrationConnection',
      'disconnectUnassignedIntegrationConnection',
      'updateIntegrationConnectionSyncSetting',
    ]);
  });

  it('assigns one exact unassigned row without reading or replacing credentials', async () => {
    const legacy = unassignedConnection('jira');
    const assigned = {
      ...legacy,
      projectId: project.id,
      legacySourceConnectionId: legacy.id,
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const prepared = {
      id: 'legacy-assignment-event',
      name: 'integration.connection.updated',
      payload: {},
      requestId: null,
      publishedAt: '2026-08-25T00:00:00.000Z',
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
    storage.getIntegrationConnectionById.mockResolvedValue(legacy);
    storage.assignUnassignedIntegrationConnection.mockImplementation(
      async (_connectionId, _projectId, eventFactory) => {
        eventFactory?.(assigned, legacy);
        return assigned;
      },
    );

    await expect(service.assignLegacyConnection(legacy.id, project.id)).resolves.toEqual({
      provider: 'jira',
      connected: true,
      connectionId: legacy.id,
      generation: 1,
      subtaskSyncEnabled: true,
      syncSettingRevision: 1,
      updatedAt: '2026-08-25T00:00:00.000Z',
    });

    expect(storage.assignUnassignedIntegrationConnection).toHaveBeenCalledWith(
      legacy.id,
      project.id,
      expect.any(Function),
    );
    expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
    expect(storage.replaceIntegrationConnection).not.toHaveBeenCalled();
    expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
      'integration.connection.updated',
      expect.objectContaining({
        connectionId: legacy.id,
        projectId: project.id,
        provider: 'jira',
        generation: legacy.generation,
      }),
    );
    expect(eventsService.emitCommitted).toHaveBeenCalledWith(prepared);
  });

  it('rejects legacy assignment for ordinary rows and occupied project/provider slots', async () => {
    const legacy = unassignedConnection('clickup');
    storage.getIntegrationConnectionById.mockResolvedValue({
      ...legacy,
      projectId: project.id,
    });

    await expect(service.assignLegacyConnection(legacy.id, project.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(storage.assignUnassignedIntegrationConnection).not.toHaveBeenCalled();

    storage.getIntegrationConnectionById.mockResolvedValue(legacy);
    storage.getIntegrationConnection.mockResolvedValue(connection('clickup'));
    await expect(service.assignLegacyConnection(legacy.id, project.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(storage.assignUnassignedIntegrationConnection).not.toHaveBeenCalled();
  });

  it('rejects a missing assignment target before loading the legacy connection', async () => {
    storage.getProject.mockRejectedValue(new NotFoundError('Project', 'missing-project'));

    await expect(
      service.assignLegacyConnection('11111111-1111-4111-8111-111111111111', 'missing-project'),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(storage.getIntegrationConnectionById).not.toHaveBeenCalled();
    expect(storage.assignUnassignedIntegrationConnection).not.toHaveBeenCalled();
  });

  it('disconnects only an exact unassigned row with orphan acknowledgement', async () => {
    const legacy = unassignedConnection('jira');
    storage.getIntegrationConnectionById.mockResolvedValue(legacy);
    storage.disconnectUnassignedIntegrationConnection.mockResolvedValue(true);

    await expect(service.disconnectLegacyConnection(legacy.id, true)).resolves.toEqual({
      provider: 'jira',
      connected: false,
      connectionId: null,
      generation: null,
      subtaskSyncEnabled: false,
      syncSettingRevision: null,
      updatedAt: null,
    });
    expect(storage.disconnectUnassignedIntegrationConnection).toHaveBeenCalledWith(
      legacy.id,
      undefined,
      { acknowledgeOrphanRisk: true },
    );

    storage.getIntegrationConnectionById.mockResolvedValue({
      ...legacy,
      projectId: project.id,
    });
    await expect(service.disconnectLegacyConnection(legacy.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
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
    storage.getIntegrationConnection.mockResolvedValue(before);

    await expect(
      service.updateSyncSettings(project.id, 'jira', { subtaskSyncEnabled: true }),
    ).resolves.toMatchObject({
      subtaskSyncEnabled: true,
      syncSettingRevision: 2,
    });

    expect(storage.updateIntegrationConnectionSyncSetting).toHaveBeenCalledWith(
      { projectId: project.id, provider: 'jira' },
      true,
      expect.any(Function),
    );
    expect(eventsService.prepareCommitted).toHaveBeenCalledWith(
      'integration.connection.updated',
      expect.objectContaining({
        projectId: 'project-1',
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
