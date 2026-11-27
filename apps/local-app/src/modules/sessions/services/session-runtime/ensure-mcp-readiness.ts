import { ValidationError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import {
  isPreflightSkipped,
  type PreflightResult,
  type PreflightService,
  type ProviderCheck,
} from '../../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../../providers/services/provider-mcp-ensure.service';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { Provider } from '../../../storage/models/domain.models';
import type { ProjectProvisioningContext } from '../../../providers/adapters';
import {
  assertLaunchEnvAccepted,
  type LaunchEnvRules,
} from '../../../providers/utils/launch-env-rules';

const logger = createLogger('McpReadiness');

export interface McpReadinessInput {
  storage: Pick<StorageService, 'getProviderEnvForProject'>;
  preflightService: PreflightService;
  mcpEnsureService: ProviderMcpEnsureService;
  /** The provider adapter's launch rules for the session environment. */
  launchRules: LaunchEnvRules;
  provider: Provider;
  projectId: string;
  projectRootPath: string;
  configEnv: Record<string, string> | null;
  /**
   * Refuses when preflight returns no check for the provider, outside the SKIP_PREFLIGHT bypass.
   * Without it, a missing check passes with a warning.
   */
  requireProviderCheck?: boolean;
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
 * A provider whose binary check fails is refused before the repair, so no
 * provider write runs for a destination that cannot start, and again after the
 * recheck, so a binary lost during the repair never reaches a stop. A binary
 * that is only not resolvable on PATH (`warn`) passes.
 *
 * The returned preflight result is the pre-repair run: an `overall: 'fail'`
 * from it still blocks the caller even when the MCP repair itself succeeded.
 */
export async function ensureMcpReadiness({
  storage,
  preflightService,
  mcpEnsureService,
  launchRules,
  provider,
  projectId,
  projectRootPath,
  configEnv,
  requireProviderCheck = false,
}: McpReadinessInput): Promise<McpReadiness> {
  const providerEnv = storage.getProviderEnvForProject(provider.id, projectId);
  const provisioningContext = {
    env: { ...(providerEnv ?? {}), ...(configEnv ?? {}) },
  };
  // Launch refuses this environment, so no check or repair may run in it.
  assertLaunchEnvAccepted(launchRules, provisioningContext.env);

  // Named explicitly: by default preflight checks only the providers that project agents use now,
  // and a restore can switch the agent to a provider that none of them uses. The check, the repair
  // and the recheck all use the session's environment: a config can point the provider at its own
  // home (for example CODEX_HOME), with its own MCP registrations. The recheck reads only this
  // provider's check, so it checks no other provider: a restore runs it under the agent locks.
  const runChecks = (onlyRequestedProviders: boolean) =>
    preflightService.runChecks(projectRootPath, {
      providerIds: [provider.id],
      onlyRequestedProviders,
      providerEnvs: { [provider.id]: provisioningContext.env },
    });
  const preflightResult = await runChecks(false);
  let providerCheck = preflightResult.providers?.find((p) => p.id === provider.id);
  if (!providerCheck) {
    // An ENABLED_PROVIDERS filter, a failed provider collection or SKIP_PREFLIGHT leaves it out.
    if (requireProviderCheck && !isPreflightSkipped()) {
      throw new ValidationError('Preflight returned no check for the provider', {
        providerId: provider.id,
        providerName: provider.name,
      });
    }
    logger.warn(
      { providerId: provider.id, providerName: provider.name },
      'Preflight returned no check for the provider; MCP readiness was not verified',
    );
  }

  refuseFailedBinary(provider, providerCheck);

  if (providerCheck?.mcpStatus && providerCheck.mcpStatus !== 'pass') {
    await mcpEnsureService.ensureMcp(provider, projectRootPath, provisioningContext);
    const recheck = await runChecks(true);
    providerCheck = recheck.providers?.find((p) => p.id === provider.id);
    refuseFailedBinary(provider, providerCheck);

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

function refuseFailedBinary(provider: Provider, check: ProviderCheck | undefined): void {
  if (check?.binaryStatus !== 'fail') return;
  throw new ValidationError(
    `Provider ${provider.name} failed the binary check: ${check.binaryMessage}`,
    {
      providerId: provider.id,
      providerName: provider.name,
      binaryStatus: check.binaryStatus,
      binaryMessage: check.binaryMessage,
      binaryDetails: check.binaryDetails,
    },
  );
}
