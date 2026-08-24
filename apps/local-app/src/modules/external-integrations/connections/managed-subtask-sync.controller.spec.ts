import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import type { ManagedSubtaskSyncHealthService } from '../subscribers/managed-subtask-sync-health.service';
import { ManagedSubtaskSyncController } from './managed-subtask-sync.controller';

describe('ManagedSubtaskSyncController', () => {
  const sync = {
    getHealth: jest.fn(),
    verify: jest.fn(),
    retry: jest.fn(),
  };
  const controller = new ManagedSubtaskSyncController(
    sync as unknown as ManagedSubtaskSyncHealthService,
  );
  const id = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => jest.clearAllMocks());

  it('applies main-runtime integration admission to health and recovery routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedSubtaskSyncController)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it('validates provider and returns bounded health', async () => {
    sync.getHealth.mockResolvedValue({ provider: 'clickup', items: [] });

    await controller.getHealth('clickup');

    expect(sync.getHealth).toHaveBeenCalledWith('clickup');
    expect(() => controller.getHealth('github')).toThrow(ValidationError);
  });

  it('keeps Verify and Retry bodies strict and validates UUID identity', async () => {
    sync.verify.mockResolvedValue({ outcome: 'confirmed' });
    sync.retry.mockResolvedValue({ outcome: 'confirmed' });

    await controller.verify('clickup', id, {});
    await controller.retry('clickup', id, {});

    expect(sync.verify).toHaveBeenCalledWith('clickup', id);
    expect(sync.retry).toHaveBeenCalledWith('clickup', id);
    expect(() => controller.verify('clickup', id, { retry: true })).toThrow(ValidationError);
    expect(() => controller.retry('clickup', 'not-a-uuid', {})).toThrow(ValidationError);
  });
});
