import { BadRequestException, Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { HostHelperService } from './host-helper.service';
import { HostProviderSettingsService } from './host-provider-settings.service';
import { providerSettingsRevision } from './host-provider-settings-revision';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

/** The body carries provider env values: never log it or echo it in an error. */
@Controller('api/host/provider-settings')
export class HostProviderSettingsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly service: HostProviderSettingsService,
  ) {}

  @Get('status')
  status(): HostHandlerResponse<typeof hostRoutes.getProviderSettingsStatus, 200> {
    this.helper.assertClaimedHost();
    return this.service.status();
  }

  @Put()
  @HttpCode(202)
  async accept(
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.putProviderSettings, 202>> {
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putProviderSettings.body.safeParse(body);
    if (!parsed.success || parsed.data.revision !== providerSettingsRevision(parsed.data.providers))
      throw new BadRequestException('Invalid host provider settings');
    await this.service.accept(parsed.data.revision, parsed.data.providers);
    return { revision: parsed.data.revision };
  }
}
