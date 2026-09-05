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

  it('delegates the bounded directory route without project credentials', async () => {
    service.listDirectory.mockResolvedValue({
      items: [],
      unassignedConnections: [],
      truncated: false,
    });

    await expect(controller.listDirectory()).resolves.toEqual({
      items: [],
      unassignedConnections: [],
      truncated: false,
    });

    expect(service.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('passes the validated projectId to the ordinary list', async () => {
    service.listConnections.mockResolvedValue({ items: [] });

    await controller.listConnections(projectId);

    expect(service.listConnections).toHaveBeenCalledWith(projectId);
  });

  it('rejects unknown PUT fields with a field-specific validation error', async () => {
    await expect(
      controller.replaceConnection({
        projectId,
        provider: 'clickup',
        token: 'token',
        leaked: 'unexpected',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.replaceConnection).not.toHaveBeenCalled();
  });

  it('requires Jira site and email together', async () => {
    await expect(
      controller.replaceConnection({
        projectId,
        provider: 'jira',
        token: 'token',
        siteUrl: 'https://acme.atlassian.net',
      }),
    ).rejects.toMatchObject<ValidationError>({
      details: { field: 'email' },
    });
  });

  it('validates the DELETE provider path', async () => {
    await expect(
      controller.disconnectConnection('github', { projectId }),
    ).rejects.toMatchObject<ValidationError>({ details: { field: 'provider' } });
    expect(service.disconnectConnection).not.toHaveBeenCalled();
  });

  it('accepts the optional sync toggle during connection PUT', async () => {
    service.replaceConnection.mockResolvedValue({ provider: 'clickup' });

    await controller.replaceConnection({
      projectId,
      provider: 'clickup',
      token: 'token',
      subtaskSyncEnabled: true,
    });

    expect(service.replaceConnection).toHaveBeenCalledWith({
      projectId,
      provider: 'clickup',
      token: 'token',
      subtaskSyncEnabled: true,
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

  it('requires an explicit true orphan-risk acknowledgement on DELETE', async () => {
    service.disconnectConnection.mockResolvedValue({ provider: 'jira' });

    await controller.disconnectConnection('jira', {
      projectId,
      acknowledgeOrphanRisk: 'true',
    });

    expect(service.disconnectConnection).toHaveBeenCalledWith(projectId, 'jira', true);
    await expect(
      controller.disconnectConnection('jira', {
        projectId,
        acknowledgeOrphanRisk: 'false',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

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

  it('disconnects one exact legacy connection with explicit orphan acknowledgement', async () => {
    service.disconnectLegacyConnection.mockResolvedValue({
      provider: 'jira',
      connected: false,
    });

    await controller.disconnectLegacyConnection(connectionId, {
      acknowledgeOrphanRisk: 'true',
    });

    expect(service.disconnectLegacyConnection).toHaveBeenCalledWith(connectionId, true);
    await expect(
      controller.disconnectLegacyConnection(connectionId, { acknowledgeOrphanRisk: 'false' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
