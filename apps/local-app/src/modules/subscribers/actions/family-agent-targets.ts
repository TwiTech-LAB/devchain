import type { Agent } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';

export type FamilyAgentTargetsStorage = Pick<StorageService, 'listAgentProfiles' | 'listAgents'>;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Resolve every agent in one project whose profile carries the given family slug.
 * Slugs compare case-insensitively after trimming. The 10k list window is the
 * resolved contract; callers that outgrow it must page, not widen silently.
 * Returns agents sorted by normalized name then ID with duplicates removed;
 * an empty array means no profile matched — failure policy belongs to callers.
 */
export async function resolveFamilyAgentTargets(
  storage: FamilyAgentTargetsStorage,
  projectId: string,
  familySlug: string,
): Promise<Agent[]> {
  const normalizedSlug = normalize(familySlug);
  const [profilesResult, agentsResult] = await Promise.all([
    storage.listAgentProfiles({ projectId, limit: 10_000, offset: 0 }),
    storage.listAgents(projectId, { limit: 10_000, offset: 0 }),
  ]);
  const matchingProfileIds = new Set(
    profilesResult.items
      .filter(
        (profile) =>
          typeof profile.familySlug === 'string' &&
          normalize(profile.familySlug) === normalizedSlug,
      )
      .map((profile) => profile.id),
  );
  const targetsById = new Map<string, Agent>();
  for (const agent of agentsResult.items) {
    if (matchingProfileIds.has(agent.profileId)) {
      targetsById.set(agent.id, agent);
    }
  }
  return [...targetsById.values()].sort((left, right) => {
    const nameOrder = compareText(normalize(left.name), normalize(right.name));
    return nameOrder === 0 ? compareText(left.id, right.id) : nameOrder;
  });
}
