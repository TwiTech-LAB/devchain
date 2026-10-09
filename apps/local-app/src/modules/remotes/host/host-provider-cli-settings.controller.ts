import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { HostHelperService } from './host-helper.service';
import { HostProviderCliSettingsService } from './host-provider-cli-settings.service';
import { providerCliPolicyRevision } from './host-provider-cli-policy';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

@Controller('api/host/provider-clis')
export class HostProviderCliSettingsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly service: HostProviderCliSettingsService,
  ) {}

  @Get('status')
  status(): HostHandlerResponse<typeof hostRoutes.getProviderCliSettingsStatus, 200> {
    this.helper.assertClaimedHost();
    return this.service.status();
  }

  @Put()
  @HttpCode(202)
  accept(
    @Body() body: unknown,
  ): HostHandlerResponse<typeof hostRoutes.putProviderCliSettings, 202> {
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putProviderCliSettings.body.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.revision !== providerCliPolicyRevision(parsed.data.providers)
    )
      throw new BadRequestException('Invalid host provider CLI policy');
    this.service.accept(parsed.data);
    return { revision: parsed.data.revision };
  }

  @Post('check')
  @HttpCode(202)
  check(): HostHandlerResponse<typeof hostRoutes.checkProviderClis, 202> {
    this.helper.assertClaimedHost();
    this.service.checkNow();
    return { accepted: true };
  }
}
