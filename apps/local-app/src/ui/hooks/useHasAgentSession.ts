import { useQueryClient } from '@tanstack/react-query';
import type { AgentPresenceMap } from '@/ui/lib/sessions';

/**
 * Lightweight selector backed by react-query cache to determine if an agent has a running session.
 * Returns true when presence[agentId] exists with online=true and a non-empty sessionId.
 */
export function useHasAgentSession(
  projectId: string | null | undefined,
  agentId: string | null | undefined,
) {
  const qc = useQueryClient();
  if (!projectId || !agentId) return false;
  const map = qc.getQueryData(['agent-presence', projectId]) as AgentPresenceMap | undefined;
  if (!map) return false;
  const p = map[agentId];
  return Boolean(p && p.online && p.sessionId);
}
