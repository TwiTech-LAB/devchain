import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { STORAGE_SERVICE, type ProjectStorage } from '../storage/interfaces/storage.interface';
import { projectRepository } from '../file-sync/project-repository';
import type { ConnectChoicesDto } from './connect-choices.dto';
import { ConnectChoicesStore } from './connect-choices.store';

@ApiTags('connect-choices')
@Controller('api/projects/:id/connect-choices')
export class ConnectChoicesController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly choices: ConnectChoicesStore,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the project’s last Connect target and Docker toggle' })
  @ApiResponse({ status: 200, description: 'Remembered VM and Docker toggle, or initial defaults' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async get(@Param('id', ParseUUIDPipe) projectId: string): Promise<ConnectChoicesDto> {
    const project = await this.storage.getProject(projectId);
    const git = (await projectRepository(project.rootPath)) === 'missing' ? 'missing' : 'present';
    const saved = this.choices.get(projectId);
    return saved
      ? { remoteId: saved.remoteId, includeDocker: saved.includeDocker, git }
      : { includeDocker: false, git };
  }
}
