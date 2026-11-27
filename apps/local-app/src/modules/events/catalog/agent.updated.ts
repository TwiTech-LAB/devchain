import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('AgentUpdatedEvent');

export const agentUpdatedEvent = {
  name: 'agent.updated' as const,
  schema: z.object({
    agentId: z.string().min(1),
    projectId: z.string().min(1),
  }),
};

export type AgentUpdatedEventPayload = z.infer<typeof agentUpdatedEvent.schema>;

/** The `EventsService.publish` call that `publishAgentsUpdated` needs. */
interface AgentUpdatedPublisher {
  publish(name: 'agent.updated', payload: AgentUpdatedEventPayload): Promise<unknown>;
}

/**
 * Publish `agent.updated` once for each agent id, in order. A failed publish is logged and never
 * fails the agent write that came before it.
 */
export async function publishAgentsUpdated(
  events: AgentUpdatedPublisher | null | undefined,
  projectId: string,
  agentIds: Iterable<string>,
): Promise<void> {
  if (!events) return;
  for (const agentId of agentIds) {
    try {
      await events.publish(agentUpdatedEvent.name, { agentId, projectId });
    } catch (error) {
      logger.error({ agentId, projectId, error }, 'Failed to publish agent.updated event');
    }
  }
}
