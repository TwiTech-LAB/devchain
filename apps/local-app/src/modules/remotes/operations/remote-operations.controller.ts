import { UpdateHostSchema } from './remote-operation.dto';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import type { RemoteOperation } from '../../storage/models/domain.models';
import {
  UpdateLoginsSchema,
  AttachProjectSchema,
  ClaimRemoteSchema,
  DetachProjectSchema,
  RetryRemoteOperationSchema,
  ListRemoteOperationsQuerySchema,
  RemoteOperationIdSchema,
} from './remote-operation.dto';
import { RemoteOperationsService } from './remote-operations.service';

const logger = createLogger('RemoteOperationsController');

const RemoteIdSchema = z.string().uuid();

/**
 * Connect, disconnect, claim and host update run in the background; progress
 * arrives on `remote-operations`.
 */
@Controller('api/remotes')
export class RemoteOperationsController {
  constructor(private readonly operations: RemoteOperationsService) {}

  /** Claims an unclaimed host VM, by its address or as an existing remote. */
  @Post('claim')
  @HttpCode(202)
  claim(@Body() body: unknown): Promise<RemoteOperation> {
    const data = ClaimRemoteSchema.parse(body);
    logger.info(
      { remoteId: data.remoteId, providers: Object.keys(data.providerAuth) },
      'POST /api/remotes/claim',
    );
    return this.operations.claim(data);
  }

  @Post(':id/update')
  @HttpCode(202)
  updateHost(@Param('id') id: string, @Body() body?: unknown): Promise<RemoteOperation> {
    const remoteId = RemoteIdSchema.parse(id);
    logger.info({ remoteId }, 'POST /api/remotes/:id/update');
    return this.operations.updateHost(remoteId, UpdateHostSchema.parse(body ?? {}).installDocker);
  }

  @Post(':id/logins')
  @HttpCode(202)
  updateLogins(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    return this.operations.updateLogins(RemoteIdSchema.parse(id), UpdateLoginsSchema.parse(body));
  }

  @Post(':id/attach')
  @HttpCode(202)
  attach(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    const remoteId = RemoteIdSchema.parse(id);
    const { projectId, docker } = AttachProjectSchema.parse(body);
    logger.info(
      { remoteId, projectId, dockerItems: docker?.items.length ?? 0 },
      'POST /api/remotes/:id/attach',
    );
    return this.operations.attach(remoteId, projectId, docker);
  }

  @Post(':id/detach')
  @HttpCode(202)
  detach(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    const remoteId = RemoteIdSchema.parse(id);
    const { projectId, force, dockerCopyBack } = DetachProjectSchema.parse(body);
    logger.info(
      { remoteId, projectId, force, dockerCopyBack: dockerCopyBack !== undefined },
      'POST /api/remotes/:id/detach',
    );
    return this.operations.detach(remoteId, projectId, force, dockerCopyBack);
  }

  @Get('operations')
  async list(@Query() query: unknown): Promise<{ items: RemoteOperation[] }> {
    const filter = ListRemoteOperationsQuerySchema.parse(query);
    return { items: await this.operations.list(filter) };
  }

  @Get('operations/:operationId')
  get(@Param('operationId') operationId: string): Promise<RemoteOperation> {
    return this.operations.get(RemoteOperationIdSchema.parse(operationId));
  }

  @Post('operations/:operationId/retry')
  @HttpCode(202)
  retry(
    @Param('operationId') operationId: string,
    @Body() body: unknown,
  ): Promise<RemoteOperation> {
    const id = RemoteOperationIdSchema.parse(operationId);
    const { providerAuth, ssh } = RetryRemoteOperationSchema.parse(body ?? {});
    logger.info({ operationId: id }, 'POST /api/remotes/operations/:id/retry');
    return this.operations.retry(id, providerAuth, ssh);
  }

  @Post('operations/:operationId/cancel')
  @HttpCode(200)
  cancel(@Param('operationId') operationId: string): Promise<RemoteOperation> {
    const id = RemoteOperationIdSchema.parse(operationId);
    logger.info({ operationId: id }, 'POST /api/remotes/operations/:id/cancel');
    return this.operations.cancel(id);
  }
}
