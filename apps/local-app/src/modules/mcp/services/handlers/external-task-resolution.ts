import { AppError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { EpicExternalTaskOutcome } from '../../../epics/services/epics.service';
import { ExternalProviderError } from '../../../external-integrations/errors/external-provider.errors';
import type {
  ExternalTaskReferenceResolver,
  ResolvedExternalTask,
} from '../../../external-integrations/resolution/external-task-reference.resolver';
import {
  isOrdinaryExternalTaskLink,
  type ExternalTaskLink,
} from '../../../storage/models/domain.models';
import type {
  EpicExternalLinkSummary,
  EpicExternalTaskChangeSummary,
  ExternalTaskRefInput,
  McpResponse,
  SessionContext,
} from '../../dtos/mcp.dto';

/** What a handler needs to read a remote task for the calling agent. */
export interface ExternalTaskReadDeps {
  externalTaskResolver: ExternalTaskReferenceResolver;
  /** True when this instance may call ClickUp/Jira for an MCP caller. */
  admitExternalTasks: () => boolean;
}

/** Domain refusal codes passed to the agent unchanged, with their details as `data`. */
const PASSTHROUGH_CODES = new Set([
  'UNSUPPORTED_PROVIDER',
  'INTEGRATION_NOT_CONNECTED',
  'INTEGRATION_NOT_DELIVERED',
  'INTEGRATION_CACHE_UNAVAILABLE',
  'PROJECT_NOT_SEEDED',
  'PROVIDER_REQUIRED',
  'EXTERNAL_TASK_WRONG_SITE',
  'EXTERNAL_TASK_REF_INVALID',
  'EPIC_ALREADY_LINKED',
  'EXTERNAL_TASK_ALREADY_LINKED',
  'INTEGRATION_CONNECTION_CHANGED',
  'EPIC_NOT_LINKED',
  'EXTERNAL_TASK_LINK_MANAGED',
  'MANAGED_SUBTASK_SYNC_BUSY',
  'EXTERNAL_TASK_ESTIMATE_PENDING',
]);

/**
 * Reads the remote task an agent named. Guests and instances that may not
 * call vendors are refused before any read; the vendor read runs outside any
 * transaction.
 */
export async function readExternalTaskForSession(
  deps: ExternalTaskReadDeps,
  sessionContext: SessionContext,
  projectId: string,
  input: ExternalTaskRefInput,
): Promise<{ resolved: ResolvedExternalTask } | { response: McpResponse }> {
  const agentRequired = requireAgentForExternalTask(sessionContext);
  if (agentRequired) return { response: agentRequired };
  if (!deps.admitExternalTasks()) {
    return {
      response: {
        success: false,
        error: {
          code: 'INTEGRATIONS_UNAVAILABLE',
          message:
            'ClickUp and Jira are unavailable on this DevChain instance: it is reachable from the network and is not a claimed VM host.',
        },
      },
    };
  }
  try {
    const resolved = await deps.externalTaskResolver.resolve({
      projectId,
      ref: input.ref,
      provider: input.provider,
    });
    return { resolved };
  } catch (error) {
    const mapped = mapExternalTaskError(error);
    if (mapped) return { response: mapped };
    throw error;
  }
}

/** Remote task reads and link changes, unlink included, are for agent sessions only. */
export function requireAgentForExternalTask(sessionContext: SessionContext): McpResponse | null {
  if (sessionContext.type === 'agent' && sessionContext.agent) return null;
  return {
    success: false,
    error: {
      code: 'AGENT_CONTEXT_REQUIRED',
      message: 'Remote ClickUp and Jira tasks are available to agent sessions only.',
    },
  };
}

/** Maps resolver, vendor and link-domain errors to MCP errors; null for any other error. */
export function mapExternalTaskError(error: unknown): McpResponse | null {
  if (error instanceof ServiceUnavailableError) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Remote ClickUp and Jira tasks require full app context (not available in standalone MCP mode)',
      },
    };
  }
  if (error instanceof ExternalProviderError) {
    const notFound = error.details?.reason === 'not_found';
    return {
      success: false,
      error: {
        code: notFound ? 'EXTERNAL_TASK_NOT_FOUND' : 'EXTERNAL_PROVIDER_ERROR',
        message: notFound
          ? 'The remote task was not found, or the connected account cannot see it.'
          : error.message,
        data: error.details,
      },
    };
  }
  if (error instanceof AppError && PASSTHROUGH_CODES.has(error.code)) {
    return {
      success: false,
      error: { code: error.code, message: error.message, data: error.details },
    };
  }
  if (error instanceof AppError && error.details?.reason === 'connection_changed') {
    return {
      success: false,
      error: {
        code: 'INTEGRATION_CONNECTION_CHANGED',
        message: 'The integration connection changed during the read; try again.',
        data: { retryable: true },
      },
    };
  }
  return null;
}

export function summarizeExternalLink(link: ExternalTaskLink): EpicExternalLinkSummary {
  const snapshot = link.sourceSnapshot;
  const text = (key: string): string | null =>
    typeof snapshot[key] === 'string' ? (snapshot[key] as string) : null;
  return {
    linkId: link.id,
    provider: link.provider,
    remoteKey: text('remoteKey') ?? link.remoteTaskId,
    title: text('title'),
    webUrl: text('webUrl'),
    managed: !isOrdinaryExternalTaskLink(link),
  };
}

export function summarizeExternalTaskChange(
  outcome: EpicExternalTaskOutcome,
): EpicExternalTaskChangeSummary {
  const summary = summarizeExternalLink(outcome.link);
  return {
    change: outcome.change,
    linkId: summary.linkId,
    provider: summary.provider,
    remoteKey: summary.remoteKey,
    releasedManagedLinkIds: outcome.releasedManagedLinkIds,
    ...(outcome.change === 'clear' && outcome.receiptId && { release: 'pending_home_sync' }),
  };
}
