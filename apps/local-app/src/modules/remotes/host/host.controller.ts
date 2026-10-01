import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  ProjectReplicaChanges,
  ProjectReplicaImportResult,
  ProjectReplicaOfScope,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type { FrozenProject } from '../../storage/interfaces/storage.interface';
import {
  HostChangesQuerySchema,
  HostIdempotencyKeySchema,
  HostImportQuerySchema,
  HostProjectIdSchema,
  HostReplicaQuerySchema,
} from './host.dto';
import { HostService } from './host.service';
import type { ProjectTimeSettlement } from '../time/project-time-settler.service';

const logger = createLogger('HostController');

/**
 * Routes a home instance calls on the instance that hosts its project. Served
 * by every instance. Never log request or response bodies: replicas carry secrets.
 */
@Controller('api/host/projects')
export class HostController {
  constructor(private readonly host: HostService) {}

  @Post('import')
  importProject(
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ProjectReplicaImportResult> {
    const { mode } = HostImportQuerySchema.parse(query);
    logger.info({ mode: mode ?? 'new' }, 'POST /api/host/projects/import');
    return this.host.importProject(body, { resnapshot: mode === 'resnapshot' });
  }

  @Get(':id/replica')
  exportReplica(
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<ProjectReplicaOfScope<'attach' | 'detach'>> {
    const projectId = HostProjectIdSchema.parse(id);
    const { scope } = HostReplicaQuerySchema.parse(query);
    logger.info({ projectId, scope }, 'GET /api/host/projects/:id/replica');
    return this.host.exportReplica(projectId, scope);
  }

  @Get(':id/changes')
  changes(@Param('id') id: string, @Query() query: unknown): Promise<ProjectReplicaChanges> {
    const projectId = HostProjectIdSchema.parse(id);
    const parsed = HostChangesQuerySchema.parse(query);
    logger.debug({ projectId, since: parsed.since, full: parsed.full }, 'GET changes');
    return this.host.changes(projectId, parsed);
  }

  @Post(':id/freeze')
  @HttpCode(200)
  freeze(@Param('id') id: string): Promise<FrozenProject> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/freeze');
    return this.host.freezeProject(projectId);
  }

  @Post(':id/thaw')
  @HttpCode(204)
  async thaw(@Param('id') id: string): Promise<void> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/thaw');
    await this.host.thawProject(projectId);
  }

  @Post(':id/stop-sessions')
  @HttpCode(204)
  async stopSessions(@Param('id') id: string): Promise<void> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/stop-sessions');
    await this.host.stopProjectSessions(projectId);
  }

  /** Settles the project's agent time; called after its sessions were stopped. */
  @Post(':id/settle-time')
  @HttpCode(200)
  settleTime(@Param('id') id: string): Promise<ProjectTimeSettlement> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/settle-time');
    return this.host.settleProjectTime(projectId);
  }

  @Post(':id/release')
  @HttpCode(204)
  async release(@Param('id') id: string): Promise<void> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/release');
    await this.host.releaseProject(projectId);
  }

  @Get(':id/epics/by-idempotency-key/:key')
  findEpicByIdempotencyKey(
    @Param('id') id: string,
    @Param('key') key: string,
  ): Promise<{ epicId: string }> {
    const projectId = HostProjectIdSchema.parse(id);
    return this.host.findEpicByIdempotencyKey(projectId, HostIdempotencyKeySchema.parse(key));
  }
}
