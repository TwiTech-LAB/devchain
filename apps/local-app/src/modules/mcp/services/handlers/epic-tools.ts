import type { EpicOperationContext } from '../../../epics/services/epics.service';
import type { Status, Epic } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListEpicsResponse,
  ListAssignedEpicsTasksResponse,
  CreateEpicResponse,
  GetEpicByIdResponse,
  AddEpicCommentResponse,
  UpdateEpicResponse,
  DeleteEpicResponse,
  SessionContext,
  AgentSessionContext,
  GuestSessionContext,
  EpicParentSummary,
  type ListEpicsParams,
  type ListAssignedEpicsTasksParams,
  type CreateEpicParams,
  type GetEpicByIdParams,
  type AddEpicCommentParams,
  type UpdateEpicParams,
  type DeleteEpicParams,
} from '../../dtos/mcp.dto';
import {
  mapEpicSummary,
  mapEpicChild,
  mapEpicParent,
  mapEpicComment,
} from '../mappers/dto-mappers';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { EpicToolContext } from './epic-context';
import { resolveEpicId } from '../utils/resolve-epic-id';
import { resolveSessionContext, getActorFromContext } from '../utils/session-context-helpers';
import { resolveAgentNames } from '../utils/agent-name-resolver';
import { requireProject } from '../utils/require-project';

const logger = createLogger('McpService');

export async function handleListEpics(ctx: EpicToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as ListEpicsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

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

  const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

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
      summary.status = status.label;
    }

    const subEpics = subEpicsMap.get(epic.id) ?? [];
    summary.subEpics = subEpics.map((subEpic) => {
      const child = mapEpicChild(subEpic);
      const subStatus = statusById.get(subEpic.statusId);
      if (subStatus) {
        child.status = subStatus.label;
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
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListAssignedEpicsTasksParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

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

    const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

    const epicsWithStatus = result.items.map((epic) => {
      const summary = mapEpicSummary(epic, agentNameById);
      const status = statusById.get(epic.statusId);
      if (status) {
        summary.status = status.label;
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

export async function handleCreateEpic(
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as CreateEpicParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

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

    const response: CreateEpicResponse = {
      id: epic.id,
      version: epic.version,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Epic creation requires full app context (not available in standalone MCP mode)',
        },
      };
    }
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
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetEpicByIdParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

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

  const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

  let parentSummary: EpicParentSummary | undefined;
  if (parentEpic) {
    parentSummary = mapEpicParent(parentEpic, agentNameById);
  }

  const epicSummary = mapEpicSummary(epic, agentNameById);
  const epicStatus = statusById.get(epic.statusId);
  if (epicStatus) {
    epicSummary.status = epicStatus.label;
  }

  const subEpicsWithStatus = subEpicsResult.items.map((child) => {
    const childSummary = mapEpicChild(child);
    const childStatus = statusById.get(child.statusId);
    if (childStatus) {
      childSummary.status = childStatus.label;
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
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as AddEpicCommentParams;

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

  try {
    const comment = await ctx.epicsService.addEpicComment(
      epicId,
      project.id,
      validated.content,
      authorActor.id,
      sessionCtx.type,
    );

    const response: AddEpicCommentResponse = {
      id: comment.id,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Epic comment creation requires full app context (not available in standalone MCP mode)',
        },
      };
    }
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${epicId} was not found.`,
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

export async function handleUpdateEpic(
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as UpdateEpicParams;

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
  let outcome: import('../../../epics/services/epics.service').UpdateEpicOutcome | undefined;
  try {
    const actor =
      sessionCtx.type === 'agent'
        ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
        : sessionCtx.type === 'guest'
          ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
          : null;

    const context: EpicOperationContext = { actor };

    const result = await ctx.epicsService.updateEpicWithOutcome(
      epicId,
      updateData,
      validated.version,
      context,
    );
    updatedEpic = result.epic;
    outcome = result.outcome;
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Epic updates require full app context (not available in standalone MCP mode)',
        },
      };
    }
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
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: {
          code: 'HIERARCHY_CONFLICT',
          message: error.message,
        },
      };
    }
    throw error;
  }

  const response: UpdateEpicResponse = {
    id: updatedEpic.id,
    version: updatedEpic.version,
  };

  if (
    sessionCtx.type === 'agent' &&
    sessionCtx.agent?.id &&
    outcome.statusChanged &&
    validated.assignment === undefined &&
    outcome.agentUnchanged &&
    outcome.previousAssigneeAgent?.id === sessionCtx.agent.id
  ) {
    response.hint = `CHECK REQUIRED: Epic moved to a new status while still assigned to ${outcome.previousAssigneeAgent.name}. Answer this before continuing — is this a handoff to another agent? If YES, call devchain_update_epic with assignment: { agentName: "Target Agent" } now. If NO, the current assignee remains and you may proceed. Do not skip this check.`;
  }

  return { success: true, data: response };
}

export async function handleDeleteEpic(
  ctx: EpicToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as DeleteEpicParams;

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

  try {
    const actor =
      sessionCtx.type === 'agent'
        ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
        : sessionCtx.type === 'guest'
          ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
          : null;
    const context: EpicOperationContext = { actor };
    await ctx.epicsService.deleteEpic(epicId, context);
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Epic deletion requires full app context (not available in standalone MCP mode)',
        },
      };
    }
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

  const response: DeleteEpicResponse = {
    id: epic.id,
    deleted: true,
  };

  return { success: true, data: response };
}
