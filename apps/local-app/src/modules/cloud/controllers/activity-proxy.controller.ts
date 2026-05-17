import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ProjectActivityReporterService } from '../services/project-activity-reporter.service';

@Controller('api/cloud/activity')
export class ActivityProxyController {
  constructor(private readonly activityReporter: ProjectActivityReporterService) {}

  @Post('projects/:projectId/touch')
  @HttpCode(HttpStatus.NO_CONTENT)
  async touchProject(@Param('projectId') projectId: string) {
    return this.activityReporter.touchProject(projectId, { respectThrottle: false });
  }
}
