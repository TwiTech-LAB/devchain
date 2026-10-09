import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HostSkillSourceNameSchema, HostSkillContentHashSchema } from '@devchain/shared';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { HostHelperService } from './host-helper.service';
import { HostSkillSettingsService } from './host-skill-settings.service';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

@ApiTags('host')
@Controller('api/host/skill-settings')
export class HostSkillSettingsController {
  constructor(
    private readonly helper: HostHelperService,
    private readonly skills: HostSkillSettingsService,
  ) {}

  @Put()
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue home skill settings on a claimed host' })
  @ApiResponse({ status: 202 })
  accept(@Body() body: unknown): HostHandlerResponse<typeof hostRoutes.putSkillSettings, 202> {
    this.helper.assertClaimedHost();
    const parsed = hostRoutes.putSkillSettings.body.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid host skill settings');
    this.skills.accept(parsed.data);
    return { revision: parsed.data.revision };
  }

  @Get('status')
  @ApiOperation({ summary: 'Read applied and pending skill revisions and missing local content' })
  @ApiResponse({ status: 200 })
  status(): Promise<HostHandlerResponse<typeof hostRoutes.getSkillSettingsStatus, 200>> {
    this.helper.assertClaimedHost();
    return this.skills.status();
  }

  @Put('local-sources/:name/content')
  @HttpCode(200)
  @ApiConsumes('application/x-tar')
  @ApiOperation({ summary: 'Replace a home local source managed copy' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409 })
  @ApiResponse({ status: 413 })
  upload(
    @Param('name') name: string,
    @Query('contentHash') contentHash: string,
    @Req() request: FastifyRequest,
  ): Promise<HostHandlerResponse<typeof hostRoutes.uploadSkillSourceContent, 200>> {
    this.helper.assertClaimedHost();
    const parsedName = HostSkillSourceNameSchema.safeParse(name);
    const parsedHash = HostSkillContentHashSchema.safeParse(contentHash);
    if (!parsedName.success || !parsedHash.success || !(request.body instanceof Readable))
      throw new BadRequestException('A source name, content hash and tar stream are required');
    return this.skills.upload(parsedName.data, parsedHash.data, request.body);
  }
}
