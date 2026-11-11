import { AppError, VaultAccessRefusedError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type {
  McpResponse,
  SessionContext,
  VaultListParams,
  VaultListResponse,
  VaultRequestParams,
} from '../../dtos/mcp.dto';
import { vaultListInstructions } from '../../../vault/vault-instructions';
import { requireProject } from '../utils/require-project';
import { resolveSessionContext } from '../utils/session-context-helpers';
import type { VaultToolContext } from './vault-context';

interface AgentSession {
  sessionId: string;
  agentId: string;
}

/**
 * The scaffolding both vault tools share: resolve the caller to an agent session,
 * run the body, and map the errors. `mapError` carries each tool's own policy;
 * `ServiceUnavailableError` maps the same way for both.
 */
async function withAgentSession(
  ctx: VaultToolContext,
  sessionId: string,
  guestMessage: string,
  body: (session: AgentSession) => Promise<McpResponse>,
  mapError: (error: unknown) => McpResponse | null,
): Promise<McpResponse> {
  try {
    const required = requireProject(await resolveSessionContext(ctx, sessionId));
    if (!('sessionContext' in required)) return required;
    const sessionCtx: SessionContext = required.sessionContext;
    if (sessionCtx.type !== 'agent' || !sessionCtx.agent) {
      return {
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED', message: guestMessage },
      };
    }
    return await body({ sessionId: sessionCtx.session.id, agentId: sessionCtx.agent.id });
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return mapped;
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
    throw error;
  }
}

export function handleVaultList(ctx: VaultToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as VaultListParams;
  return withAgentSession(
    ctx,
    validated.sessionId,
    'Vault entries belong to agents. Guests have none.',
    async (session) => {
      const entries = await ctx.vaultDiscoveryService.listForSession(
        session.sessionId,
        session.agentId,
      );
      const data: VaultListResponse = { entries, instructions: vaultListInstructions() };
      return { success: true, data };
    },
    (error) =>
      error instanceof VaultAccessRefusedError
        ? { success: false, error: { code: error.code, message: error.message } }
        : null,
  );
}

/**
 * Asks the user for an entry and returns at once. Project and family come from the
 * session; the params carry no value in any form.
 */
export function handleVaultRequest(ctx: VaultToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as VaultRequestParams;
  return withAgentSession(
    ctx,
    validated.sessionId,
    'Vault requests belong to agents. Guests cannot make them.',
    async (session) => {
      const result = await ctx.vaultRequestService.request({
        sessionId: session.sessionId,
        agentId: session.agentId,
        name: validated.name,
        description: validated.description,
        kind: validated.kind,
      });
      return { success: true, data: result };
    },
    (error) => {
      if (!(error instanceof AppError)) return null;
      const detailCode = error.details?.code;
      return {
        success: false,
        error: {
          code: typeof detailCode === 'string' ? detailCode : error.code,
          message: error.message,
        },
      };
    },
  );
}
