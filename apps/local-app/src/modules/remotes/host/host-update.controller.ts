import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';
import { HostHelperService, type ProjectRootResult } from './host-helper.service';

const logger = createLogger('HostUpdateController');

const ProjectRootBodySchema = z.object({ path: z.string().min(1).max(4096) }).strict();

/**
 * Routes of a claimed host VM (see apps/host-bootstrap): "Update VM" and
 * project roots outside the user's home. Other instances answer 409 NOT_A_HOST.
 * Only the bootstrap service of an unclaimed VM accepts a claim.
 */
@ApiTags('host')
@Controller('api/host')
export class HostUpdateController {
  constructor(private readonly helper: HostHelperService) {}

  @Post('claim')
  @ApiOperation({ summary: 'Refused: DevChain runs here, so the VM is claimed already' })
  @ApiResponse({ status: 409, description: 'ALREADY_CLAIMED or NOT_A_HOST' })
  claim(): never {
    if (this.helper.isClaimedHost()) {
      throw new ConflictError('This VM is already claimed.', { code: 'ALREADY_CLAIMED' });
    }
    throw new ConflictError('This DevChain instance is not a host VM.', { code: 'NOT_A_HOST' });
  }

  @Post('update')
  @HttpCode(202)
  @ApiOperation({ summary: 'Install another DevChain version on this host VM and restart' })
  @ApiResponse({ status: 202, description: 'Update started; poll GET /api/host/update' })
  // The client ignores this body (contract status 'none'); add a schema when a caller reads it.
  async update(@Body() body: unknown): Promise<{ version: string; state: 'pending' }> {
    const { version } = hostRoutes.requestHostUpdate.body.parse(body);
    logger.info({ version }, 'POST /api/host/update');
    await this.helper.requestUpdate(version);
    return { version, state: 'pending' };
  }

  @Get('update')
  @ApiOperation({ summary: 'Progress of the last host update' })
  status(): HostHandlerResponse<typeof hostRoutes.hostUpdateStatus, 200> {
    return { status: this.helper.readUpdateStatus() };
  }

  @Post('docker')
  @HttpCode(202)
  @ApiOperation({ summary: 'Install Docker Engine and Compose in a detached job' })
  @ApiResponse({ status: 202, description: 'Install requested; poll GET /api/host/docker' })
  async docker(
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.requestDocker, 202>> {
    hostRoutes.requestDocker.body.parse(body ?? {});
    // A variable, not a literal: `state` is not in the contract body (excess-property check).
    const response = { state: 'pending', ...(await this.helper.requestDocker()) };
    return response;
  }

  @Get('docker')
  @ApiOperation({ summary: 'Progress of the Docker install' })
  dockerStatus(): HostHandlerResponse<typeof hostRoutes.dockerStatus, 200> {
    return { status: this.helper.readDockerStatus() };
  }

  @Post('projects/roots')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a project root outside the home, owned by the host user' })
  async createProjectRoot(@Body() body: unknown): Promise<ProjectRootResult> {
    const { path } = ProjectRootBodySchema.parse(body);
    logger.info({ path }, 'POST /api/host/projects/roots');
    return this.helper.createProjectRoot(path);
  }
}
