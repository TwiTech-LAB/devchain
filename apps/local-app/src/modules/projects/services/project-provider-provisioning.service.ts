import { Injectable, Inject } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProjectProviderProvisioning');

export type ProvisioningWarning = {
  providerId: string;
  providerName: string;
  level: 'warn' | 'error';
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};

@Injectable()
export class ProjectProviderProvisioningService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
  ) {}

  async provisionProject(projectId: string): Promise<{ warnings: ProvisioningWarning[] }> {
    const warnings: ProvisioningWarning[] = [];

    try {
      const project = await this.storage.getProject(projectId);
      if (!project?.rootPath) {
        return { warnings: [] };
      }

      const profileResult = await this.storage.listAgentProfiles({ projectId });
      const providerIds = new Set<string>();

      for (const profile of profileResult.items) {
        const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);
        configs.forEach((c) => providerIds.add(c.providerId));
      }

      for (const providerId of providerIds) {
        try {
          const provider = await this.storage.getProvider(providerId);
          if (!provider) continue;

          const result = await this.mcpEnsureService.ensureMcp(provider, project.rootPath);
          if (!result.success) {
            warnings.push({
              providerId,
              providerName: provider.name,
              level: 'error',
              message: result.message ?? 'MCP ensure failed',
              code: result.warnings?.[0]?.code,
            });
          }
          for (const w of result.warnings ?? []) {
            warnings.push({
              providerId,
              providerName: provider.name,
              level: w.level === 'info' ? 'warn' : w.level,
              message: w.message,
              code: w.code,
            });
          }
        } catch (error) {
          warnings.push({
            providerId,
            providerName: '',
            level: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (outer) {
      logger.error({ error: outer, projectId }, 'Project provisioning failed');
      warnings.push({
        providerId: '',
        providerName: '',
        level: 'error',
        message: outer instanceof Error ? outer.message : String(outer),
      });
    }

    return { warnings };
  }
}
