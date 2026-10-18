import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { hostRoutes, type HostHandlerResponse } from '../remotes/contract/host-routes';
import { HostProjectIdSchema } from '../remotes/host/host.dto';
import { WorktreeAdmissionService } from './worktree-admission.service';
import { WorktreesService } from './worktrees.service';

@Controller('api/host/projects/:id/worktrees')
export class HostWorktreesController {
  constructor(
    private readonly worktrees: WorktreesService,
    private readonly admission: WorktreeAdmissionService,
  ) {}

  @Get()
  async list(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.worktrees, 200>> {
    return this.worktrees.listOnHost(HostProjectIdSchema.parse(id));
  }

  @Post('admission')
  @HttpCode(200)
  async setAdmission(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.laneAdmission, 200>> {
    const request = hostRoutes.laneAdmission.body.parse(body);
    await this.admission.setFrozen(HostProjectIdSchema.parse(id), request.frozen);
    return request;
  }
}
