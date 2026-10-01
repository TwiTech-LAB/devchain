import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { HostProviderCliSettingsSchema } from '@devchain/shared';
import { HostHelperService } from './host-helper.service';
import { HostProviderCliSettingsService } from './host-provider-cli-settings.service';
import { providerCliPolicyRevision } from './host-provider-cli-policy';

@Controller('api/host/provider-clis')
export class HostProviderCliSettingsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly service: HostProviderCliSettingsService,
  ) {}

  @Get('status')
  status() {
    this.helper.assertClaimedHost();
    return this.service.status();
  }

  @Put()
  @HttpCode(202)
  accept(@Body() body: unknown) {
    this.helper.assertClaimedHost();
    const parsed = HostProviderCliSettingsSchema.safeParse(body);
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
  check() {
    this.helper.assertClaimedHost();
    this.service.checkNow();
    return { accepted: true };
  }
}
