import type { Agent } from '../../storage/models/domain.models';
import type { ActionContext, ActionDefinition, ActionResult } from './action.interface';
import { resolveFamilyAgentTargets } from './family-agent-targets';
import {
  STATUS_GUARD_INPUT_NAME,
  describeUnknownLabels,
  resolveStatusGuard,
  skippedResult,
  statusGuardInput,
} from './epic-status-guard';

export interface DeleteAgentTargetResult {
  id: string;
  name: string;
}

export interface DeleteAgentFailure extends DeleteAgentTargetResult {
  stage: 'preflight' | 'session_termination' | 'deletion' | 'preset_cleanup';
  error: string;
}

export interface DeleteAgentResultData {
  resolvedBy: 'agentName' | 'familySlug' | 'event';
  matched: DeleteAgentTargetResult[];
  deleted: DeleteAgentTargetResult[];
  failed: DeleteAgentFailure[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function describeTarget(target: DeleteAgentTargetResult): string {
  return `"${target.name}" [${target.id}]`;
}

function describeTargets(targets: DeleteAgentTargetResult[]): string {
  return targets.length > 0 ? targets.map(describeTarget).join(', ') : 'none';
}

function summarize(data: DeleteAgentResultData): string {
  const failed =
    data.failed.length > 0
      ? data.failed.map((target) => `${describeTarget(target)} — ${target.error}`).join(', ')
      : 'none';
  return `Matched (${data.matched.length}): ${describeTargets(data.matched)}; Deleted (${data.deleted.length}): ${describeTargets(data.deleted)}; Failed (${data.failed.length}): ${failed}`;
}

function failedResult(data: DeleteAgentResultData, reason?: string): ActionResult {
  const summary = summarize(data);
  return {
    success: false,
    error: reason ? `${summary}. ${reason}` : summary,
    data,
    retryable: false,
  };
}

function toTargetResult(agent: Agent): DeleteAgentTargetResult {
  return { id: agent.id, name: agent.name };
}

export const deleteAgentAction: ActionDefinition = {
  type: 'delete_agent',
  name: 'Delete Agent',
  description:
    'Permanently delete an agent or profile-family batch. Project Owners and Team Leads are protected.',
  category: 'session',
  supportsRetry: false,
  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name',
      type: 'string',
      required: false,
      description:
        'Optional: delete one named agent in the current project. This takes priority over Family Slug. Leave both selectors empty to use the agent that caused the event.',
      placeholder: 'e.g., Coder',
    },
    {
      name: 'familySlug',
      label: 'Profile Family Slug',
      type: 'string',
      required: false,
      description:
        'Optional: delete every agent in matching profile families in the current project. Matching is case-insensitive; Agent Name takes priority. Leave both selectors empty to use the agent that caused the event.',
      placeholder: 'e.g., engineering',
    },
    statusGuardInput,
  ],

