import { BadRequestException, Body, Controller, HttpCode, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors/error-types';
import { VaultVmCacheService } from '../../vault/vault-vm-cache.service';
import { HostApiKeyService } from './host-api-key.service';
import { HostHelperService } from './host-helper.service';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

/**
 * The body carries Vault values: errors and logs never echo it. Only home may push, so
 * the host API key is required from loopback callers too.
 */
@ApiTags('host')
@Controller('api/host/vault')
export class HostVaultController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly keys: HostApiKeyService,
    private readonly cache: VaultVmCacheService,
  ) {}

  @Put()
  @HttpCode(200)
  @ApiOperation({ summary: "Replace a claimed VM's Vault snapshot and value cache" })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'No tmpfs runtime directory, or a project is missing' })
  async accept(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.putVault, 200>> {
    const refusal = this.keys.allows(request.raw, 'http', true);
    if (refusal) throw new AppError(refusal.message, refusal.code, refusal.statusCode);
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putVault.body.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Vault push');
    await this.cache.apply(parsed.data);
    return { revision: parsed.data.revision };
  }
}
