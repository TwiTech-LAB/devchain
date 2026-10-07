import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HostProjectIdSchema } from '../remotes/host/host.dto';
import {
  GitGuardRemoveRequestSchema,
  VmGitGuardRequestSchema,
  type GitGuardRemoveResult,
} from './git-guard.dto';
import { HomeGitGuardService } from './home-git-guard.service';

@ApiTags('Host git guard')
@Controller('api/host/projects/:id/git-guard')
export class HostGitGuardController {
  constructor(private readonly guard: HomeGitGuardService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Guard git on the VM while the PC owns the project' })
  @ApiOkResponse({ description: 'The guard warning, or null when installed' })
  async install(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ warning: string | null }> {
    const projectId = HostProjectIdSchema.parse(id);
    const request = VmGitGuardRequestSchema.parse(body);
    return { warning: await this.guard.install(projectId, request) };
  }

  @Delete()
  @ApiOperation({ summary: 'Remove VM git guard hooks and restore saved user hooks' })
  @ApiOkResponse({ description: 'Guard removal and optional index rebuild outcome' })
  async remove(@Param('id') id: string, @Body() body: unknown): Promise<GitGuardRemoveResult> {
    const projectId = HostProjectIdSchema.parse(id);
    const { refreshIndex } = GitGuardRemoveRequestSchema.parse(body ?? {});
    return this.guard.remove(projectId, { refreshIndex, failOnReadError: true });
  }
}
