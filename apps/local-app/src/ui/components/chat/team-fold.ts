import type { AgentPresenceMap } from '@/ui/lib/sessions';

/**
 * User's manual fold choice for one team. It holds only while the team's
 * `hasActive` still equals `whenActive`; once they differ the team follows the
 * automatic state again.
 */
export interface TeamFoldOverride {
  collapsed: boolean;
  whenActive: boolean;
}

export type TeamFoldOverrides = Record<string, TeamFoldOverride>;

export const TEAM_FOLD_OVERRIDES_KEY = 'devchain:chatSidebar:teamFoldOverrides';
const LEGACY_TEAM_GROUPS_KEY = 'devchain:chatSidebar:teamGroups';

/** Team agents minus the lead; all agents when the team has no lead among them. */
export function getTeamMembers<T extends { id: string }>(
  teamAgents: T[],
  teamLeadAgentId: string | null,
): T[] {
  const hasLead = teamLeadAgentId !== null && teamAgents.some((a) => a.id === teamLeadAgentId);
  return hasLead ? teamAgents.filter((a) => a.id !== teamLeadAgentId) : teamAgents;
}

export function hasActiveMember(
  members: Array<{ id: string }>,
  agentPresence: AgentPresenceMap,
): boolean {
  return members.some((member) => agentPresence[member.id]?.online === true);
}

export function isTeamCollapsed(
  hasActive: boolean,
  override: TeamFoldOverride | undefined,
): boolean {
  if (override && override.whenActive === hasActive) return override.collapsed;
  return !hasActive;
}

function readStoredOverrides(): TeamFoldOverrides {
  try {
    const stored = window.localStorage.getItem(TEAM_FOLD_OVERRIDES_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: TeamFoldOverrides = {};
    for (const [teamId, value] of Object.entries(parsed)) {
      const v = value as Partial<TeamFoldOverride> | null;
      if (v && typeof v.collapsed === 'boolean' && typeof v.whenActive === 'boolean') {
        result[teamId] = { collapsed: v.collapsed, whenActive: v.whenActive };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function loadTeamFoldOverrides(): TeamFoldOverrides {
  if (typeof window === 'undefined') return {};
  try {
    window.localStorage.removeItem(LEGACY_TEAM_GROUPS_KEY);
  } catch {
    // Storage unavailable: readStoredOverrides falls back to an empty map.
  }
  return readStoredOverrides();
}

/**
 * Sets (or, with `null`, deletes) one team's stored override. Every open tab
 * shares the stored map, so the write starts from the map in storage now, not
 * from this tab's copy, and keeps the entries other tabs wrote.
 */
export function saveTeamFoldOverride(teamId: string, override: TeamFoldOverride | null): void {
  if (typeof window === 'undefined') return;
  const stored = readStoredOverrides();
  if (override) stored[teamId] = override;
  else delete stored[teamId];
  try {
    window.localStorage.setItem(TEAM_FOLD_OVERRIDES_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or unavailable: the fold still applies for this page's lifetime.
  }
}
