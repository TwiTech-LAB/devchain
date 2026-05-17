import {
  loadAgentRecipientContext,
  type TeamsLookup,
  type AgentRecipientContext,
} from './agent-recipient-context';
import { ServiceUnavailableError } from '../errors/service-unavailable.error';

export const RECIPIENT_CONTEXT_KEYS = ['team_name', 'team_names', 'is_team_lead'] as const;

export interface BuildPromptContextParams {
  recipientAgentId?: string;
  teams: TeamsLookup;
  extras?: Record<string, unknown>;
}

export interface BuildPromptContextResult {
  vars: Record<string, unknown>;
  recipientLegacyVariables: readonly string[];
}

const EMPTY_RECIPIENT: AgentRecipientContext = {
  team_name: '',
  team_names: '',
  is_team_lead: false,
};

export async function buildPromptRenderContext(
  params: BuildPromptContextParams,
): Promise<BuildPromptContextResult> {
  if (params.extras) {
    for (const key of RECIPIENT_CONTEXT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(params.extras, key)) {
        throw new Error(
          `buildPromptRenderContext: extras key "${key}" collides with canonical recipient context.`,
        );
      }
    }
  }

  const recipientCtx: AgentRecipientContext = params.recipientAgentId
    ? await loadAgentRecipientContext(params.teams, params.recipientAgentId).catch((e) => {
        if (e instanceof ServiceUnavailableError) return EMPTY_RECIPIENT;
        throw e;
      })
    : EMPTY_RECIPIENT;

  const vars: Record<string, unknown> = {
    ...recipientCtx,
    ...(params.extras ?? {}),
  };

  return {
    vars,
    recipientLegacyVariables: RECIPIENT_CONTEXT_KEYS,
  };
}
