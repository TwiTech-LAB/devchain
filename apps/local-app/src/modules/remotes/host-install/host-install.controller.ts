import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getAppVersion } from '../../../common/app-version';
import { createLogger } from '../../../common/logging/logger';
import { getEnvConfig } from '../../../common/config/env.config';
import { getIntegrationAdmission } from '../../../common/config/integration-admission';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { MIN_HOST_IMAGE_VERSION } from '../host-image';
import { InstallHostSchema } from '../operations/remote-operation.dto';
import { RemoteOperationsService } from '../operations/remote-operations.service';
import { homeIdentity } from '../home-identity';
import { HostInstallService } from './host-install.service';
import { ProjectSizeService } from './project-size.service';
import { SshKeyService, type AvailableSshKey, type AvailableSshPublicKey } from './ssh-key.service';

const logger = createLogger('HostInstallController');
const GIB = 1024 ** 3;

const EstimateRequestSchema = z
  .object({
    projectIds: z.array(z.string().trim().min(1).max(128)).max(1_000),
  })
  .strict();

const BlockQuerySchema = z
  .object({
    minDiskGib: z.coerce.number().int().min(1).max(1_000_000),
  })
  .strict();

export type HostInstallEstimateProject = {
  id: string;
  name: string;
  rootPath: string;
  bytes: number | null;
  approximate: boolean;
};

@ApiTags('host-install')
@Controller('api/remotes/host-install')
export class HostInstallController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly projectSize: ProjectSizeService,
    private readonly hostInstall: HostInstallService,
    private readonly operations: RemoteOperationsService,
    private readonly sshKeys: SshKeyService,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Install and claim a DevChain host over SSH' })
  @ApiResponse({ status: 202, description: 'The resumable host-install operation' })
  async install(@Body() body: unknown): Promise<RemoteOperation> {
    const operation = await this.operations.installHost(InstallHostSchema.parse(body));
    logger.info(
      { operationId: operation.id, remoteId: operation.remoteId },
      'POST /api/remotes/host-install',
    );
    return operation;
  }

  @Get('ssh-keys')
  @ApiOperation({ summary: "List private SSH keys in the DevChain user's home" })
  @ApiResponse({ status: 200, description: 'SSH key metadata, never private key content' })
  async listSshKeys(): Promise<
    { available: true; keys: AvailableSshKey[] } | { available: false; reason: 'non_loopback_host' }
  > {
    const admission = getIntegrationAdmission();
    if (!admission.allowed) return { available: false, reason: admission.reason };
    return { available: true, keys: await this.sshKeys.list() };
  }

  @Get('ssh-public-keys')
  @ApiOperation({ summary: "List public SSH keys in the DevChain user's home" })
  async listSshPublicKeys(): Promise<
    | { available: true; keys: AvailableSshPublicKey[] }
    | { available: false; reason: 'non_loopback_host' }
  > {
    const admission = getIntegrationAdmission();
    if (!admission.allowed) return { available: false, reason: admission.reason };
    return { available: true, keys: await this.sshKeys.listPublic() };
  }

  @Post('estimate')
  @ApiOperation({ summary: 'Estimate the selected projects for host installation' })
  @ApiResponse({ status: 200, description: 'Project sizes and required host disk' })
  async estimate(@Body() body: unknown): Promise<{
    projects: HostInstallEstimateProject[];
    requiredDiskGib: number;
  }> {
    const { projectIds } = EstimateRequestSchema.parse(body);
    const projects = await Promise.all(
      projectIds.map(async (projectId): Promise<HostInstallEstimateProject> => {
        const project = await this.storage.getProject(projectId);
        const estimate = await this.projectSize.measure(project.id, project.rootPath);
        return {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          bytes: estimate.bytes,
          approximate: estimate.approximate || estimate.bytes === null,
        };
      }),
    );

    const knownBytes = projects.reduce((total, project) => total + (project.bytes ?? 0), 0);
    const requiredDiskGib = Math.ceil(8 + (1.5 * knownBytes) / GIB);
    logger.info(
      { projectIds, knownBytes, requiredDiskGib },
      'Calculated host-install disk estimate',
    );
    return { projects, requiredDiskGib };
  }

  @Get('identity')
  @ApiOperation({ summary: "This PC's OS user name and home path used as install defaults" })
  @ApiResponse({
    status: 200,
    description: 'The default Linux user name and home path; no secrets',
  })
  identity(): { user: string; homePath: string } {
    return homeIdentity();
  }

  @Get('block')
  @ApiOperation({ summary: 'Generate the host-install shell block' })
  @ApiResponse({ status: 200, description: 'One copy-paste host-install shell block' })
  async block(@Query() query: unknown): Promise<{ block: string }> {
    const { minDiskGib } = BlockQuerySchema.parse(query);
    const config = getEnvConfig();
    const identity = homeIdentity();
    const block = await this.hostInstall.render({
      minDiskGib,
      homePort: Number(config.PORT),
      imageVersion: MIN_HOST_IMAGE_VERSION,
      homeUser: identity.user,
      homePath: identity.homePath,
      devchainVersion: getAppVersion(),
    });
    return { block };
  }
}
