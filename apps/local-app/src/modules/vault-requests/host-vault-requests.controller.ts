import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/error-types';
import { hostRoutes } from '../remotes/contract/host-routes';
import type { HostHandlerResponse } from '../remotes/contract/host-routes';
import { HostApiKeyService } from '../remotes/host/host-api-key.service';
import { HostHelperService } from '../remotes/host/host-helper.service';
import { VaultRequestVmAnswerService } from './vault-request-vm-answer.service';

/**
 * Home lists and answers a claimed VM's Vault requests here. Loopback callers on a VM
 * are its agents, so both routes require the host API key from them too. A resolve
 * body may carry a value: errors and logs never echo it.
 */
@ApiTags('host')
@Controller('api/host/vault/requests')
export class HostVaultRequestsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly keys: HostApiKeyService,
    private readonly answers: VaultRequestVmAnswerService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a claimed VM's pending Vault requests (metadata only)" })
  @ApiResponse({ status: 200 })
  list(
    @Req() request: FastifyRequest,
  ): HostHandlerResponse<typeof hostRoutes.listVaultRequests, 200> {
    this.admit(request);
    return { requests: this.answers.listPending() };
  }

  @Post(':id/resolve')
  @HttpCode(204)
  @ApiOperation({ summary: "End a claimed VM's Vault request with home's answer" })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 409,
    description: 'Not pending, the value has not reached the VM, or the session has stopped',
  })
  async resolve(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    this.admit(request);
    const parsed = hostRoutes.resolveVaultRequest.body.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Vault request answer');
    await this.answers.resolve(id, parsed.data);
  }

  private admit(request: FastifyRequest): void {
    const refusal = this.keys.allows(request.raw, 'http', true);
    if (refusal) throw new AppError(refusal.message, refusal.code, refusal.statusCode);
    this.helper.assertClaimedHost();
  }
}
