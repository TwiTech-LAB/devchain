import type { Agent } from '../../storage/models/domain.models';
import type { SessionDto } from '../../sessions/dtos/sessions.dto';
import type { ActionContext, ActionDefinition, ActionResult } from './action.interface';
import { resolveFamilyAgentTargets } from './family-agent-targets';
import {
  STATUS_GUARD_INPUT_NAME,
  describeUnknownLabels,
  resolveStatusGuard,
  skippedResult,
  statusGuardInput,
} from './epic-status-guard';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Result data returned by the TerminateSession action.
 */
export interface TerminateSessionResultData {
  /** How the target session was resolved */
  resolvedBy: 'event' | 'agentName';
  /** ID of the terminated session */
  sessionId: string;
  /** ID of the agent that owned the terminated session */
  resolvedAgentId: string;
  /** Session status observed before termination was requested */
  previousStatus: SessionDto['status'];
}

export interface TerminateSessionFamilyTargetResult {
  id: string;
  name: string;
}

export interface TerminateSessionFamilyTermination extends TerminateSessionFamilyTargetResult {
  sessionId: string;
  previousStatus: SessionDto['status'];
}

export interface TerminateSessionFamilyFailure extends TerminateSessionFamilyTermination {
  error: string;
}

export interface TerminateSessionFamilyResultData {
  resolvedBy: 'familySlug';
  matched: TerminateSessionFamilyTargetResult[];
  terminated: TerminateSessionFamilyTermination[];
  inactive: TerminateSessionFamilyTargetResult[];
  failed: TerminateSessionFamilyFailure[];
}

type TerminateSessionTargetMode = TerminateSessionResultData['resolvedBy'] | 'familySlug';

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function describeTarget(target: TerminateSessionFamilyTargetResult): string {
  return `"${target.name}" [${target.id}]`;
}

function describeTargets(targets: TerminateSessionFamilyTargetResult[]): string {
  return targets.length > 0 ? targets.map(describeTarget).join(', ') : 'none';
}

function describeFamilyResult(data: TerminateSessionFamilyResultData): string {
  const failed =
    data.failed.length > 0
      ? data.failed
          .map(
            (target) => `${describeTarget(target)} session ${target.sessionId} — ${target.error}`,
          )
          .join(', ')
      : 'none';
  return `Matched (${data.matched.length}): ${describeTargets(data.matched)}; Terminated (${data.terminated.length}): ${describeTargets(data.terminated)}; Inactive (${data.inactive.length}): ${describeTargets(data.inactive)}; Failed (${data.failed.length}): ${failed}`;
}

function getTargetMode(agentName: string, familySlug: string): TerminateSessionTargetMode {
  if (agentName) return 'agentName';
  if (familySlug) return 'familySlug';
  return 'event';
}

async function terminateFamilySessions(
  context: ActionContext,
  familySlug: string,
): Promise<ActionResult> {
  const { sessionsService, storage, projectId, logger } = context;
  const targets = await resolveFamilyAgentTargets(storage, projectId, familySlug);
  const data: TerminateSessionFamilyResultData = {
    resolvedBy: 'familySlug',
    matched: targets.map(({ id, name }) => ({ id, name })),
    terminated: [],
    inactive: [],
    failed: [],
  };

  if (targets.length === 0) {
    return {
      success: false,
      error: `${describeFamilyResult(data)}. No agents matched family slug "${familySlug}" in project ${projectId}`,
      data,
      retryable: false,
    };
  }

  const targetIds = new Set(targets.map((target) => target.id));
  const activeSessions = await sessionsService.listActiveSessions(projectId, targetIds);

  for (const target of targets) {
    const sessions = activeSessions
      .filter((session) => session.agentId === target.id)
      .sort((left, right) => compareText(left.id, right.id));

    if (sessions.length === 0) {
      data.inactive.push({ id: target.id, name: target.name });
      continue;
    }

    for (const session of sessions) {
      const result = {
        id: target.id,
        name: target.name,
        sessionId: session.id,
        previousStatus: session.status,
      };
      try {
        await sessionsService.terminateSession(session.id, {
          source: 'subscriber',
          reason: 'user-requested',
        });
        data.terminated.push(result);
      } catch (error) {
        data.failed.push({ ...result, error: getErrorMessage(error) });
      }
    }
  }

  const summary = describeFamilyResult(data);
  if (data.failed.length > 0) {
    logger.error({ projectId, data }, 'Family session termination completed with failures');
    return { success: false, error: summary, data, retryable: false };
  }

  logger.info({ projectId, data }, 'Family sessions terminated successfully');
  return { success: true, message: summary, data, retryable: false };
}

