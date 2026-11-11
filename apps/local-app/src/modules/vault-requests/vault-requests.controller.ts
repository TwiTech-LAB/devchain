import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { HostVaultUseDecisionSchema } from '@devchain/shared';
import { z } from 'zod';
import { ValidationError } from '../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../common/guards/integration-admission.guard';
import { createLogger } from '../../common/logging/logger';
import { VAULT_FILE_MAX_BYTES } from '../vault/vault-entry-rules';
import {
  VaultRequestFulfillService,
  type VaultRequestApproveResult,
  type VaultRequestFulfillResult,
  type VaultRequestView,
} from './vault-request-fulfill.service';

const logger = createLogger('VaultRequestsController');

const FulfillSchema = z
  .object({ value: z.string().max(VAULT_FILE_MAX_BYTES).optional(), permanent: z.boolean() })
  .strict();
const ApproveSchema = z.object({ decision: HostVaultUseDecisionSchema }).strict();
const DenySchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

/** Parse errors never echo the body: a fulfill body holds a value. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('The request body is not valid.', {
      code: 'VAULT_REQUEST_BODY_INVALID',
    });
  }
  return parsed.data;
}

/** Home-only answers to agent requests. Logs name routes and ids, never bodies. */
@UseGuards(IntegrationAdmissionGuard)
@Controller('api/vault/requests')
export class VaultRequestsController {
  constructor(private readonly requests: VaultRequestFulfillService) {}

  @Get()
  list(): Promise<VaultRequestView[]> {
    return this.requests.listPending();
  }

  @Post(':id/fulfill')
  @HttpCode(200)
  fulfill(@Param('id') id: string, @Body() body: unknown): Promise<VaultRequestFulfillResult> {
    logger.info({ requestId: id }, 'POST /api/vault/requests/:id/fulfill');
    return this.requests.fulfill(id, parse(FulfillSchema, body));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown): Promise<VaultRequestApproveResult> {
    logger.info({ requestId: id }, 'POST /api/vault/requests/:id/approve');
    return this.requests.approve(id, parse(ApproveSchema, body).decision);
  }

  @Post(':id/deny')
  @HttpCode(204)
  async deny(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    logger.info({ requestId: id }, 'POST /api/vault/requests/:id/deny');
    await this.requests.deny(id, parse(DenySchema, body ?? {}).reason);
  }
}
