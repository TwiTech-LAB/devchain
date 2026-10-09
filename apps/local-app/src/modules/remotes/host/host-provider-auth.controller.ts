import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import {
  HostProviderAuthService,
  type HostProviderApplyResult,
} from './host-provider-auth.service';
import type { ProviderAuthFamilyReport } from '../../provider-auth/provider-auth-watcher.service';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

const logger = createLogger('HostProviderAuthController');

// A file time in milliseconds, which can have a fraction (`stat.mtimeMs`).
const FamiliesSinceSchema = z.coerce.number().finite().min(0).optional().default(0);

/**
 * Provider logins of a claimed host, called by home's claim operation. Bodies
 * carry credentials: logs name the route and provider only.
 */
@Controller('api/host/provider-auth')
export class HostProviderAuthController {
  constructor(private readonly providerAuth: HostProviderAuthService) {}

  @Post('verify')
  @HttpCode(200)
  verify(
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.verifyProviderAuth, 200>> {
    const { provider, opencodeProviderIds } = hostRoutes.verifyProviderAuth.body.parse(body);
    logger.info({ provider }, 'POST /api/host/provider-auth/verify');
    return this.providerAuth.verify(provider.toLowerCase(), opencodeProviderIds);
  }

  @Post()
  @HttpCode(200)
  // The client ignores this body (contract status 'none'); add a schema when a caller reads it.
  apply(@Body() body: unknown): Promise<HostProviderApplyResult> {
    logger.info('POST /api/host/provider-auth');
    return this.providerAuth.apply(hostRoutes.applyProviderAuth.body.parse(body));
  }

  /** Home's health-poll pull of changed login files; `since` is the mtime home has. */
  @Get('families')
  families(@Query('since') since?: string): Promise<ProviderAuthFamilyReport[]> {
    const sinceMs = FamiliesSinceSchema.parse(since ?? 0);
    logger.info({ since: sinceMs }, 'GET /api/host/provider-auth/families');
    return this.providerAuth.families(sinceMs);
  }
}
