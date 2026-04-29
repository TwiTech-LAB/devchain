import type { Prompt } from '../../../storage/models/domain.models';
import {
  McpResponse,
  ListPromptsParamsSchema,
  GetPromptParamsSchema,
  ListPromptsResponse,
  GetPromptResponse,
  SessionContext,
} from '../../dtos/mcp.dto';
import { mapPromptSummary, mapPromptDetail } from '../mappers/dto-mappers';
import { renderTemplate } from '../../../../common/template/handlebars-renderer';
import { loadAgentRecipientContext } from '../../../../common/template/agent-recipient-context';
import type { McpToolContext } from './types';

function missingSessionResolver(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Session resolution requires full app context (not available in standalone MCP mode)',
    },
  };
}

async function resolveSessionContext(ctx: McpToolContext, sessionId: string): Promise<McpResponse> {
  if (!ctx.resolveSessionContext) {
    return missingSessionResolver();
  }
  return ctx.resolveSessionContext(sessionId);
}

async function buildRenderVars(
  ctx: McpToolContext,
  sessionContext: SessionContext,
): Promise<{ vars: Record<string, unknown>; legacyVariables: string[] }> {
  const agentId = sessionContext.type === 'agent' ? sessionContext.agent?.id : undefined;
  const teamCtx =
    agentId && ctx.teamsService
      ? await loadAgentRecipientContext(ctx.teamsService, agentId)
      : { team_name: '', team_names: '', is_team_lead: false };
  const vars: Record<string, unknown> = {
    agent_name: sessionContext.type === 'agent' ? (sessionContext.agent?.name ?? '') : '',
    project_name: sessionContext.project?.name ?? '',
    ...teamCtx,
  };
  return { vars, legacyVariables: Object.keys(vars) };
}

function renderPromptContent(
  content: string,
  vars: Record<string, unknown>,
  legacyVariables: string[],
): string {
  return renderTemplate(content, vars, legacyVariables);
}

export async function handleListPrompts(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListPromptsParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  const projectId = project.id;

  const result = await ctx.storage.listPrompts({
    projectId: projectId ?? null,
    q: validated.q,
  });

  let items = result.items;
  if (validated.tags?.length) {
    items = items.filter((prompt) => validated.tags!.every((tag) => prompt.tags.includes(tag)));
  }

  const response: ListPromptsResponse = {
    prompts: items.map((prompt) => mapPromptSummary(prompt)),
    total: items.length,
  };

  return { success: true, data: response };
}

export async function handleGetPrompt(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = GetPromptParamsSchema.parse(params);
  let prompt: Prompt | undefined;
  let sessionContext: SessionContext | undefined;

  if (validated.id) {
    prompt = await ctx.storage.getPrompt(validated.id);

    if (prompt && validated.sessionId) {
      const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
      if (!sessionCtxResult.success) return sessionCtxResult;
      sessionContext = sessionCtxResult.data as SessionContext;
    }
  } else if (validated.name) {
    if (!validated.sessionId) {
      return {
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: 'sessionId is required when querying prompt by name',
        },
      };
    }

    const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
    if (!sessionCtxResult.success) return sessionCtxResult;
    sessionContext = sessionCtxResult.data as SessionContext;
    const { project } = sessionContext;

    if (!project) {
      return {
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'No project associated with this session' },
      };
    }

    const projectId = project.id;

    const list = await ctx.storage.listPrompts({ projectId: projectId ?? null });
    const found = list.items.find((item) => {
      if (item.title !== validated.name) {
        return false;
      }
      if (validated.version !== undefined) {
        return item.version === validated.version;
      }
      return true;
    });

    if (found) {
      prompt = await ctx.storage.getPrompt(found.id);
    }
  }

  if (!prompt) {
    return {
      success: false,
      error: {
        code: 'PROMPT_NOT_FOUND',
        message: validated.id
          ? `Prompt with id "${validated.id}" not found`
          : `Prompt "${validated.name}"${validated.version ? ` version ${validated.version}` : ''} not found`,
      },
    };
  }

  if (sessionContext) {
    const { vars, legacyVariables } = await buildRenderVars(ctx, sessionContext);
    prompt = {
      ...prompt,
      content: renderPromptContent(prompt.content, vars, legacyVariables),
    };
  }

  const response: GetPromptResponse = {
    prompt: mapPromptDetail(prompt),
  };

  return { success: true, data: response };
}
