import type { Skill } from '../../../storage/models/domain.models';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListSkillsResponse,
  GetSkillResponse,
  SessionContext,
  type ListSkillsParams,
  type GetSkillParams,
} from '../../dtos/mcp.dto';
import { mapSkillListItem, mapSkillDetail } from '../mappers/dto-mappers';
import type { SkillToolContext } from './skill-context';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import { resolveSessionContext, getActorFromContext } from '../utils/session-context-helpers';

function skillServiceUnavailable(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Skill operations require full app context (not available in standalone MCP mode)',
    },
  };
}

function catchSkillUnavailable(error: unknown): McpResponse {
  if (error instanceof ServiceUnavailableError) {
    return skillServiceUnavailable();
  }
  throw error;
}

export async function handleListSkills(
  ctx: SkillToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListSkillsParams;

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

  try {
    const projectSkills = await ctx.skillsService.listDiscoverable(project.id, { q: validated.q });
    const response: ListSkillsResponse = {
      skills: projectSkills.map((skill) => mapSkillListItem(skill)),
      total: projectSkills.length,
    };

    return { success: true, data: response };
  } catch (error) {
    return catchSkillUnavailable(error);
  }
}

export async function handleGetSkill(ctx: SkillToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as GetSkillParams;

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

  try {
    const normalizedSlug = validated.slug.trim().toLowerCase();
    let skill: Skill;
    try {
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
  } catch (error) {
    return catchSkillUnavailable(error);
  }
}
