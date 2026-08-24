import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { IntegrationConnectionsController } from './integration-connections.controller';
import type { IntegrationConnectionsService } from './integration-connections.service';

describe('IntegrationConnectionsController', () => {
  const service = {
    listConnections: jest.fn(),
    replaceConnection: jest.fn(),
    disconnectConnection: jest.fn(),
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

  it('rejects unknown PUT fields with a field-specific validation error', async () => {
    await expect(
      controller.replaceConnection({
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
        provider: 'jira',
        token: 'token',
        siteUrl: 'https://acme.atlassian.net',
      }),
    ).rejects.toMatchObject<ValidationError>({
      details: { field: 'email' },
    });
  });

  it('validates the DELETE provider path', async () => {
    await expect(controller.disconnectConnection('github')).rejects.toMatchObject<ValidationError>({
      details: { field: 'provider' },
    });
    expect(service.disconnectConnection).not.toHaveBeenCalled();
  });

  it('accepts the optional sync toggle during connection PUT', async () => {
    service.replaceConnection.mockResolvedValue({ provider: 'clickup' });

    await controller.replaceConnection({
      provider: 'clickup',
      token: 'token',
      subtaskSyncEnabled: true,
    });

    expect(service.replaceConnection).toHaveBeenCalledWith({
      provider: 'clickup',
      token: 'token',
      subtaskSyncEnabled: true,
    });
  });

  it('PATCH accepts only the boolean sync setting and no credentials', async () => {
    service.updateSyncSettings.mockResolvedValue({ provider: 'jira' });

    await controller.updateSyncSettings('jira', { subtaskSyncEnabled: false });

    expect(service.updateSyncSettings).toHaveBeenCalledWith('jira', {
      subtaskSyncEnabled: false,
    });
    await expect(
      controller.updateSyncSettings('jira', {
        subtaskSyncEnabled: true,
        token: 'must-not-be-accepted',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires an explicit true orphan-risk acknowledgement on DELETE', async () => {
    service.disconnectConnection.mockResolvedValue({ provider: 'jira' });

    await controller.disconnectConnection('jira', 'true');

    expect(service.disconnectConnection).toHaveBeenCalledWith('jira', true);
    await expect(controller.disconnectConnection('jira', 'false')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
