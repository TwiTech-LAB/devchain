import type { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import type { ActivityState } from '../../terminal/services/terminal-session/terminal-session';

export interface PresenceEntry {
  readonly online: boolean;
  readonly sessionId?: string;
  readonly activityState?: 'idle' | 'busy' | null;
  readonly lastActivityAt?: string | null;
  readonly busySince?: string | null;
}

export interface SessionAgentMapping {
  readonly sessionId: string;
  readonly agentId: string;
}

export function aggregatePresence(
  registry: TerminalSessionRegistry,
  sessionAgentMappings: SessionAgentMapping[],
  allAgentIds?: Set<string>,
): Map<string, PresenceEntry> {
  const presenceMap = new Map<string, PresenceEntry>();

  for (const mapping of sessionAgentMappings) {
    const session = registry.get(mapping.sessionId);
    if (!session) continue;

    const activity: ActivityState = session.getActivityState();
    const state = deriveActivityState(activity);

    presenceMap.set(mapping.agentId, {
      online: true,
      sessionId: mapping.sessionId,
      activityState: state,
      lastActivityAt: activity.lastDataAt ? new Date(activity.lastDataAt).toISOString() : null,
      busySince: activity.busySince ? new Date(activity.busySince).toISOString() : null,
    });
  }

  if (allAgentIds) {
    for (const agentId of allAgentIds) {
      if (!presenceMap.has(agentId)) {
        presenceMap.set(agentId, { online: false });
      }
    }
  }

  return presenceMap;
}

function deriveActivityState(activity: ActivityState): 'idle' | 'busy' | null {
  if (activity.busySince !== null) return 'busy';
  if (activity.idleSince !== null) return 'idle';
  return null;
}
