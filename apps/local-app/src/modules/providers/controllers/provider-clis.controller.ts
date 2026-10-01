import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ProviderCliNameSchema, ProviderCliVersionEntrySchema } from '@devchain/shared';
import { ProviderCliVersionsService } from '../services/provider-cli-versions.service';

const logger = createLogger('ProviderClisController');

/**
 * Provider CLI version management. The UI always edits home's setting for
 * these routes (HOME_ALWAYS_PREFIXES), so a remote project being open never
 * redirects a pin to a VM.
 */
@Controller('api/provider-clis')
export class ProviderClisController {
  constructor(private readonly cliVersions: ProviderCliVersionsService) {}

  @Get()
  getOverview() {
    logger.info('GET /api/provider-clis');
    return this.cliVersions.getOverview();
  }

  @Put(':provider')
  async setVersion(@Param('provider') provider: string, @Body() body: unknown) {
    const parsedProvider = ProviderCliNameSchema.parse(provider);
    const parsedBody = ProviderCliVersionEntrySchema.parse(body);
    logger.info({ provider: parsedProvider }, 'PUT /api/provider-clis/:provider');
    const setting = await this.cliVersions.setVersion(parsedProvider, parsedBody);
    return { provider: parsedProvider, setting };
  }

  @Post('check')
  async check() {
    logger.info('POST /api/provider-clis/check');
    const lookups = await this.cliVersions.checkNow(true);
    return { lookups };
  }
}
