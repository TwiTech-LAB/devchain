import { Controller, Get, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getEnvConfig } from '../../../common/config/env.config';
import { OrchestratorDockerService } from '../../orchestrator/docker/services/docker.service';

function getVersion(): string {
  try {
    const possiblePaths = [
      join(__dirname, '..', '..', '..', '..', '..', 'package.json'),
      join(__dirname, '..', '..', '..', '..', '..', '..', 'package.json'),
      join(process.cwd(), 'package.json'),
    ];

    for (const pkgPath of possiblePaths) {
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === 'devchain-cli' && pkg.version) {
        return pkg.version;
      }
    }
  } catch {
    // Ignore lookup errors.
  }

  return 'unknown';
}

@ApiTags('runtime')
@Controller('api/runtime')
export class RuntimeController {
  private dockerAvailabilityCache: boolean | null = null;
  private dockerAvailabilityPending: Promise<boolean> | null = null;
  private resolvedDockerService?: OrchestratorDockerService | null;

  constructor(
    @Optional() private readonly dockerService?: OrchestratorDockerService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get runtime mode and app version' })
  @ApiResponse({ status: 200, description: 'Runtime metadata' })
  async getRuntime() {
    const env = getEnvConfig();
    const runtimeToken =
      typeof env.RUNTIME_TOKEN === 'string' && env.RUNTIME_TOKEN.trim().length > 0
        ? env.RUNTIME_TOKEN.trim()
        : undefined;

    return {
      mode: env.DEVCHAIN_MODE,
      version: getVersion(),
      dockerAvailable: await this.resolveDockerAvailability(env.DEVCHAIN_MODE),
      ...(runtimeToken ? { runtimeToken } : {}),
    };
  }

  private resolveDockerService(): OrchestratorDockerService | null {
    if (this.dockerService) {
      return this.dockerService;
    }
    if (this.resolvedDockerService !== undefined) {
      return this.resolvedDockerService;
    }
    if (!this.moduleRef) {
      this.resolvedDockerService = null;
      return this.resolvedDockerService;
    }
    try {
      this.resolvedDockerService = this.moduleRef.get(OrchestratorDockerService, {
        strict: false,
      });
      return this.resolvedDockerService;
    } catch {
      this.resolvedDockerService = null;
      return this.resolvedDockerService;
    }
  }

  private async resolveDockerAvailability(mode: string): Promise<boolean> {
    if (mode === 'normal') {
      return false;
    }

    if (this.dockerAvailabilityCache !== null) {
      return this.dockerAvailabilityCache;
    }
    if (this.dockerAvailabilityPending) {
      return this.dockerAvailabilityPending;
    }

    this.dockerAvailabilityPending = (async () => {
      const service = this.resolveDockerService();
      if (!service) {
        return false;
      }

      try {
        return await service.ping();
      } catch {
        return false;
      }
    })();

    const availability = await this.dockerAvailabilityPending;
    this.dockerAvailabilityCache = availability;
    this.dockerAvailabilityPending = null;
    return availability;
  }
}
