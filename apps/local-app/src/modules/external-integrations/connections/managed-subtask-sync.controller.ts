import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { INTEGRATION_PROVIDER_IDS } from '../../storage/models/domain.models';
import { parseOrThrow } from '../request-validation';
import {
  ManagedSubtaskSyncHealthService,
  type ManagedSubtaskSyncHealth,
} from '../subscribers/managed-subtask-sync-health.service';

const providerSchema = z.enum(INTEGRATION_PROVIDER_IDS);
const idSchema = z.string().uuid();
const emptyBodySchema = z.object({}).strict();

@Controller('api/integrations/connections')
@UseGuards(IntegrationAdmissionGuard)
export class ManagedSubtaskSyncController {
  constructor(private readonly sync: ManagedSubtaskSyncHealthService) {}

  @Get(':provider/sync-health')
  getHealth(@Param('provider') provider: string): Promise<ManagedSubtaskSyncHealth> {
    return this.sync.getHealth(parseOrThrow(providerSchema, provider, 'Invalid provider.'));
  }

  @Post(':provider/managed-subtasks/:id/verification')
  verify(@Param('provider') provider: string, @Param('id') id: string, @Body() body: unknown) {
    parseOrThrow(emptyBodySchema, body, 'Verification request must be empty.');
    return this.sync.verify(
      parseOrThrow(providerSchema, provider, 'Invalid provider.'),
      parseOrThrow(idSchema, id, 'Invalid managed subtask id.'),
    );
  }

  @Post(':provider/managed-subtasks/:id/retry')
  retry(@Param('provider') provider: string, @Param('id') id: string, @Body() body: unknown) {
    parseOrThrow(emptyBodySchema, body, 'Retry request must be empty.');
    return this.sync.retry(
      parseOrThrow(providerSchema, provider, 'Invalid provider.'),
      parseOrThrow(idSchema, id, 'Invalid managed subtask id.'),
    );
  }
}
