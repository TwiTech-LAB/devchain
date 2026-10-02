import { ValidationError } from '../../../../common/errors/error-types';
import type { PreflightResult, PreflightService } from '../../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../../providers/services/provider-mcp-ensure.service';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { Provider } from '../../../storage/models/domain.models';
import type { ProjectProvisioningContext } from '../../../providers/adapters';

export interface McpReadinessInput {
  storage: StorageService;
  preflightService: PreflightService;
  mcpEnsureService: ProviderMcpEnsureService;
  provider: Provider;
  projectId: string;
  projectRootPath: string;
  configEnv: Record<string, string> | null;
}

export interface McpReadiness {
  preflightResult: PreflightResult;
  provisioningContext: ProjectProvisioningContext;
}

/**
 * Shared MCP drift repair for the launch and restore pipelines. A session
 * whose provider lost its `devchain` MCP registration must re-register before
 * the provider command runs, or the agent starts without DevChain tools. The
 * repair is the FULL `ensureMcp`, which also runs project settings and trust
 * provisioning — callers that must not provision trust (restore) accept that
 * write only as part of this repair.
 *
 * The returned preflight result is the pre-repair run: an `overall: 'fail'`
 * from it still blocks the caller even when the MCP repair itself succeeded.
 */
export async function ensureMcpReadiness({
  storage,
  preflightService,
  mcpEnsureService,
  provider,
  projectId,
  projectRootPath,
  configEnv,
}: McpReadinessInput): Promise<McpReadiness> {
  const providerEnv = storage.getProviderEnvForProject(provider.id, projectId);
  const provisioningContext = {
    env: { ...(providerEnv ?? {}), ...(configEnv ?? {}) },
  };

  const preflightResult = await preflightService.runChecks(projectRootPath);
  let providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);

  if (providerCheck?.mcpStatus && providerCheck.mcpStatus !== 'pass') {
    await mcpEnsureService.ensureMcp(provider, projectRootPath, provisioningContext);
    const recheck = await preflightService.runChecks(projectRootPath);
    providerCheck = recheck.providers?.find((p) => p.id === provider.id);

    if (providerCheck?.mcpStatus !== 'pass') {
      throw new ValidationError('MCP configuration failed after auto-ensure', {
        providerId: provider.id,
        mcpStatus: providerCheck?.mcpStatus,
        mcpMessage: providerCheck?.mcpMessage,
      });
    }
  }

  return { preflightResult, provisioningContext };
}
