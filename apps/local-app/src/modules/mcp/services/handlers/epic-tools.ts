import type { EpicOperationContext } from '../../../epics/services/epics.service';
import type { Status, Epic } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListAgentsParamsSchema,
  ListAgentsResponse,
  AgentSummary,
  GetAgentByNameParamsSchema,
  GetAgentByNameResponse,
  ListStatusesParamsSchema,
  ListStatusesResponse,
  ListEpicsParamsSchema,
  ListEpicsResponse,
  ListAssignedEpicsTasksParamsSchema,
  ListAssignedEpicsTasksResponse,
  CreateEpicParamsSchema,
  CreateEpicResponse,
  GetEpicByIdParamsSchema,
  GetEpicByIdResponse,
  AddEpicCommentParamsSchema,
  AddEpicCommentResponse,
  UpdateEpicParamsSchema,
  UpdateEpicResponse,
  SessionContext,
  AgentSessionContext,
  GuestSessionContext,
  EpicParentSummary,
} from '../../dtos/mcp.dto';
import {
  mapStatusSummary,
  mapEpicSummary,
  mapEpicChild,
  mapEpicParent,
  mapEpicComment,
} from '../mappers/dto-mappers';
import type { McpToolContext } from './types';
import { resolveEpicId } from '../utils/resolve-epic-id';

const logger = createLogger('McpService');

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

export async function handleListAgents(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = ListAgentsParamsSchema.parse(params);

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

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;
  const normalizedQuery = validated.q?.toLowerCase();

  const MAX_COMBINED_FETCH = 1000;
  const [agentsResult, guests] = await Promise.all([
    ctx.storage.listAgents(project.id, { limit: MAX_COMBINED_FETCH, offset: 0 }),
    ctx.storage.listGuests(project.id),
  ]);

  const [agentPresence, tmuxSessions] = await Promise.all([
    ctx.sessionsService
      ? ctx.sessionsService.getAgentPresence(project.id)
      : Promise.resolve(new Map<string, { online: boolean }>()),
    ctx.tmuxService ? ctx.tmuxService.listAllSessionNames() : Promise.resolve(new Set<string>()),
  ]);

  const agentItems: AgentSummary[] = agentsResult.items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    profileId: agent.profileId,
    description: agent.description,
    type: 'agent' as const,
    online: agentPresence.get(agent.id)?.online ?? false,
  }));

  const guestItems: AgentSummary[] = guests.map((guest) => ({
    id: guest.id,
    name: guest.name,
    profileId: null,
    description: guest.description,
    type: 'guest' as const,
    online: tmuxSessions.has(guest.tmuxSessionId),
  }));

  let allItems = [...agentItems, ...guestItems].sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.type === 'agent' ? -1 : 1;
  });

  if (normalizedQuery) {
    allItems = allItems.filter((item) => item.name.toLowerCase().includes(normalizedQuery));
  }

  const total = allItems.length;
  const paginatedItems = allItems.slice(offset, offset + limit);

  const response: ListAgentsResponse = {
    agents: paginatedItems,
    total,
    limit,
    offset,
  };

  return { success: true, data: response };
}

export async function handleGetAgentByName(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = GetAgentByNameParamsSchema.parse(params);

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

  const normalizedName = validated.name.trim().toLowerCase();
  const agentsList = await ctx.storage.listAgents(project.id, { limit: 1000, offset: 0 });

  const candidate = agentsList.items.find((agent) => agent.name.toLowerCase() === normalizedName);

  if (!candidate) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: `Agent "${validated.name}" not found in project`,
        data: {
          availableNames: agentsList.items.map((agent) => agent.name),
        },
      },
    };
  }

  let agentWithProfile;
  try {
    agentWithProfile = await ctx.storage.getAgentByName(project.id, candidate.name);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${validated.name}" not found in project`,
          data: {
            availableNames: agentsList.items.map((agent) => agent.name),
          },
        },
      };
    }
    logger.warn(
      { projectId: project.id, name: candidate.name, error },
      'Agent lookup failed after matching by name',
    );
    throw error;
  }

  if (!ctx.instructionsResolver) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message:
          'Instructions resolver requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const profile = agentWithProfile.profile;
  const resolvedInstructions = profile
    ? await ctx.instructionsResolver.resolve(project.id, profile.instructions ?? null, {
        maxBytes: ctx.defaultInlineMaxBytes ?? 64 * 1024,
      })
    : null;

  if (profile && ctx.featureFlags?.enableProfileInstructionTemplates) {
    // Placeholder: profile instructions will support template variables behind this flag.
  }

  const response: GetAgentByNameResponse = {
    agent: {
      id: agentWithProfile.id,
      name: agentWithProfile.name,
      profileId: agentWithProfile.profileId,
      description: agentWithProfile.description,
      profile: profile
        ? {
            id: profile.id,
            name: profile.name,
            instructions: profile.instructions ?? null,
            instructionsResolved: resolvedInstructions ?? undefined,
          }
        : undefined,
    },
  };

  return { success: true, data: response };
}

