import { BadRequestException, Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { HostHelperService } from './host-helper.service';
import { HostProviderUsageSettingsService } from './host-provider-usage-settings.service';
import { providerUsageSettingsRevision } from './host-provider-usage-revision';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

@Controller('api/host/provider-usage-settings')
export class HostProviderUsageSettingsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly service: HostProviderUsageSettingsService,
  ) {}

  @Get('status')
  status(): HostHandlerResponse<typeof hostRoutes.getProviderUsageSettingsStatus, 200> {
    this.helper.assertClaimedHost();
    return this.service.status();
  }

  @Put()
  @HttpCode(202)
  async accept(
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.putProviderUsageSettings, 202>> {
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putProviderUsageSettings.body.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.revision !== providerUsageSettingsRevision(parsed.data.settings)
    )
      throw new BadRequestException('Invalid host provider usage settings');
    await this.service.accept(parsed.data.settings);
    return { revision: parsed.data.revision };
  }
}
