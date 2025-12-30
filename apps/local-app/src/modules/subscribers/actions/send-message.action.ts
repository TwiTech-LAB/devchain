import type { ActionDefinition, ActionContext, ActionResult } from './action.interface';

/**
 * SendAgentMessage Action
 * Sends text input to an agent's terminal session.
 *
 * This action uses the TerminalSendCoordinatorService to ensure proper timing
 * between messages and TmuxService to paste and submit the text.
 *
 * Features:
 * - Optional submit key (Enter or none)
 * - Bracketed paste mode for TUI compatibility
 * - Gap enforcement between messages to same agent
 *
 * Note: Delay before execution is handled by the subscriber-level delayMs setting
 * in Execution Options, not at the action level.
 */
export const sendMessageAction: ActionDefinition = {
  type: 'send_agent_message',
  name: 'Send Message to Agent',
  description: 'Send text input to the agent terminal session',
  category: 'terminal',

  inputs: [
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
    const { messagePoolService, sessionId, agentId, projectId, event, logger } = context;

    // Extract and validate inputs
    const text = inputs.text as string;
    const submitKey = (inputs.submitKey as string) || 'Enter';
    const immediate = (inputs.immediate as boolean) ?? false;

    if (!text || text.trim().length === 0) {
      return {
        success: false,
        error: 'Text is required',
      };
    }

    if (!agentId) {
      return {
        success: false,
        error: 'No agent ID available',
      };
    }

    try {
      // Determine submit keys based on submitKey input
      const submitKeys = submitKey === 'none' ? [] : ['Enter'];

      // Extract agentName from event payload if available (e.g., watcher events)
      const agentName = (event.payload?.agentName as string) ?? undefined;

      // Enqueue message to pool (or deliver immediately if flag is set)
      const result = await messagePoolService.enqueue(agentId, text, {
        source: 'subscriber.action',
        submitKeys,
        immediate,
        projectId,
        agentName,
      });

      if (result.status === 'failed') {
        logger.error({ sessionId, error: result.error }, 'Failed to enqueue message');
        return {
          success: false,
          error: `Failed to send message: ${result.error}`,
        };
      }

      logger.info(
        {
          sessionId,
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
            ? `Message queued for session ${sessionId}`
            : `Message sent to session ${sessionId}`,
        data: {
          sessionId,
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