export async function handleListStatuses(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListStatusesParamsSchema.parse(params);

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

  const result = await ctx.storage.listStatuses(project.id, {
    limit: 1000,
    offset: 0,
  });
  const response: ListStatusesResponse = {
    statuses: result.items.map((status) => mapStatusSummary(status)),
  };

  return { success: true, data: response };
}

export async function handleListEpics(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = ListEpicsParamsSchema.parse(params);

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

  let statusId: string | undefined;
  if (validated.statusName) {
    const status = await ctx.storage.findStatusByName(project.id, validated.statusName);
    if (!status) {
      return {
        success: false,
        error: {
          code: 'STATUS_NOT_FOUND',
          message: `Status "${validated.statusName}" was not found for project ${project.id}.`,
        },
      };
    }
    statusId = status.id;
  }

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;
  const query = validated.q?.trim();

  const result = await ctx.storage.listProjectEpics(project.id, {
    statusId,
    q: query && query.length ? query : undefined,
    limit,
    offset,
    excludeMcpHidden: true,
    parentOnly: true,
  });

  const statusesResult = await ctx.storage.listStatuses(project.id, {
    limit: 1000,
    offset: 0,
  });
  const statusById = new Map<string, Status>();
  for (const s of statusesResult.items) statusById.set(s.id, s);

  const agentIds = new Set<string>();
  for (const epic of result.items) {
    if (epic.agentId) agentIds.add(epic.agentId);
  }

  const agentNameById = new Map<string, string>();
  for (const agentId of agentIds) {
    try {
      const agent = await ctx.storage.getAgent(agentId);
      agentNameById.set(agentId, agent.name);
    } catch (error) {
      logger.warn({ agentId }, 'Failed to resolve agent name');
    }
  }

  const parentIds = result.items.map((epic) => epic.id);
  const subEpicsMap = await ctx.storage.listSubEpicsForParents(project.id, parentIds, {
    excludeMcpHidden: true,
    type: 'active',
    limitPerParent: 50,
  });

  const epicsWithStatus = result.items.map((epic) => {
    const summary = mapEpicSummary(epic, agentNameById);
    const status = statusById.get(epic.statusId);
    if (status) {
      summary.status = mapStatusSummary(status);
    }

    const subEpics = subEpicsMap.get(epic.id) ?? [];
    summary.subEpics = subEpics.map((subEpic) => {
      const child = mapEpicChild(subEpic);
      const subStatus = statusById.get(subEpic.statusId);
      if (subStatus) {
        child.status = mapStatusSummary(subStatus);
      }
      return child;
    });

    return summary;
  });

  const response: ListEpicsResponse = {
    epics: epicsWithStatus,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };

  return { success: true, data: response };
}

export async function handleListAssignedEpicsTasks(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListAssignedEpicsTasksParamsSchema.parse(params);

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

  const limit = validated.limit ?? 100;
  const offset = validated.offset ?? 0;

  try {
    const result = await ctx.storage.listAssignedEpics(project.id, {
      agentName: validated.agentName,
      limit,
      offset,
      excludeMcpHidden: true,
    });

    const statusesResult = await ctx.storage.listStatuses(project.id, {
      limit: 1000,
      offset: 0,
    });
    const statusById = new Map<string, Status>();
    for (const s of statusesResult.items) statusById.set(s.id, s);

    const agentIds = new Set<string>();
    for (const epic of result.items) {
      if (epic.agentId) agentIds.add(epic.agentId);
    }

    const agentNameById = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const agent = await ctx.storage.getAgent(agentId);
        agentNameById.set(agentId, agent.name);
      } catch (error) {
        logger.warn({ agentId }, 'Failed to resolve agent name');
      }
    }

    const epicsWithStatus = result.items.map((epic) => {
      const summary = mapEpicSummary(epic, agentNameById);
      const status = statusById.get(epic.statusId);
      if (status) {
        summary.status = mapStatusSummary(status);
      }
      return summary;
    });

    const response: ListAssignedEpicsTasksResponse = {
      epics: epicsWithStatus,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${validated.agentName}" was not found for project ${project.id}.`,
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
}

