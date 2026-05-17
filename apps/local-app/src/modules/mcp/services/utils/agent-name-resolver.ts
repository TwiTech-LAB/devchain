import { createLogger } from '../../../../common/logging/logger';
import type { AgentStorage } from '../../../storage/interfaces/storage.interface';

const logger = createLogger('McpService');

export async function resolveAgentNames(
  storage: AgentStorage,
  ids: Set<string>,
): Promise<Map<string, string>> {
  const agentNameById = new Map<string, string>();

  if (ids.size === 0) return agentNameById;

  const results = await Promise.all(
    Array.from(ids).map(async (agentId) => {
      try {
        const agent = await storage.getAgent(agentId);
        return [agentId, agent.name] as const;
      } catch {
        logger.warn({ agentId }, 'Failed to resolve agent name');
        return null;
      }
    }),
  );

  for (const result of results) {
    if (result) {
      agentNameById.set(result[0], result[1]);
    }
  }

  return agentNameById;
}
