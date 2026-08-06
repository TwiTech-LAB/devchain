import type { ActionDefinition, ActionContext, ActionResult } from './action.interface';

/**
 * SendAgentMessage Action
 * Sends text input to an agent's terminal session.
 *
 * Uses TerminalIOService to paste and submit text to the agent's terminal.
 *
 * Features:
 * - Optional agent-name override within the event project
 * - Optional submit key (Enter or none)
 * - Bracketed paste mode for TUI compatibility
 *
 * Note: Delay before execution is handled by the subscriber-level delayMs setting
 * in Execution Options, not at the action level.
 */
export const sendMessageAction: ActionDefinition = {
  type: 'send_agent_message',
  name: 'Send Message to Agent',
  description: 'Send text input to an agent terminal session',
  category: 'terminal',

  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name (Override)',
      type: 'string',
      required: false,
      description:
        'Optional: Send to a different agent in this project. Leave empty to use the agent from the triggering event.',
      placeholder: 'e.g., Planner',
    },
    {
      name: 'text',
      label: 'Message Text',
      type: 'textarea',
      required: true,
      description: 'Text to send to the terminal',
      placeholder: '/compact',
      maxLength: 10000,
    },
    {
      name: 'submitKey',
      label: 'Submit Key',
      type: 'select',
      required: false,
      description: 'Key to press after pasting text',
      defaultValue: 'Enter',
      options: [
        { value: 'Enter', label: 'Enter (submit)' },
        { value: 'none', label: 'None (paste only)' },
      ],
      allowedSources: ['custom'], // Submit key should be a static choice, not event-driven
    },
    {
      name: 'immediate',
      label: 'Deliver Immediately',
      type: 'boolean',
      required: false,
      defaultValue: false,
      description: 'Bypass message pooling and deliver instantly (use for commands like /compact)',
      allowedSources: ['custom'],
    },
  ],

  execute: async (
    context: ActionContext,
    inputs: Record<string, unknown>,
  ): Promise<ActionResult> => {
    const { amd, storage, sessionId, agentId, projectId, event, logger } = context;

    // Extract and validate inputs
    const text = inputs.text as string;
    const inputAgentName = typeof inputs.agentName === 'string' ? inputs.agentName.trim() : '';
    const submitKey = (inputs.submitKey as string) || 'Enter';
    const immediate = (inputs.immediate as boolean) ?? false;

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: 'Text is required',
      };
    }

    try {
      let resolvedAgentId = agentId;
      let resolvedBy: 'event' | 'agentName' = 'event';

      if (inputAgentName) {
        try {
          const agent = await storage.getAgentByName(projectId, inputAgentName);
          if (agent.projectId !== projectId) {
            return {
              success: false,
              error: `Refusing to message agent from a different project (agentProjectId=${agent.projectId}, contextProjectId=${projectId})`,
            };
          }
          resolvedAgentId = agent.id;
          resolvedBy = 'agentName';
          logger.debug(
            { agentName: inputAgentName, resolvedAgentId },
            'Resolved message recipient by name',
          );
        } catch {
          return {
            success: false,
            error: `Agent not found: "${inputAgentName}" in project ${projectId}`,
          };
        }
      }

      if (!resolvedAgentId) {
        return {
          success: false,
          error:
            'No recipient specified: provide agentName input, or trigger from an event with agentId',
        };
      }

      // Determine submit keys based on submitKey input
      const submitKeys = submitKey === 'none' ? [] : ['Enter'];

      // Extract agentName from event payload if available (e.g., watcher events)
      const agentName = (event.payload?.agentName as string) ?? undefined;

      const result = await amd.deliver(
        [resolvedAgentId],
        {
          kind: 'pooled',
          body: text,
          source: 'subscriber.action',
          projectId,
          senderName: agentName ?? 'Subscriber Action',
        },
        {
          submitKeys,
          immediate,
        },
      );

      const failed = result.results.find((recipientResult) => recipientResult.status === 'failed');
      if (failed || result.status === 'failed') {
        const error = failed?.error;
        logger.error({ sessionId, resolvedAgentId, error }, 'Failed to deliver message');
        return {
          success: false,
          error: `Failed to send message: ${error ?? 'delivery failed'}`,
        };
      }

      logger.info(
        {
          sessionId,
          resolvedAgentId,
          resolvedBy,
          textLength: text.length,
          submitKey,
          immediate,
          status: result.status,
        },
        result.status === 'queued' ? 'Message enqueued to pool' : 'Message sent to terminal',
      );

      return {
        success: true,
        message:
          result.status === 'queued'
            ? `Message queued for agent ${resolvedAgentId}`
            : `Message sent to agent ${resolvedAgentId}`,
        data: {
          sessionId,
          resolvedAgentId,
          resolvedBy,
          textLength: text.length,
          submitKey,
          immediate,
          status: result.status,
        },
      };
    } catch (error) {
      logger.error({ sessionId, error: String(error) }, 'Failed to send message');

      return {
        success: false,
        error: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
