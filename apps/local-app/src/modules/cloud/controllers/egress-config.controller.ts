import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ProjectEgressConfigService } from '../services/project-egress-config.service';

@Controller('api/cloud/egress')
export class EgressConfigController {
  constructor(private readonly configService: ProjectEgressConfigService) {}

  @Get('projects')
  getAll(): Record<string, boolean> {
    return this.configService.getAll();
  }

  @Get('projects/:projectId')
  getProject(@Param('projectId') projectId: string): { enabled: boolean } {
    return { enabled: this.configService.isEnabled(projectId) };
  }

  @Put('projects/:projectId')
  @HttpCode(HttpStatus.OK)
  setProject(@Param('projectId') projectId: string, @Body() body: unknown): { enabled: boolean } {
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as Record<string, unknown>).enabled !== 'boolean'
    ) {
      throw new BadRequestException('Body must contain { enabled: boolean }');
    }

    const enabled = (body as { enabled: boolean }).enabled;
    this.configService.setEnabled(projectId, enabled);
    return { enabled };
  }
}
