import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import * as semver from 'semver';
import { z } from 'zod';
import { ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  HostHelperService,
  type HostUpdateStatus,
  type HostDockerStatus,
  type ProjectRootResult,
} from './host-helper.service';

const logger = createLogger('HostUpdateController');

const HostUpdateBodySchema = z
  .object({ version: z.string().refine((value) => semver.valid(value) === value) })
  .strict();
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
  async update(@Body() body: unknown): Promise<{ version: string; state: 'pending' }> {
    const { version } = HostUpdateBodySchema.parse(body);
    logger.info({ version }, 'POST /api/host/update');
    await this.helper.requestUpdate(version);
    return { version, state: 'pending' };
  }

  @Get('update')
  @ApiOperation({ summary: 'Progress of the last host update' })
  status(): { status: HostUpdateStatus | null } {
    return { status: this.helper.readUpdateStatus() };
  }

  @Post('docker')
  @HttpCode(202)
  @ApiOperation({ summary: 'Install Docker Engine and Compose in a detached job' })
  @ApiResponse({ status: 202, description: 'Install requested; poll GET /api/host/docker' })
  async docker(@Body() body: unknown): Promise<{ state: 'pending'; jobId: string | null }> {
    z.object({})
      .strict()
      .parse(body ?? {});
    return { state: 'pending', ...(await this.helper.requestDocker()) };
  }

  @Get('docker')
  @ApiOperation({ summary: 'Progress of the Docker install' })
  dockerStatus(): { status: HostDockerStatus | null } {
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
