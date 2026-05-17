import type { Prompt } from '../../../storage/models/domain.models';
import {
  McpResponse,
  ListPromptsResponse,
  GetPromptResponse,
  SessionContext,
  type ListPromptsParams,
  type GetPromptParams,
} from '../../dtos/mcp.dto';
import { mapPromptSummary, mapPromptDetail } from '../mappers/dto-mappers';
import { renderTemplate } from '../../../../common/template/handlebars-renderer';
import { buildPromptRenderContext } from '../../../../common/template/prompt-render-context';
import type { PromptToolContext } from './prompt-context';
import { resolveSessionContext } from '../utils/session-context-helpers';
import { requireProject } from '../utils/require-project';

export async function handleListPrompts(
  ctx: PromptToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListPromptsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

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

export async function handleGetPrompt(
  ctx: PromptToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetPromptParams;
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
    const agentId = sessionContext.type === 'agent' ? sessionContext.agent?.id : undefined;
    const { vars } = await buildPromptRenderContext({
      recipientAgentId: agentId,
      teams: ctx.teamsService,
      extras: {
        agent_name: sessionContext.type === 'agent' ? (sessionContext.agent?.name ?? '') : '',
        project_name: sessionContext.project?.name ?? '',
      },
    });
    prompt = {
      ...prompt,
      content: renderTemplate(prompt.content, vars, Object.keys(vars)),
    };
  }

  const response: GetPromptResponse = {
    prompt: mapPromptDetail(prompt),
  };

  return { success: true, data: response };
}
