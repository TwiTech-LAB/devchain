import { NotFoundError } from '../../../../../common/errors/error-types';
import type { AgentStorage, GuestStorage } from '../../../../storage/interfaces/storage.interface';

export interface ResolvedRecipient {
  type: 'agent' | 'guest';
  id: string;
  name: string;
  tmuxSessionId?: string;
}

type StorageContext = { storage: AgentStorage & GuestStorage };

export async function resolveRecipientByName(
  ctx: StorageContext,
  projectId: string,
  name: string,
): Promise<ResolvedRecipient | null> {
  try {
    const agent = await ctx.storage.getAgentByName(projectId, name);
    return {
      type: 'agent',
      id: agent.id,
      name: agent.name,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }

  const guest = await ctx.storage.getGuestByName(projectId, name);
  if (guest) {
    return {
      type: 'guest',
      id: guest.id,
      name: guest.name,
      tmuxSessionId: guest.tmuxSessionId,
    };
  }

  return null;
}

export async function getAvailableRecipientNames(
  ctx: StorageContext,
  projectId: string,
): Promise<string[]> {
  const [agentsResult, guests] = await Promise.all([
    ctx.storage.listAgents(projectId, { limit: 100, offset: 0 }),
    ctx.storage.listGuests(projectId),
  ]);

  const agentNames = agentsResult.items.map((a) => a.name);
  const guestNames = guests.map((g) => `${g.name} (guest)`);

  return [...agentNames, ...guestNames];
}
