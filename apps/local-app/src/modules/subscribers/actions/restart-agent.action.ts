import type { ActionDefinition, ActionContext, ActionResult } from './action.interface';

/**
 * Result data returned by the RestartAgent action.
 */
export interface RestartAgentResultData {
  /** The resolved agent ID that was restarted */
  resolvedAgentId: string;
  /** ID of the previous session (if one existed) */
  previousSessionId?: string;
  /** ID of the newly launched session */
  newSessionId: string;
  /** How the agent was resolved */
  resolvedBy: 'event' | 'agentName';
}

/**
 * RestartAgent Action
 * Restarts an agent by terminating any existing session and launching a fresh independent session.
 *
 * Agent resolution order:
 * 1. inputs.agentName (optional override; resolved to agentId within project)
 * 2. context.agentId (default from triggering event)
 *
 * The restart operation is serialized per agent using SessionCoordinatorService.withAgentLock()
 * to prevent race conditions when multiple events trigger restarts for the same agent.
 *
 * Use cases:
 * - Automated recovery from stuck sessions
 * - Corrupted terminal state recovery
 * - Provider reset scenarios
 */
export const restartAgentAction: ActionDefinition = {
  type: 'restart_agent',
  name: 'Restart Agent',
  description:
    'Restart an agent by terminating its session and launching a fresh independent session',
  category: 'session',

  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name (Override)',
      type: 'string',
      required: false,
      description:
        'Optional: Specify agent by name to restart a different agent. Leave empty to use the agent from the triggering event.',
      placeholder: 'e.g., Coder',
    },
  ],

  execute: async (
    context: ActionContext,
    inputs: Record<string, unknown>,
  ): Promise<ActionResult> => {
    const { sessionsService, storage, projectId, agentId: contextAgentId, logger } = context;

    // Extract inputs
    const inputAgentName = inputs.agentName as string | undefined;

    let resolvedAgentId: string | null = null;
    let resolvedAgentProjectId: string | null = null;
    let resolvedBy: 'event' | 'agentName' = 'event';

    try {
      // 1. Resolution order: agentName -> context.agentId
      if (inputAgentName && inputAgentName.trim()) {
        // Resolve agentName to agentId within the project
        try {
          const agent = await storage.getAgentByName(projectId, inputAgentName.trim());
          resolvedAgentId = agent.id;
          resolvedAgentProjectId = agent.projectId;
          resolvedBy = 'agentName';
          logger.debug({ agentName: inputAgentName, resolvedAgentId }, 'Resolved agent by name');
        } catch (error) {
          return {
            success: false,
            error: `Agent not found: "${inputAgentName}" in project ${projectId}`,
          };
        }
      } else if (contextAgentId) {
        // Fall back to context agentId from triggering event
        resolvedAgentId = contextAgentId;
        resolvedBy = 'event';
        logger.debug({ contextAgentId }, 'Using agent ID from event context');
      }

      // 2. Validate we have an agent to restart
      if (!resolvedAgentId) {
        return {
          success: false,
          error:
            'No agent specified: provide agentName input, or trigger from an event with agentId',
        };
      }

      // 3. Validate resolved agent belongs to this project (project safety)
      if (!resolvedAgentProjectId) {
        try {
          const agent = await storage.getAgent(resolvedAgentId);
          resolvedAgentProjectId = agent.projectId;
        } catch (error) {
          return {
            success: false,
            error: `Agent not found: "${resolvedAgentId}"`,
          };
        }
      }

      if (resolvedAgentProjectId !== projectId) {
        return {
          success: false,
          error: `Refusing to restart agent from a different project (agentProjectId=${resolvedAgentProjectId}, contextProjectId=${projectId})`,
        };
      }

      // 4. Perform restart
      // Note: launchSession() has internal withAgentLock for serialization.
      // No outer lock needed here - it would cause deadlock (nested non-reentrant locks).
      let previousSessionId: string | undefined;

      // Find active session for this agent
      // Pass projectId so listActiveSessions can filter to this project (extra safety)
      const activeSessions = await sessionsService.listActiveSessions(projectId);
      const existingSession = activeSessions.find((s) => s.agentId === resolvedAgentId);

      // Terminate existing session if found
      if (existingSession) {
        previousSessionId = existingSession.id;
        logger.info(
          { sessionId: existingSession.id, agentId: resolvedAgentId },
          'Terminating existing session before restart',
        );
        await sessionsService.terminateSession(existingSession.id);
      }

      // Launch new independent session (no epicId)
      // launchSession() is idempotent and handles its own locking internally
      logger.info({ agentId: resolvedAgentId }, 'Launching new independent session');
      const newSession = await sessionsService.launchSession({
        agentId: resolvedAgentId!,
        projectId,
        // epicId intentionally omitted for independent session
      });

      const result = {
        previousSessionId,
        newSessionId: newSession.id,
      };

      const resultData: RestartAgentResultData = {
        resolvedAgentId,
        previousSessionId: result.previousSessionId,
        newSessionId: result.newSessionId,
        resolvedBy,
      };

      logger.info(
        {
          resolvedAgentId,
          previousSessionId: result.previousSessionId,
          newSessionId: result.newSessionId,
          resolvedBy,
        },
        'Agent restarted successfully',
      );

      return {
        success: true,
        message: result.previousSessionId
          ? `Agent restarted: terminated session ${result.previousSessionId}, launched ${result.newSessionId}`
          : `Agent started: launched session ${result.newSessionId}`,
        data: resultData,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ resolvedAgentId, error: errorMessage }, 'Failed to restart agent');

      return {
        success: false,
        error: `Failed to restart agent: ${errorMessage}`,
      };
    }
  },
};
