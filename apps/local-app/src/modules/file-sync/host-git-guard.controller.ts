import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HostProjectIdSchema } from '../remotes/host/host.dto';
import { HomeGitGuardService } from './home-git-guard.service';
import { GitCoordinatorService } from '../remotes/git-coordinator/git-coordinator.service';
import { hostRoutes } from '../remotes/contract/host-routes';
import type { HostHandlerResponse } from '../remotes/contract/host-routes';

@ApiTags('Host git guard')
@Controller('api/host/projects/:id/git-guard')
export class HostGitGuardController {
  constructor(
    private readonly guard: HomeGitGuardService,
    private readonly coordinator: GitCoordinatorService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Guard git on the VM while the PC owns the project' })
  @ApiOkResponse({ description: 'The guard warning, or null when installed' })
  async install(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.installGitGuard, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    const request = hostRoutes.installGitGuard.body.parse(body);
    return this.coordinator.withHostMutation(projectId, request, async () => ({
      warning: await this.guard.install(projectId, request),
    }));
  }

  @Delete()
  @ApiOperation({ summary: 'Remove VM git guard hooks and restore saved user hooks' })
  @ApiOkResponse({ description: 'Guard removal and optional index rebuild outcome' })
  async remove(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.removeGitGuard, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    const request = hostRoutes.removeGitGuard.body.parse(body);
    return this.coordinator.withHostMutation(projectId, request, () =>
      this.guard.remove(projectId, { refreshIndex: request.refreshIndex, failOnReadError: true }),
    );
  }
}
