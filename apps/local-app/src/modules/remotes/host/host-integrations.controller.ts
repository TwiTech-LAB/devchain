import { BadRequestException, Body, Controller, HttpCode, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors/error-types';
import { IntegrationVmCacheService } from '../../external-integrations/vm-cache/integration-vm-cache.service';
import { HostApiKeyService } from './host-api-key.service';
import { HostHelperService } from './host-helper.service';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

/**
 * The body can carry integration credentials: errors and logs never echo it. Only home
 * may push, so the host API key is required from loopback callers too.
 */
@ApiTags('host')
@Controller('api/host/integrations')
export class HostIntegrationsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly keys: HostApiKeyService,
    private readonly cache: IntegrationVmCacheService,
  ) {}

  @Put()
  @HttpCode(200)
  @ApiOperation({ summary: "Replace a claimed VM's integration connections and credential cache" })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'Invalid push, or its revision does not match' })
  async accept(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.putIntegrations, 200>> {
    const refusal = this.keys.allows(request.raw, 'http', true);
    if (refusal) throw new AppError(refusal.message, refusal.code, refusal.statusCode);
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putIntegrations.body.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid integrations push');
    return this.cache.apply(parsed.data);
  }
}