  execute: async (
    context: ActionContext,
    inputs: Record<string, unknown>,
  ): Promise<ActionResult> => {
    const { storage, teamsService, sessionsService, projectId, agentId, logger } = context;
    const agentName = typeof inputs.agentName === 'string' ? inputs.agentName.trim() : '';
    const familySlug = typeof inputs.familySlug === 'string' ? inputs.familySlug.trim() : '';
    let resolvedBy: DeleteAgentResultData['resolvedBy'] = 'event';
    let targets: Agent[] = [];

    try {
      const guard = await resolveStatusGuard(storage, projectId, inputs[STATUS_GUARD_INPUT_NAME]);
      if (!guard.ok) {
        return failedResult(
          { resolvedBy, matched: [], deleted: [], failed: [] },
          describeUnknownLabels(projectId, guard.unknownLabels),
        );
      }
      if (guard.blocking.length > 0) {
        return skippedResult(guard.blocking);
      }

      if (agentName) {
        resolvedBy = 'agentName';
        const target = await storage.getAgentByName(projectId, agentName);
        if (target.projectId !== projectId) {
          return failedResult(
            { resolvedBy, matched: [], deleted: [], failed: [] },
            `Refusing to delete agent from a different project (agentProjectId=${target.projectId}, contextProjectId=${projectId})`,
          );
        }
        targets = [target];
      } else if (familySlug) {
        resolvedBy = 'familySlug';
        targets = await resolveFamilyAgentTargets(storage, projectId, familySlug);
      } else if (agentId) {
        const target = await storage.getAgent(agentId);
        if (target.projectId !== projectId) {
          return failedResult(
            { resolvedBy, matched: [], deleted: [], failed: [] },
            `Refusing to delete event agent from a different project (agentProjectId=${target.projectId}, contextProjectId=${projectId})`,
          );
        }
        targets = [target];
      } else {
        return failedResult(
          { resolvedBy, matched: [], deleted: [], failed: [] },
          'No agent matched: provide Agent Name or Family Slug, or trigger from an event with agentId',
        );
      }

      const matched = targets.map(toTargetResult);
      const baseData: DeleteAgentResultData = { resolvedBy, matched, deleted: [], failed: [] };

      if (targets.length === 0) {
        const selector = resolvedBy === 'familySlug' ? `family slug "${familySlug}"` : 'selector';
        return failedResult(baseData, `No agents matched ${selector} in project ${projectId}`);
      }

      const ledTeamsByAgent = await Promise.all(
        targets.map(async (target) => ({
          target,
          ledTeams: await teamsService.listTeamsLedByAgent(target.id),
        })),
      );
      const protectedFailures: DeleteAgentFailure[] = [];
      for (const { target, ledTeams } of ledTeamsByAgent) {
        const reasons: string[] = [];
        if (target.isProjectOwner) {
          reasons.push('protected Project Owner');
        }
        const sortedLedTeams = [...ledTeams].sort((left, right) => compareText(left.id, right.id));
        if (sortedLedTeams.length > 0) {
          reasons.push(
            `protected Team Lead of "${sortedLedTeams[0].name}" [${sortedLedTeams[0].id}]`,
          );
        }
        if (reasons.length > 0) {
          protectedFailures.push({
            ...toTargetResult(target),
            stage: 'preflight',
            error: reasons.join('; '),
          });
        }
      }

      if (protectedFailures.length > 0) {
        return failedResult({ ...baseData, failed: protectedFailures });
      }

      const targetIds = new Set(targets.map((target) => target.id));
      const activeSessions = await sessionsService.listActiveSessions(projectId, targetIds);
      const deleted: DeleteAgentTargetResult[] = [];
      const failed: DeleteAgentFailure[] = [];

      for (const target of targets) {
        const targetResult = toTargetResult(target);
        const targetSessions = activeSessions
          .filter((session) => session.agentId === target.id)
          .sort((left, right) => compareText(left.id, right.id));
        const terminationErrors: string[] = [];

        for (const session of targetSessions) {
          try {
            await sessionsService.terminateSession(session.id, {
              source: 'subscriber',
              reason: 'agent-deletion',
            });
          } catch (error) {
            terminationErrors.push(`session ${session.id}: ${getErrorMessage(error)}`);
          }
        }

        if (terminationErrors.length > 0) {
          failed.push({
            ...targetResult,
            stage: 'session_termination',
            error: `session termination failed (${terminationErrors.join('; ')})`,
          });
          continue;
        }

        try {
          const deletionResult = await teamsService.deleteAgentForAutomation({
            projectId,
            agentId: target.id,
          });
          deleted.push(targetResult);
          if (deletionResult?.presetCleanupError) {
            failed.push({
              ...targetResult,
              stage: 'preset_cleanup',
              error: `agent deleted, but project preset cleanup failed (${deletionResult.presetCleanupError})`,
            });
          }
        } catch (error) {
          failed.push({
            ...targetResult,
            stage: 'deletion',
            error: `deletion failed (${getErrorMessage(error)})`,
          });
        }
      }

      const data: DeleteAgentResultData = { resolvedBy, matched, deleted, failed };
      if (failed.length > 0) {
        logger.error({ projectId, data }, 'Delete Agent action completed with failures');
        return failedResult(data);
      }

      logger.info({ projectId, data }, 'Delete Agent action completed');
      return {
        success: true,
        message: summarize(data),
        data,
        retryable: false,
      };
    } catch (error) {
      const data: DeleteAgentResultData = {
        resolvedBy,
        matched: targets.map(toTargetResult),
        deleted: [],
        failed: [],
      };
      const errorMessage = getErrorMessage(error);
      logger.error({ projectId, error: errorMessage }, 'Delete Agent action failed');
      return failedResult(data, `Delete Agent failed: ${errorMessage}`);
    }
  },
};
