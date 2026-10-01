import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { IgnoresBodySchema } from './file-sync.dto';
import { FileSyncService, type FolderNeed } from './file-sync.service';

const ProjectIdSchema = z.string().trim().min(1).max(128);

/** This instance's file sync settings and state for one project. */
@Controller('api/file-sync/projects/:projectId')
export class FileSyncController {
  constructor(private readonly fileSync: FileSyncService) {}

  /** What this instance has not yet received per folder; `folders: null` when unknown. */
  @Get('status')
  async status(@Param('projectId') projectId: string): Promise<{ folders: FolderNeed[] | null }> {
    return { folders: await this.fileSync.projectNeed(ProjectIdSchema.parse(projectId)) };
  }

  /** The ignore patterns of the project's shared code folder. */
  @Get('ignores')
  get(@Param('projectId') projectId: string): { ignores: string[] } {
    return { ignores: this.fileSync.getIgnores(ProjectIdSchema.parse(projectId)) };
  }

  @Put('ignores')
  put(@Param('projectId') projectId: string, @Body() body: unknown): { ignores: string[] } {
    const { ignores } = IgnoresBodySchema.parse(body);
    return { ignores: this.fileSync.setIgnores(ProjectIdSchema.parse(projectId), ignores) };
  }
}
