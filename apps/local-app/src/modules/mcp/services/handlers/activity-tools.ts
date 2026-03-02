import { BadRequestException } from '@nestjs/common';
import { ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ActivityStartParamsSchema,
  ActivityFinishParamsSchema,
  SessionContext,
} from '../../dtos/mcp.dto';
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

export async function handleActivityStart(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.chatService) {
    return {
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Chat service unavailable' },
    };
  }
  const validated = ActivityStartParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const project = sessionCtx.project;
  const agent = getActorFromContext(sessionCtx);

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'GUEST_ACTIVITY_NOT_ALLOWED',
        message: 'Guests cannot use activity tools.',
      },
    };
  }

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: 'No agent associated with this session',
      },
    };
  }

  const agentId = agent.id;

  let threadId = validated.threadId;
  if (threadId) {
    const thread = await ctx.chatService.getThread(threadId);
    const members = thread.members ?? [];
    if (!members.includes(agentId)) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_IN_THREAD',
          message: `Agent ${agent.name} is not a member of thread ${threadId}`,
        },
      };
    }
  } else {
    const direct = await ctx.chatService.createDirectThread({ projectId: project.id, agentId });
    threadId = direct.id;
  }

  const result = await ctx.chatService.startActivity(threadId, agentId, validated.title, {
    announce: validated.announce,
  });

  const response = {
    activity_id: result.activityId,
    thread_id: threadId,
    start_message_id: result.startMessageId,
    started_at: result.startedAt,
    auto_finished_prior: result.autoFinishedPrior,
  };
  return { success: true, data: response };
}

export async function handleActivityFinish(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  if (!ctx.chatService) {
    return {
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Chat service unavailable' },
    };
  }
  const validated = ActivityFinishParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const project = sessionCtx.project;
  const agent = getActorFromContext(sessionCtx);

  if (sessionCtx.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'GUEST_ACTIVITY_NOT_ALLOWED',
        message: 'Guests cannot use activity tools.',
      },
    };
  }

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: 'No agent associated with this session',
      },
    };
  }

  const agentId = agent.id;

  let threadId = validated.threadId;
  if (threadId) {
    const thread = await ctx.chatService.getThread(threadId);
    const members = thread.members ?? [];
    if (!members.includes(agentId)) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_IN_THREAD',
          message: `Agent ${agent.name} is not a member of thread ${threadId}`,
        },
      };
    }
  } else {
    const direct = await ctx.chatService.createDirectThread({ projectId: project.id, agentId });
    threadId = direct.id;
  }

  try {
    const result = await ctx.chatService.finishActivity(threadId, agentId, {
      message: validated.message,
      status: validated.status,
    });
    const response = {
      activity_id: result.activityId,
      thread_id: threadId,
      finish_message_id: result.finishMessageId,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
      status: result.status,
    };
    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof BadRequestException) {
      return {
        success: false,
        error: { code: 'NO_RUNNING_ACTIVITY', message: 'No running activity to finish' },
      };
    }
    throw error;
  }
}
