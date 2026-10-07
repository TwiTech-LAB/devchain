import { GUARDS_METADATA } from '@nestjs/common/constants';

import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';

import { ManagedSubtaskSyncController } from './managed-subtask-sync.controller';

describe('ManagedSubtaskSyncController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies main-runtime integration admission to health and recovery routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedSubtaskSyncController)).toContain(
      IntegrationAdmissionGuard,
    );
  });
});
