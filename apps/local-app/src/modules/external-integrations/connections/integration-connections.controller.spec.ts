import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { IntegrationConnectionsController } from './integration-connections.controller';
import type { IntegrationConnectionsService } from './integration-connections.service';

describe('IntegrationConnectionsController', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const connectionId = '22222222-2222-4222-8222-222222222222';
  const service = {
    listDirectory: jest.fn(),
    listConnections: jest.fn(),
    replaceConnection: jest.fn(),
    assignLegacyConnection: jest.fn(),
    disconnectConnection: jest.fn(),
    disconnectLegacyConnection: jest.fn(),
    updateSyncSettings: jest.fn(),
  };
  const controller = new IntegrationConnectionsController(
    service as unknown as IntegrationConnectionsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies integration admission to the complete controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IntegrationConnectionsController)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it('requires a UUID projectId for every ordinary connection route', async () => {
    expect(() => controller.listConnections()).toThrow(ValidationError);
    await expect(
      controller.replaceConnection({ provider: 'clickup', token: 'token' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.disconnectConnection('clickup', { projectId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.updateSyncSettings('clickup', { subtaskSyncEnabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(service.listConnections).not.toHaveBeenCalled();
    expect(service.replaceConnection).not.toHaveBeenCalled();
    expect(service.disconnectConnection).not.toHaveBeenCalled();
    expect(service.updateSyncSettings).not.toHaveBeenCalled();
  });

  it('requires Jira site and email together', async () => {
    await expect(
      controller.replaceConnection({
        projectId,
        provider: 'jira',
        token: 'token',
        siteUrl: 'https://acme.atlassian.net',
      }),
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { field: 'email' },
    });
  });

  it('PATCH accepts only the boolean sync setting and no credentials', async () => {
    service.updateSyncSettings.mockResolvedValue({ provider: 'jira' });

    await controller.updateSyncSettings('jira', { projectId, subtaskSyncEnabled: false });

    expect(service.updateSyncSettings).toHaveBeenCalledWith(projectId, 'jira', {
      subtaskSyncEnabled: false,
    });
    await expect(
      controller.updateSyncSettings('jira', {
        projectId,
        subtaskSyncEnabled: true,
        token: 'must-not-be-accepted',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['current', 'legacy'] as const)(
    'requires explicit orphan acknowledgement for %s connections',
    async (kind) => {
      const disconnect =
        kind === 'current' ? service.disconnectConnection : service.disconnectLegacyConnection;
      disconnect.mockResolvedValue({ provider: 'jira', connected: false });
      const invoke = (acknowledgeOrphanRisk: string) =>
        kind === 'current'
          ? controller.disconnectConnection('jira', { projectId, acknowledgeOrphanRisk })
          : controller.disconnectLegacyConnection(connectionId, { acknowledgeOrphanRisk });
      await invoke('true');
      expect(disconnect.mock.calls[0]).toEqual(
        kind === 'current' ? [projectId, 'jira', true] : [connectionId, true],
      );
      await expect(invoke('false')).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it('assigns one exact legacy connection with a strict credential-free body', async () => {
    service.assignLegacyConnection.mockResolvedValue({
      provider: 'jira',
      connectionId,
      connected: true,
    });

    await controller.assignLegacyConnection(connectionId, { projectId });

    expect(service.assignLegacyConnection).toHaveBeenCalledWith(connectionId, projectId);
    await expect(
      controller.assignLegacyConnection(connectionId, { projectId, token: 'forbidden' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.assignLegacyConnection('not-a-uuid', { projectId }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.replaceConnection).not.toHaveBeenCalled();
  });
});
