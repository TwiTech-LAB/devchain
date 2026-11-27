import type { AgentPresence, AgentPresenceMap } from '@/ui/lib/sessions';
import { getTeamMembers } from './team-fold';

/** Why an online agent needs the user. A new reason needs no change to the dot component. */
export type AttentionReason = 'question';

export type DotState = 'waiting' | 'working' | 'idle' | 'offline';

export const DOT_STATE_WORDS: Record<DotState, string> = {
  waiting: 'waiting for your answer',
  working: 'working',
  idle: 'idle',
  offline: 'offline',
};

/** Summary order: the states that need the user come first. */
const SUMMARY_ORDER: DotState[] = ['waiting', 'working', 'idle', 'offline'];

export function getAttentionReasons(presence: AgentPresence | undefined): AttentionReason[] {
  return presence?.pendingQuestion === true ? ['question'] : [];
}

/**
 * The activity a dot shows: the provider turn state and its start time. An answer from a
 * server that does not send the turn fields falls back to the terminal activity. The two sources are never mixed:
 * the start time comes from the same source as the state.
 */
function getDotActivity(presence: AgentPresence): {
  state: 'idle' | 'busy' | null;
  busySince: string | null;
} {
  if (presence.turnActivityState != null) {
    return { state: presence.turnActivityState, busySince: presence.turnBusySince ?? null };
  }
  return { state: presence.activityState ?? null, busySince: presence.busySince ?? null };
}

/** First match wins. Returns null for a disabled agent, which gets no dot. */
export function getDotState(
  agent: { disabled?: boolean },
  presence: AgentPresence | undefined,
  reasons: AttentionReason[],
): DotState | null {
  if (agent.disabled === true) return null;
  if (!presence?.online) return 'offline';
  if (reasons.length > 0) return 'waiting';
  if (getDotActivity(presence).state === 'busy') return 'working';
  return 'idle';
}

export interface TeamDot {
  agentId: string;
  agentName: string;
  state: DotState;
  busySince: string | null;
}

/**
 * One dot per enabled member, in the given order. The lead gets no dot: its row is always
 * visible. A team with no lead shows all its agents.
 */
export function getTeamDots(
  agents: Array<{ id: string; name: string; disabled?: boolean }>,
  leadAgentId: string | null,
  agentPresence: AgentPresenceMap,
): TeamDot[] {
  const dots: TeamDot[] = [];
  for (const agent of getTeamMembers(agents, leadAgentId)) {
    const presence = agentPresence[agent.id];
    const state = getDotState(agent, presence, getAttentionReasons(presence));
    if (state === null) continue;
    dots.push({
      agentId: agent.id,
      agentName: agent.name,
      state,
      busySince: state === 'working' && presence ? getDotActivity(presence).busySince : null,
    });
  }
  return dots;
}

/** For example "Planning: 1 waiting, 1 working, 2 offline". States with no dot are left out. */
export function summarizeTeamDots(teamName: string, dots: TeamDot[]): string {
  const counts = SUMMARY_ORDER.map(
    (state) => [state, dots.filter((dot) => dot.state === state).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`);
  return counts.length > 0 ? `${teamName}: ${counts.join(', ')}` : teamName;
}

export function formatBusyDuration(busySince: string | null, now: number): string {
  const since = busySince ? new Date(busySince).getTime() : now;
  const ms = Math.max(0, now - since);
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m` : `${secs}s`;
}

export function describeDot(dot: TeamDot, now: number): string {
  const words = DOT_STATE_WORDS[dot.state];
  return dot.state === 'working' ? `${words} for ${formatBusyDuration(dot.busySince, now)}` : words;
}
