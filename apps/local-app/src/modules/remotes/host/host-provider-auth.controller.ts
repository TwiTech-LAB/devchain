import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import {
  HostProviderAuthService,
  type HostProviderApplyResult,
  type HostProviderVerifyResult,
} from './host-provider-auth.service';
import type { ProviderAuthFamilyReport } from '../../provider-auth/provider-auth-watcher.service';

const logger = createLogger('HostProviderAuthController');

const VerifyBodySchema = z
  .object({
    provider: z.string().trim().min(1).max(32),
    opencodeProviderIds: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  })
  .strict();

// A file time in milliseconds, which can have a fraction (`stat.mtimeMs`).
const FamiliesSinceSchema = z.coerce.number().finite().min(0).optional().default(0);

const RemoveSchema = z
  .object({
    envKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
    files: z.array(z.string().min(1).max(4096)).max(32).default([]),
  })
  .strict();

const ApplyBodySchema = z
  .object({
    env: z.record(z.string(), z.string()).default({}),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            mode: z.literal('0600'),
            contentBase64: z.string().max(400_000),
          })
          .strict(),
      )
      .default([]),
    // Processed before the writes above, so a login that is removed and
    // re-sent in one request ends up present with the new value.
    remove: RemoveSchema.optional(),
  })
  .strict();

/**
 * Provider logins of a claimed host, called by home's claim operation. Bodies
 * carry credentials: logs name the route and provider only.
 */
@Controller('api/host/provider-auth')
export class HostProviderAuthController {
  constructor(private readonly providerAuth: HostProviderAuthService) {}

  @Post('verify')
  @HttpCode(200)
  verify(@Body() body: unknown): Promise<HostProviderVerifyResult> {
    const { provider, opencodeProviderIds } = VerifyBodySchema.parse(body);
    logger.info({ provider }, 'POST /api/host/provider-auth/verify');
    return this.providerAuth.verify(provider.toLowerCase(), opencodeProviderIds);
  }

  @Post()
  @HttpCode(200)
  apply(@Body() body: unknown): Promise<HostProviderApplyResult> {
    logger.info('POST /api/host/provider-auth');
    return this.providerAuth.apply(ApplyBodySchema.parse(body));
  }

  /** Home's health-poll pull of changed login files; `since` is the mtime home has. */
  @Get('families')
  families(@Query('since') since?: string): Promise<ProviderAuthFamilyReport[]> {
    const sinceMs = FamiliesSinceSchema.parse(since ?? 0);
    logger.info({ since: sinceMs }, 'GET /api/host/provider-auth/families');
    return this.providerAuth.families(sinceMs);
  }
}
