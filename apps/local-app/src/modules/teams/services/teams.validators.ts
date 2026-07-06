import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';

/**
 * The single set of team validation rules shared by createTeam and updateTeam.
 * Each rule has exactly one implementation here; the two call sites orchestrate
 * which rules run and in what order. updateTeam keeps its only-when-changed
 * gates at the call site — do NOT fold them in here, or a scoped update would
 * re-validate stale stored data.
 *
 * The three storage-backed rules take the lookup as a parameter so they stay
 * deterministic and runnable without dependency injection.
 */
export interface ProfileConfigSelection {
  profileId: string;
  configIds: string[];
}

export function validateMemberNonEmpty(members: string[]): void {
  if (members.length < 1) {
    throw new ValidationError('A team must have at least 1 member');
  }
}

export function validateLeadInMembers(teamLeadAgentId: string | null, members: string[]): void {
  if (teamLeadAgentId !== null && !members.includes(teamLeadAgentId)) {
    throw new ValidationError('Team lead must be included in the members list');
  }
}

export function validateConcurrentTasksCap(maxConcurrentTasks: number, maxMembers: number): void {
  if (maxConcurrentTasks > maxMembers) {
    throw new ValidationError('maxConcurrentTasks cannot exceed maxMembers');
  }
}

/**
 * The failure message is caller-supplied: create uses "Initial team exceeds
 * maxMembers", update uses "Team member count exceeds maxMembers". The two
 * diverge by design — keep both verbatim.
 */
export function validateMemberCapacity(
  members: string[],
  teamLeadAgentId: string | null,
  maxMembers: number,
  message: string,
): void {
  const nonLeadCount = members.filter((id) => id !== teamLeadAgentId).length;
  if (nonLeadCount > maxMembers) {
    throw new ValidationError(message);
  }
}

/**
 * First occurrence per profileId wins; configIds within each selection are
 * de-duplicated. Returns undefined only when nothing was supplied, so callers
 * can distinguish "not provided" from an explicit empty list.
 */
export function dedupeProfileConfigSelections(
  selections?: ProfileConfigSelection[],
): ProfileConfigSelection[] | undefined {
  if (!selections) return undefined;
  const seen = new Set<string>();
  const result: ProfileConfigSelection[] = [];
  for (const sel of selections) {
    if (seen.has(sel.profileId)) continue;
    seen.add(sel.profileId);
    result.push({ profileId: sel.profileId, configIds: [...new Set(sel.configIds)] });
  }
  return result;
}

export function validateSelectionsAgainstProfiles(
  selections: ProfileConfigSelection[],
  effectiveProfileIds: string[],
): void {
  const profileIdSet = new Set(effectiveProfileIds);
  for (const sel of selections) {
    if (!profileIdSet.has(sel.profileId)) {
      throw new ValidationError(
        `Config selection references profile "${sel.profileId}" which is not linked to this team`,
        { profileId: sel.profileId },
      );
    }
  }
}

export async function validateAgentsInProject(
  storage: StorageService,
  projectId: string,
  agentIds: string[],
): Promise<void> {
  for (const agentId of agentIds) {
    const agent = await storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ValidationError(`Agent "${agent.name}" belongs to a different project`, {
        agentId,
        expectedProjectId: projectId,
        actualProjectId: agent.projectId,
      });
    }
  }
}

export async function validateProfilesInProject(
  storage: StorageService,
  projectId: string,
  profileIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(profileIds)];
  for (const profileId of uniqueIds) {
    const profile = await storage.getAgentProfile(profileId);
    if (profile.projectId !== projectId) {
      throw new ValidationError(`Profile "${profile.name}" belongs to a different project`, {
        profileId,
        expectedProjectId: projectId,
        actualProjectId: profile.projectId,
      });
    }
  }
}

export async function validateConfigProfileConsistency(
  storage: StorageService,
  selections: ProfileConfigSelection[],
): Promise<void> {
  for (const sel of selections) {
    for (const configId of sel.configIds) {
      const config = await storage.getProfileProviderConfig(configId);
      if (config.profileId !== sel.profileId) {
        throw new ValidationError(
          `Config "${configId}" belongs to profile "${config.profileId}", not "${sel.profileId}"`,
          {
            configId,
            expectedProfileId: sel.profileId,
            actualProfileId: config.profileId,
          },
        );
      }
    }
  }
}
