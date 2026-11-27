import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  HostExternalTaskImportSchema,
  type hostRoutes,
  type HostHandlerResponse,
} from '../contract/host-routes';
import {
  HostChangesQuerySchema,
  HostIdempotencyKeySchema,
  HostImportQuerySchema,
  HostProjectIdSchema,
  HostReplicaQuerySchema,
} from './host.dto';
import { HostService } from './host.service';

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
  ): Promise<HostHandlerResponse<typeof hostRoutes.importProject, 201>> {
    const { mode } = HostImportQuerySchema.parse(query);
    logger.info({ mode: mode ?? 'new' }, 'POST /api/host/projects/import');
    return this.host.importProject(body, { resnapshot: mode === 'resnapshot' });
  }

  @Get(':id/replica')
  exportReplica(
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.exportReplica, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    const { scope } = HostReplicaQuerySchema.parse(query);
    logger.info({ projectId, scope }, 'GET /api/host/projects/:id/replica');
    return this.host.exportReplica(projectId, scope);
  }

  @Get(':id/changes')
  changes(
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.changes, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    const parsed = HostChangesQuerySchema.parse(query);
    logger.debug({ projectId, since: parsed.since, full: parsed.full }, 'GET changes');
    return this.host.changes(projectId, parsed);
  }

  @Post(':id/freeze')
  @HttpCode(200)
  freeze(@Param('id') id: string): Promise<HostHandlerResponse<typeof hostRoutes.freeze, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/freeze');
    return this.host.freezeProject(projectId);
  }

  @Post(':id/thaw')
  @HttpCode(204)
  async thaw(@Param('id') id: string): Promise<HostHandlerResponse<typeof hostRoutes.thaw, 204>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/thaw');
    await this.host.thawProject(projectId);
  }

  @Post(':id/stop-sessions')
  @HttpCode(204)
  async stopSessions(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.stopSessions, 204>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/stop-sessions');
    await this.host.stopProjectSessions(projectId);
  }

  /** Settles the project's agent time; called after its sessions were stopped. */
  @Post(':id/settle-time')
  @HttpCode(200)
  settleTime(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.settleTime, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/settle-time');
    return this.host.settleProjectTime(projectId);
  }

  @Post(':id/release')
  @HttpCode(204)
  async release(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.release, 204>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/release');
    await this.host.releaseProject(projectId);
  }

  @Get(':id/epics/by-idempotency-key/:key')
  findEpicByIdempotencyKey(
    @Param('id') id: string,
    @Param('key') key: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.findEpicByIdempotencyKey, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    return this.host.findEpicByIdempotencyKey(projectId, HostIdempotencyKeySchema.parse(key));
  }

  @Post(':id/external-tasks/import')
  @HttpCode(200)
  importExternalTask(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.importExternalTask, 200>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info({ projectId }, 'POST /api/host/projects/:id/external-tasks/import');
    return this.host.importExternalTask(projectId, HostExternalTaskImportSchema.parse(body));
  }

  @Delete(':id/epics/:epicId/external-links/:linkId')
  @HttpCode(204)
  async unlinkExternalTask(
    @Param('id') id: string,
    @Param('epicId') epicId: string,
    @Param('linkId') linkId: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.unlinkExternalTask, 204>> {
    const projectId = HostProjectIdSchema.parse(id);
    logger.info(
      { projectId, epicId, linkId },
      'DELETE /api/host/projects/:id/epics/:epicId/external-links/:linkId',
    );
    await this.host.unlinkExternalTask(projectId, epicId, linkId);
  }
}