export async function handleCreateEpic(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.epicsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Epic creation requires full app context (not available in standalone MCP mode)',
      },
    };
  }

  const validated = CreateEpicParamsSchema.parse(params);

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

  let statusId: string | undefined;
  if (validated.statusName) {
    const status = await ctx.storage.findStatusByName(project.id, validated.statusName);
    if (!status) {
      const statusesResult = await ctx.storage.listStatuses(project.id, {
        limit: 1000,
        offset: 0,
      });
      return {
        success: false,
        error: {
          code: 'STATUS_NOT_FOUND',
          message: `Status "${validated.statusName}" was not found for project.`,
          data: {
            availableStatuses: statusesResult.items.map((s) => ({ id: s.id, name: s.label })),
          },
        },
      };
    }
    statusId = status.id;
  }

  try {
    const sessionCtx = sessionCtxResult.data as SessionContext;
    const actor =
      sessionCtx.type === 'agent'
        ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
        : sessionCtx.type === 'guest'
          ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
          : null;

    const context: EpicOperationContext = { actor };

    const epic = await ctx.epicsService.createEpicForProject(
      project.id,
      {
        title: validated.title,
        description: validated.description ?? null,
        statusId,
        tags: validated.tags ?? [],
        agentName: validated.agentName,
        parentId: validated.parentId ?? null,
        skillsRequired: validated.skillsRequired ?? null,
      },
      context,
    );

    let agentNameById: Map<string, string> | undefined;
    if (epic.agentId) {
      agentNameById = new Map();
      try {
        const agent = await ctx.storage.getAgent(epic.agentId);
        agentNameById.set(epic.agentId, agent.name);
      } catch (error) {
        logger.warn({ agentId: epic.agentId }, 'Failed to resolve agent name');
      }
    }

    const response: CreateEpicResponse = {
      epic: mapEpicSummary(epic, agentNameById),
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${validated.agentName}" was not found for project ${project.id}.`,
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
}

export async function handleGetEpicById(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = GetEpicByIdParamsSchema.parse(params);

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

  const resolved = await resolveEpicId(ctx.storage, project.id, validated.id);
  if (!resolved.success) return resolved;
  const epicId = (resolved.data as { epicId: string }).epicId;

  let epic: Epic;
  try {
    epic = await ctx.storage.getEpic(epicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${epicId} was not found.`,
        },
      };
    }
    throw error;
  }

  if (epic.projectId !== project.id) {
    return {
      success: false,
      error: {
        code: 'EPIC_NOT_FOUND',
        message: `Epic ${epicId} does not belong to the resolved project.`,
      },
    };
  }

  const commentsResult = await ctx.storage.listEpicComments(epic.id, {
    limit: 250,
    offset: 0,
  });
  const subEpicsResult = await ctx.storage.listSubEpics(epic.id, { limit: 250, offset: 0 });

  let parentEpic: Epic | undefined;
  if (epic.parentId) {
    try {
      const parent = await ctx.storage.getEpic(epic.parentId);
      if (parent.projectId === project.id) {
        parentEpic = parent;
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.warn({ epicId: epic.id, parentId: epic.parentId }, 'Parent epic missing');
      } else {
        throw error;
      }
    }
  }

  const statusesResult = await ctx.storage.listStatuses(project.id, {
    limit: 1000,
    offset: 0,
  });
  const statusById = new Map<string, Status>();
  for (const s of statusesResult.items) statusById.set(s.id, s);

  const agentIds = new Set<string>();
  if (epic.agentId) agentIds.add(epic.agentId);
  for (const child of subEpicsResult.items) {
    if (child.agentId) agentIds.add(child.agentId);
  }
  if (parentEpic?.agentId) agentIds.add(parentEpic.agentId);

  const agentNameById = new Map<string, string>();
  for (const agentId of agentIds) {
    try {
      const agent = await ctx.storage.getAgent(agentId);
      agentNameById.set(agentId, agent.name);
    } catch (error) {
      logger.warn({ agentId }, 'Failed to resolve agent name');
    }
  }

  let parentSummary: EpicParentSummary | undefined;
  if (parentEpic) {
    parentSummary = mapEpicParent(parentEpic, agentNameById);
  }

  const epicSummary = mapEpicSummary(epic, agentNameById);
  const epicStatus = statusById.get(epic.statusId);
  if (epicStatus) {
    epicSummary.status = mapStatusSummary(epicStatus);
  }

  const subEpicsWithStatus = subEpicsResult.items.map((child) => {
    const childSummary = mapEpicChild(child);
    const childStatus = statusById.get(child.statusId);
    if (childStatus) {
      childSummary.status = mapStatusSummary(childStatus);
    }
    return childSummary;
  });

  const response: GetEpicByIdResponse = {
    epic: epicSummary,
    comments: [...commentsResult.items]
      .reverse()
      .map((comment, idx) => ({ ...mapEpicComment(comment), commentNumber: idx + 1 })),
    subEpics: subEpicsWithStatus,
  };

  if (parentSummary) {
    response.parent = parentSummary;
  }

  return { success: true, data: response };
}

export async function handleAddEpicComment(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = AddEpicCommentParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;

  const authorActor = getActorFromContext(sessionCtx);
  if (!authorActor) {
    return {
      success: false,
      error: {
        code: 'AGENT_REQUIRED',
        message: 'Session must be associated with an agent or guest to add comments',
      },
    };
  }

  const project = sessionCtx.project;
  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  const resolved = await resolveEpicId(ctx.storage, project.id, validated.epicId);
  if (!resolved.success) return resolved;
  const epicId = (resolved.data as { epicId: string }).epicId;

  let epic: Epic;
  try {
    epic = await ctx.storage.getEpic(epicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${epicId} was not found.`,
        },
      };
    }
    throw error;
  }

  if (epic.projectId !== project.id) {
    return {
      success: false,
      error: {
        code: 'EPIC_NOT_FOUND',
        message: `Epic ${epicId} does not belong to the resolved project.`,
      },
    };
  }

  const comment = await ctx.storage.createEpicComment({
    epicId,
    authorName: authorActor.name,
    content: validated.content,
  });

  const response: AddEpicCommentResponse = {
    comment: mapEpicComment(comment),
  };

  return { success: true, data: response };
}

