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

  if (validated.id) {
    prompt = await ctx.storage.getPrompt(validated.id);
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
    const { project } = sessionCtxResult.data as SessionContext;

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

  const response: GetPromptResponse = {
    prompt: mapPromptDetail(prompt),
  };

  return { success: true, data: response };
}
