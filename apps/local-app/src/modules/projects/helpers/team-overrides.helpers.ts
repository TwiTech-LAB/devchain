/**
 * Pure team-override merge + profile-name remap helper.
 *
 * Shared by both the project-import (replace-into-existing) and template-loader
 * (create-new) flows so the remap logic exists exactly once. Applies
 * `teamOverrides` onto the exported teams and remaps profile names through
 * `profileNameRemapMap`, re-resolving each remapped name against `resolvedProfiles`
 * to recover the target profile's original casing. When a remapped name has no
 * matching resolved profile, the pre-remap input name is returned unchanged.
 *
 * Pure: no storage access and no logging. Unknown-team override warnings are the
 * caller's responsibility (each call site logs them itself).
 */

/** A profile/config pairing attached to a team. */
export interface TeamProfileSelection {
  profileName: string;
  configNames: string[];
}

/** Per-team override entry; structurally matches both *InputLike teamOverrides. */
export interface TeamOverrideEntry {
  teamName: string;
  allowTeamLeadCreateAgents?: boolean;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  profileNames?: string[];
  profileSelections?: TeamProfileSelection[];
}

/** Shape of a team that can be override-merged and profile-remapped. */
export interface RemappableTeam {
  name: string;
  description?: string | null;
  teamLeadAgentName?: string | null;
  memberAgentNames: string[];
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  profileNames?: string[];
  profileSelections?: TeamProfileSelection[];
}

/**
 * Merge team overrides onto exported teams and remap profile names.
 *
 * Override precedence: any field present on an override (maxMembers,
 * maxConcurrentTasks, allowTeamLeadCreateAgents, profileNames, profileSelections)
 * replaces the team's own value; teams not referenced by an override pass through
 * with only profile-name remapping applied.
 *
 * @param teams             exported teams to merge onto
 * @param overrides         per-team overrides ( keyed case-insensitively by teamName )
 * @param profileNameRemapMap  maps a pre-substitution profile name (lowercase) to a
 *                            selected profile name (lowercase); when omitted no
 *                            remapping occurs
 * @param resolvedProfiles   the profiles that will actually be created, used to
 *                            recover the target profile's original casing after a
 *                            remap lookup
 * @returns a new array of teams with overrides applied. When there are no
 *          overrides and no remap map, the original `teams` reference is returned
 *          unchanged (fast path).
 */
export function applyTeamOverrides(
  teams: RemappableTeam[],
  overrides: TeamOverrideEntry[] | undefined,
  profileNameRemapMap: Map<string, string> | undefined,
  resolvedProfiles: ReadonlyArray<{ name: string }> | undefined,
): RemappableTeam[] {
  const hasOverrides = overrides !== undefined && overrides.length > 0;
  if (!hasOverrides && !profileNameRemapMap) return teams;

  const overrideMap = new Map<string, TeamOverrideEntry>();
  if (hasOverrides && overrides) {
    for (const override of overrides) {
      overrideMap.set(override.teamName.trim().toLowerCase(), override);
    }
  }

  const remapProfileName = (profileName: string): string => {
    if (!profileNameRemapMap) return profileName;
    const remapped = profileNameRemapMap.get(profileName.trim().toLowerCase());
    if (!remapped) return profileName;
    const match = resolvedProfiles?.find(
      (profile) => profile.name.trim().toLowerCase() === remapped,
    );
    return match?.name ?? profileName;
  };

  return teams.map((team) => {
    const override = overrideMap.get(team.name.trim().toLowerCase());

    const finalProfileNames =
      override?.profileNames !== undefined
        ? override.profileNames.map(remapProfileName)
        : team.profileNames?.map(remapProfileName);

    // Nullish-safe: an explicit `null` (or undefined) falls through to the team's
    // own value rather than crashing on `.map(null)`.
    const finalProfileSelections = override?.profileSelections
      ? override.profileSelections.map((selection) => ({
          ...selection,
          profileName: remapProfileName(selection.profileName),
        }))
      : team.profileSelections?.map((selection) => ({
          ...selection,
          profileName: remapProfileName(selection.profileName),
        }));

    return {
      ...team,
      ...(override?.maxMembers !== undefined ? { maxMembers: override.maxMembers } : {}),
      ...(override?.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: override.maxConcurrentTasks }
        : {}),
      ...(override?.allowTeamLeadCreateAgents !== undefined
        ? { allowTeamLeadCreateAgents: override.allowTeamLeadCreateAgents }
        : {}),
      ...(finalProfileNames !== undefined ? { profileNames: finalProfileNames } : {}),
      ...(finalProfileSelections !== undefined
        ? { profileSelections: finalProfileSelections }
        : {}),
    };
  });
}