/**
 * TerminateSession Action
 * Terminates sessions inside the current project without deleting any agent.
 *
 * Target resolution order:
 * 1. inputs.agentName (optional override; resolved to that agent's active session within the project)
 * 2. inputs.familySlug (all matching profile-family agents in the project)
 * 3. context.sessionId (default: the session that triggered the event, validated against the project)
 *
 * The event path accepts a session in any status; termination of an exact
 * session is idempotent. The agentName path requires a currently running
 * session, so the overall action is not idempotent when retried by name.
 */
export const terminateSessionAction: ActionDefinition = {
  type: 'terminate_session',
  name: 'Terminate Session',
  description:
    'Terminate project sessions by Agent Name, Profile Family Slug, or triggering event session, in that priority. Inactive family agents are reported without failure. Does not delete agents.',
  category: 'session',

  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name (Override)',
      type: 'string',
      required: false,
      description:
        'Optional: terminate the active session of this named agent in the current project. Takes priority over Profile Family Slug. Leave both selectors empty to terminate the session that triggered the event.',
      placeholder: 'e.g., Coder',
    },
    {
      name: 'familySlug',
      label: 'Profile Family Slug',
      type: 'string',
      required: false,
      description:
        'Optional: terminate active sessions for every matching profile-family agent in the current project. Inactive agents are reported, not failed. Agent Name takes priority. Family failures are not automatically retried, even when Retry on error is enabled.',
      placeholder: 'e.g., engineering',
    },
    statusGuardInput,
  ],

  execute: async (
    context: ActionContext,
    inputs: Record<string, unknown>,
  ): Promise<ActionResult> => {
    const { sessionsService, storage, projectId, sessionId: contextSessionId, logger } = context;
    const agentName = typeof inputs.agentName === 'string' ? inputs.agentName.trim() : '';
    const familySlug = typeof inputs.familySlug === 'string' ? inputs.familySlug.trim() : '';
    const targetMode = getTargetMode(agentName, familySlug);
    let targetSession: SessionDto;

    try {
      const guard = await resolveStatusGuard(storage, projectId, inputs[STATUS_GUARD_INPUT_NAME]);
      if (!guard.ok) {
        return {
          success: false,
          error: describeUnknownLabels(projectId, guard.unknownLabels),
          retryable: false,
        };
      }
      if (guard.blocking.length > 0) {
        return skippedResult(guard.blocking);
      }

      if (targetMode === 'agentName') {
        let agent: Agent;
        try {
          agent = await storage.getAgentByName(projectId, agentName);
        } catch {
          return {
            success: false,
            error: `Agent not found: "${agentName}" in project ${projectId}`,
          };
        }

        if (agent.projectId !== projectId) {
          return {
            success: false,
            error: `Refusing to terminate session of agent from a different project (agentProjectId=${agent.projectId}, contextProjectId=${projectId})`,
          };
        }

        const activeSession = sessionsService.getActiveSessionForAgent(agent.id);
        if (!activeSession) {
          return {
            success: false,
            error: `Agent "${agentName}" [${agent.id}] has no active session`,
          };
        }
        targetSession = activeSession;
        logger.debug(
          { agentName, sessionId: activeSession.id },
          'Resolved active session by agent name',
        );
      } else if (targetMode === 'familySlug') {
        const familyResult = await terminateFamilySessions(context, familySlug);
        return familyResult;
      } else {
        if (!contextSessionId) {
          return {
            success: false,
            error: 'No session to terminate: event context has no sessionId',
          };
        }
        try {
          targetSession = await sessionsService.validateSessionInProject(
            contextSessionId,
            projectId,
          );
        } catch (error) {
          return {
            success: false,
            error: `Event session rejected: ${getErrorMessage(error)}`,
          };
        }
      }

      const { id: sessionId, agentId, status: previousStatus } = targetSession;
      const resolvedAgentId = agentId!;
      await sessionsService.terminateSession(sessionId, {
        source: 'subscriber',
        reason: 'user-requested',
      });

      const resultData: TerminateSessionResultData = {
        resolvedBy: targetMode,
        sessionId,
        resolvedAgentId,
        previousStatus,
      };

      logger.info(
        {
          sessionId,
          resolvedAgentId,
          resolvedBy: targetMode,
          previousStatus,
        },
        'Session terminated successfully',
      );

      return {
        success: true,
        message: `Session ${sessionId} terminated (previous status: ${previousStatus})`,
        data: resultData,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error({ resolvedBy: targetMode, error: errorMessage }, 'Failed to terminate session');

      return {
        success: false,
        error: `Failed to terminate session: ${errorMessage}`,
        ...(targetMode === 'familySlug' ? { retryable: false } : {}),
      };
    }
  },
};
