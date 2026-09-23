import { ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListSkillsResponse,
  GetSkillResponse,
  SkillsUsageStatsResponse,
  SkillsSetEnabledResponse,
  SkillsSetSourceEnabledResponse,
  SkillsSyncResponse,
  type SkillsSetSourceEnabledParams,
  type SkillsSyncParams,
  SessionContext,
  type ListSkillsParams,
  type GetSkillParams,
  type SkillsUsageStatsParams,
  type SkillsSetEnabledParams,
} from '../../dtos/mcp.dto';
import { mapSkillListItem, mapSkillDetail } from '../mappers/dto-mappers';
import type { SkillToolContext } from './skill-context';
import type { ResolveDiscoverableSkillResult } from '../../../skills/services/skills.service';
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

function agentContextRequired(): McpResponse {
  return {
    success: false,
    error: {
      code: 'AGENT_CONTEXT_REQUIRED',
      message: 'An agent context is required.',
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
    const skills: ListSkillsResponse['skills'] = validated.includeDisabled
      ? (await ctx.skillsService.listAllStoredForProject(project.id, { q: validated.q })).map(
          (skill) => ({
            ...mapSkillListItem(skill),
            disabled: skill.disabled,
            skillDisabled: skill.skillDisabled,
            sourceProjectEnabled: skill.sourceProjectEnabled,
            sourceGloballyEnabled: skill.sourceGloballyEnabled,
          }),
        )
      : (await ctx.skillsService.listDiscoverable(project.id, { q: validated.q })).map((skill) =>
          mapSkillListItem(skill),
        );
    const response: ListSkillsResponse = {
      skills,
      total: skills.length,
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

  const normalizedSlug = validated.slug.trim().toLowerCase();

  try {
    let resolution: ResolveDiscoverableSkillResult;
    try {
      resolution = await ctx.skillsService.resolveDiscoverableSkill(project.id, validated.slug);
    } catch (error) {
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

    if (resolution.status === 'disabled') {
      return {
        success: false,
        error: {
          code: 'SKILL_DISABLED',
          message: `Skill ${normalizedSlug} is disabled for this project.`,
          data: { enabledAlternatives: resolution.enabledAlternatives },
        },
      };
    }

    if (resolution.status === 'ambiguous') {
      return {
        success: false,
        error: {
          code: 'AMBIGUOUS_SKILL',
          message: `Skill ${normalizedSlug} matched multiple enabled skills.`,
          data: { candidates: resolution.candidates },
        },
      };
    }

    if (resolution.status === 'not_found') {
      return {
        success: false,
        error: {
          code: 'SKILL_NOT_FOUND',
          message: `Skill "${validated.slug}" was not found.`,
        },
      };
    }

    const skill = resolution.skill;
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

export async function handleSkillsUsageStats(
  ctx: SkillToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SkillsUsageStatsParams;

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
    const [usage, epicReferences] = await Promise.all([
      ctx.skillsService.getCompleteUsageStats({
        projectId: project.id,
        from: validated.from,
        to: validated.to,
      }),
      ctx.skillsService.getSkillsEpicReferences(project.id),
    ]);

    const response: SkillsUsageStatsResponse = {
      summary: usage.summary,
      skills: usage.skills.map((row) => ({
        slug: row.skillSlug,
        name: row.skillName,
        displayName: row.skillDisplayName,
        usageCount: row.usageCount,
        firstAccessedAt: row.firstAccessedAt,
        lastAccessedAt: row.lastAccessedAt,
      })),
      complete: true,
      epicReferences,
    };

    return { success: true, data: response };
  } catch (error) {
    return catchSkillUnavailable(error);
  }
}

export async function handleSkillsSetEnabled(
  ctx: SkillToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SkillsSetEnabledParams;

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

  if (sessionCtx.type !== 'agent' || !sessionCtx.agent) {
    return agentContextRequired();
  }

  try {
    const result = await ctx.skillsService.setSkillsEnabled(
      project.id,
      validated.slugs,
      validated.enabled,
    );
    const response: SkillsSetEnabledResponse = {
      updatedCount: result.updated.length,
      unchanged: result.unchanged,
      notFound: result.notFound,
    };
    return { success: true, data: response };
  } catch (error) {
    return catchSkillUnavailable(error);
  }
}

export async function handleSkillsSetSourceEnabled(
  ctx: SkillToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SkillsSetSourceEnabledParams;

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

  if (sessionCtx.type !== 'agent' || !sessionCtx.agent) {
    return agentContextRequired();
  }

  try {
    const result = await ctx.skillsService.setSourceProjectEnabledForMcp(
      project.id,
      validated.sourceName,
      validated.enabled,
    );

    if (result.status === 'source_not_found') {
      return {
        success: false,
        error: {
          code: 'SOURCE_NOT_FOUND',
          message: `Skill source "${validated.sourceName}" was not found.`,
        },
      };
    }

    if (result.status === 'source_disabled_globally') {
      return {
        success: false,
        error: {
          code: 'SOURCE_DISABLED_GLOBALLY',
          message: `Skill source ${result.name} is disabled globally; a project toggle has no effect.`,
        },
      };
    }

    const response: SkillsSetSourceEnabledResponse = {
      name: result.name,
      projectId: result.projectId,
      projectEnabled: result.projectEnabled,
    };
    return { success: true, data: response };
  } catch (error) {
    return catchSkillUnavailable(error);
  }
}

export async function handleSkillsSync(
  ctx: SkillToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as SkillsSyncParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;

  // Sync affects every project, so no project binding is required; only an
  // agent identity gates the call.
  if (sessionCtx.type !== 'agent' || !sessionCtx.agent) {
    return agentContextRequired();
  }

  try {
    const result: SkillsSyncResponse = validated.sourceName
      ? await ctx.skillSourceLifecycleService.syncSource(validated.sourceName)
      : await ctx.skillSourceLifecycleService.syncAll();
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: {
          code: 'SOURCE_NOT_FOUND',
          message: error.message,
        },
      };
    }
    return catchSkillUnavailable(error);
  }
}
