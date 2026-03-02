import type { Skill } from '../../../storage/models/domain.models';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListSkillsParamsSchema,
  GetSkillParamsSchema,
  ListSkillsResponse,
  GetSkillResponse,
  SessionContext,
} from '../../dtos/mcp.dto';
import { mapSkillListItem, mapSkillDetail } from '../mappers/dto-mappers';
import type { McpToolContext } from './types';

function getActorFromContext(
  ctx: SessionContext,
): { id: string; name: string; projectId: string } | null {
  if (ctx.type === 'agent') {
    return ctx.agent;
  }
  if (ctx.type === 'guest') {
    return {
      id: ctx.guest.id,
      name: ctx.guest.name,
      projectId: ctx.guest.projectId,
    };
  }
  return null;
}

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

export async function handleListSkills(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.skillsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Skill listing requires SkillsService to be available',
      },
    };
  }

  const validated = ListSkillsParamsSchema.parse(params);

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

  const projectSkills = await ctx.skillsService.listDiscoverable(project.id, { q: validated.q });
  const response: ListSkillsResponse = {
    skills: projectSkills.map((skill) => mapSkillListItem(skill)),
    total: projectSkills.length,
  };

  return { success: true, data: response };
}

export async function handleGetSkill(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.skillsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Skill retrieval requires SkillsService to be available',
      },
    };
  }

  const validated = GetSkillParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const { project } = sessionCtx;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  const normalizedSlug = validated.slug.trim().toLowerCase();
  let skill: Skill;
  try {
    // get_skill intentionally bypasses project-level disable state (discovery-only filter)
    skill = await ctx.skillsService.getSkillBySlug(normalizedSlug);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'SKILL_NOT_FOUND',
          message: `Skill "${validated.slug}" was not found.`,
        },
      };
    }
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          data: error.details,
        },
      };
    }
    throw error;
  }

  const actor = getActorFromContext(sessionCtx);
  await ctx.skillsService.logUsage(
    skill.id,
    skill.slug,
    project.id,
    actor?.id ?? null,
    actor?.name ?? null,
  );

  const response: GetSkillResponse = mapSkillDetail(skill);
  return { success: true, data: response };
}
