import { PROVIDER_CLI_NAMES } from '@devchain/shared';
import { ProviderCliInstallStateService } from '../../providers/services/provider-cli-install-state.service';
import { readDockerRuntime } from './docker-runtime';
import { Controller, Get, Inject } from '@nestjs/common';
import { homedir } from 'node:os';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { getAppVersion } from '../../../common/app-version';
import { getIntegrationAdmission } from '../../../common/config/integration-admission';
import { getEnvConfig } from '../../../common/config/env.config';
import { PROCESS_BOOT_ID } from '../../../common/process-identity';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import {
  readHostEnvOverrideReport,
  type HostEnvOverrideReportStorage,
} from '../../remotes/host/host-env-override-report';
import { readBuildInfo } from './build-info';
import { readHostCliVersions } from './host-cli-versions';
import { readHostUserIdentity } from './host-user-identity';
import type { HostRuntimeResponse } from '../../remotes/contract/host-routes';

@ApiTags('runtime')
@Controller('api/runtime')
export class RuntimeController {
  constructor(
    private readonly syncthing: SyncthingManager,
    private readonly providerClis: ProviderCliInstallStateService,
    // Read-CRUD exception (development-standards.md): the override report is a
    // read-only join of provider, provider-config and project rows.
    @Inject(STORAGE_SERVICE) private readonly storage: HostEnvOverrideReportStorage,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get app runtime metadata' })
  @ApiResponse({ status: 200, description: 'Runtime metadata' })
  async getRuntime(): Promise<HostRuntimeResponse> {
    const env = getEnvConfig();
    const runtimeToken =
      typeof env.RUNTIME_TOKEN === 'string' && env.RUNTIME_TOKEN.trim().length > 0
        ? env.RUNTIME_TOKEN.trim()
        : undefined;
    // Independent reads: the Docker probe and the database-backed override report.
    const [docker, providerEnvOverrides] = await Promise.all([
      readDockerRuntime(),
      readHostEnvOverrideReport(this.storage),
    ]);

    return {
      version: getAppVersion(),
      // Claimed VMs must report the same home as this PC; read from the
      // running process, never from claim.json.
      homePath: homedir(),
      // Actual ids come from the process; the record describes the claim's request.
      uid: process.getuid?.() ?? null,
      gid: process.getgid?.() ?? null,
      ...readHostUserIdentity(),
      bootId: PROCESS_BOOT_ID,
      features: {
        cloudUi: env.DEVCHAIN_CLOUD_UI_ENABLED,
      },
      integrationAdmission: getIntegrationAdmission(env),
      fileSync: this.syncthing.getState(),
      cliVersions: readHostCliVersions(),
      providerClis: Object.fromEntries(
        PROVIDER_CLI_NAMES.map((provider) => [provider, this.providerClis.getStatus(provider)]),
      ),
      docker,
      build: readBuildInfo(),
      // Keys stored in this instance that shadow the applied host.env logins;
      // names only, never values.
      providerEnvOverrides,
      ...(runtimeToken ? { runtimeToken } : {}),
    };
  }
}
