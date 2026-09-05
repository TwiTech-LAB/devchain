import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import type { ManagedSubtaskSyncHealthService } from '../subscribers/managed-subtask-sync-health.service';
import { ManagedSubtaskSyncController } from './managed-subtask-sync.controller';

describe('ManagedSubtaskSyncController', () => {
  const sync = {
    getHealth: jest.fn(),
    getLegacyHealth: jest.fn(),
    verify: jest.fn(),
    verifyLegacy: jest.fn(),
    retry: jest.fn(),
    retryLegacy: jest.fn(),
  };
  const controller = new ManagedSubtaskSyncController(
    sync as unknown as ManagedSubtaskSyncHealthService,
  );
  const id = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => jest.clearAllMocks());

  it('applies main-runtime integration admission to health and recovery routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedSubtaskSyncController)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it('validates provider and returns bounded health', async () => {
    sync.getHealth.mockResolvedValue({ provider: 'clickup', items: [] });

    await controller.getHealth('clickup', projectId);

    expect(sync.getHealth).toHaveBeenCalledWith(projectId, 'clickup');
    expect(() => controller.getHealth('github', projectId)).toThrow(ValidationError);
    expect(() => controller.getHealth('clickup', undefined)).toThrow(ValidationError);
  });

  it('keeps Verify and Retry bodies strict and validates UUID identity', async () => {
    sync.verify.mockResolvedValue({ outcome: 'confirmed' });
    sync.retry.mockResolvedValue({ outcome: 'confirmed' });

    await controller.verify('clickup', id, projectId, {});
    await controller.retry('clickup', id, projectId, {});

    expect(sync.verify).toHaveBeenCalledWith(projectId, 'clickup', id);
    expect(sync.retry).toHaveBeenCalledWith(projectId, 'clickup', id);
    expect(() => controller.verify('clickup', id, projectId, { retry: true })).toThrow(
      ValidationError,
    );
    expect(() => controller.retry('clickup', 'not-a-uuid', projectId, {})).toThrow(ValidationError);
    expect(() => controller.retry('clickup', id, 'not-a-uuid', {})).toThrow(ValidationError);
  });

  it('validates exact legacy connection routes and keeps recovery bodies empty', async () => {
    const connectionId = '33333333-3333-4333-8333-333333333333';
    sync.getLegacyHealth.mockResolvedValue({ provider: 'clickup', items: [] });
    sync.verifyLegacy.mockResolvedValue({ outcome: 'confirmed' });
    sync.retryLegacy.mockResolvedValue({ outcome: 'confirmed' });

    await controller.getLegacyHealth(connectionId);
    await controller.verifyLegacy(connectionId, id, {});
    await controller.retryLegacy(connectionId, id, {});

    expect(sync.getLegacyHealth).toHaveBeenCalledWith(connectionId);
    expect(sync.verifyLegacy).toHaveBeenCalledWith(connectionId, id);
    expect(sync.retryLegacy).toHaveBeenCalledWith(connectionId, id);
    expect(() => controller.getLegacyHealth('not-a-uuid')).toThrow(ValidationError);
    expect(() => controller.verifyLegacy(connectionId, id, { retry: true })).toThrow(
      ValidationError,
    );
  });
});