export async function handleUpdateEpic(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  if (!ctx.epicsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Epic updates require full app context (not available in standalone MCP mode)',
      },
    };
  }

  let preprocessedParams = params;
  if (params && typeof params === 'object' && 'assignment' in params) {
    const p = params as Record<string, unknown>;
    if (typeof p.assignment === 'string') {
      try {
        preprocessedParams = { ...p, assignment: JSON.parse(p.assignment) };
      } catch {
        // Leave as-is; Zod will report the validation error
      }
    }
  }

  const validated = UpdateEpicParamsSchema.parse(preprocessedParams);

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

  const resolved = await resolveEpicId(ctx.storage, project.id, validated.id);
  if (!resolved.success) return resolved;
  const epicId = (resolved.data as { epicId: string }).epicId;

  let epic: Epic;
  try {
    epic = await ctx.storage.getEpic(epicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${epicId} was not found.`,
        },
      };
    }
    throw error;
  }

  if (epic.projectId !== project.id) {
    return {
      success: false,
      error: {
        code: 'EPIC_NOT_FOUND',
        message: `Epic ${epicId} does not belong to the resolved project.`,
      },
    };
  }

  const updateData: {
    title?: string;
    description?: string;
    statusId?: string;
    agentId?: string | null;
    parentId?: string | null;
    tags?: string[];
    skillsRequired?: string[] | null;
  } = {};

  if (validated.title !== undefined) {
    updateData.title = validated.title;
  }

  if (validated.description !== undefined) {
    updateData.description = validated.description;
  }

  if (validated.skillsRequired !== undefined) {
    updateData.skillsRequired = validated.skillsRequired;
  }

  if (validated.statusName) {
    const status = await ctx.storage.findStatusByName(project.id, validated.statusName);
    if (!status) {
      const statusesResult = await ctx.storage.listStatuses(project.id, {
        limit: 1000,
        offset: 0,
      });
      return {
        success: false,
        error: {
          code: 'STATUS_NOT_FOUND',
          message: `Status "${validated.statusName}" was not found for project.`,
          data: {
            availableStatuses: statusesResult.items.map((s) => ({ id: s.id, name: s.label })),
          },
        },
      };
    }
    updateData.statusId = status.id;
  }

  if (validated.assignment) {
    if ('clear' in validated.assignment && validated.assignment.clear) {
      updateData.agentId = null;
    } else if ('agentName' in validated.assignment) {
      try {
        const agent = await ctx.storage.getAgentByName(project.id, validated.assignment.agentName);
        updateData.agentId = agent.id;
      } catch (error) {
        if (error instanceof NotFoundError) {
          const agentsList = await ctx.storage.listAgents(project.id, {
            limit: 1000,
            offset: 0,
          });
          return {
            success: false,
            error: {
              code: 'AGENT_NOT_FOUND',
              message: `Agent "${validated.assignment.agentName}" was not found for project.`,
              data: {
                availableAgents: agentsList.items.map((a) => ({ id: a.id, name: a.name })),
              },
            },
          };
        }
        throw error;
      }
    }
  }

  if (validated.clearParent) {
    updateData.parentId = null;
  } else if (validated.parentId !== undefined) {
    if (validated.parentId === epicId) {
      return {
        success: false,
        error: {
          code: 'PARENT_INVALID',
          message: 'An epic cannot be its own parent.',
        },
      };
    }

    let parentEpic: Epic;
    try {
      parentEpic = await ctx.storage.getEpic(validated.parentId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'PARENT_INVALID',
            message: `Parent epic ${validated.parentId} was not found.`,
          },
        };
      }
      throw error;
    }

    if (parentEpic.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'PARENT_INVALID',
          message: 'Parent epic must belong to the same project.',
        },
      };
    }

    if (parentEpic.parentId !== null) {
      return {
        success: false,
        error: {
          code: 'HIERARCHY_CONFLICT',
          message:
            'Only one level of epic hierarchy is allowed. The specified parent already has a parent.',
        },
      };
    }

    updateData.parentId = validated.parentId;
  }

  if (validated.setTags !== undefined) {
    updateData.tags = validated.setTags;
  } else if (validated.addTags || validated.removeTags) {
    const currentTags = new Set<string>(epic.tags);

    if (validated.addTags) {
      validated.addTags.forEach((tag) => currentTags.add(tag));
    }

    if (validated.removeTags) {
      validated.removeTags.forEach((tag) => currentTags.delete(tag));
    }

    updateData.tags = Array.from(currentTags);
  }

  let updatedEpic: Epic;
  try {
    const actor =
      sessionCtx.type === 'agent'
        ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
        : sessionCtx.type === 'guest'
          ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
          : null;

    const context: EpicOperationContext = { actor };

    updatedEpic = await ctx.epicsService.updateEpic(epicId, updateData, validated.version, context);
  } catch (error) {
    if (error instanceof Error && error.message.includes('was modified by another operation')) {
      const currentEpic = await ctx.storage.getEpic(epicId);
      return {
        success: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: `Epic version conflict. Expected version ${validated.version}, but current version is ${currentEpic.version}.`,
          data: {
            currentVersion: currentEpic.version,
          },
        },
      };
    }
    throw error;
  }

  let agentNameById: Map<string, string> | undefined;
  if (updatedEpic.agentId) {
    agentNameById = new Map();
    try {
      const agent = await ctx.storage.getAgent(updatedEpic.agentId);
      agentNameById.set(updatedEpic.agentId, agent.name);
    } catch (error) {
      logger.warn({ agentId: updatedEpic.agentId }, 'Failed to resolve agent name');
    }
  }

  const response: UpdateEpicResponse = {
    epic: mapEpicSummary(updatedEpic, agentNameById),
  };

  const statusChanged = updateData.statusId !== undefined && updateData.statusId !== epic.statusId;

  if (
    sessionCtx.type === 'agent' &&
    sessionCtx.agent?.id &&
    statusChanged &&
    validated.assignment === undefined &&
    updatedEpic.agentId === sessionCtx.agent.id
  ) {
    const hintAgentName = agentNameById?.get(updatedEpic.agentId) ?? sessionCtx.agent.name;
    response.hint = `Status changed while this epic remains assigned to ${hintAgentName}. If you intend a handoff, call devchain_update_epic with assignment: { agentName: "Target Agent" }.`;
  }

  return { success: true, data: response };
}
