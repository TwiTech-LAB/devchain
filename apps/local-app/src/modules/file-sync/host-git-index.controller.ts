import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createLogger } from '../../common/logging/logger';
import { GitService } from '../git/services/git.service';
import { HostProjectIdSchema } from '../remotes/host/host.dto';
import { FileSyncService } from './file-sync.service';
import { hostRoutes } from '../remotes/contract/host-routes';
import type { HostHandlerResponse } from '../remotes/contract/host-routes';

const logger = createLogger('HostGitIndex');

@ApiTags('Host git index')
@Controller('api/host/projects/:id/git-index')
export class HostGitIndexController {
  constructor(
    private readonly files: FileSyncService,
    private readonly git: GitService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Rebuild the VM Git index when mirrored HEAD changed' })
  @ApiOkResponse({ description: 'Mirrored HEAD, whether the index was rebuilt and any warning' })
  async refresh(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.refreshGitIndex, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    const { since } = hostRoutes.refreshGitIndex.body.parse(body);
    const root = await this.files.folderPath(projectId);
    const head = await this.git.mirroredHead(projectId, root);
    if (head === null || head === since) return { head, refreshed: false, warning: null };
    try {
      await this.git.refreshIndexFromHead(projectId, root);
      return { head, refreshed: true, warning: null };
    } catch (error) {
      logger.warn({ error, projectId }, 'VM Git index rebuild failed');
      const reason = error instanceof Error ? error.message : String(error);
      return { head, refreshed: false, warning: `VM Git index rebuild failed: ${reason}` };
    }
  }
}
