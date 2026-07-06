/**
 * Teams codec — owns the `teams` section.
 *
 * Apply composes the three legacy steps that the orchestrator used to run inline:
 *  1. `applyTeamOverrides` (the shared Task-2 pure helper) — merge `teamOverrides` onto the
 *     exported teams and remap profile names through the family-selection map;
 *  2. `pruneUnavailableTeamProfileSelections` — drop config selections whose provider was
 *     filtered out, keeping genuine template typos so strict import still surfaces them;
 *  3. create each team, resolving member/lead/profile/config references through the
 *     ImportContext maps written by the profiles + agents codecs (`agentNameToId`,
 *     `profileNameToId`, `configLookupMap`) — NOT live storage queries, because in both
 *     pipeline modes the only agents/profiles/configs that exist are the ones those codecs
 *     just created, so the context maps are an exact equivalent (and make the dependency
 *     declared, not implicit).
 *
 * Mode-conditional fatality (matrix row 13): replace = FATAL with scoped cleanup (teams
 * created this run are deleted before re-throwing, so no partial-orphan teams survive);
 * create = NON-FATAL (declared `onFailure: { replace: 'fatal', create: 'swallow' }` — the
 * pipeline catches and logs, the run continues). The create-mode ACTIVATION (registering
 * this codec on the create path) lands in Task 8; the fatality contract is unit-tested now.
 */
import { createLogger } from '../../../../common/logging/logger';
import { buildProviderConfigLookupKey } from '../../helpers/profile-mapping.helpers';
import {
  applyTeamOverrides,
  type RemappableTeam,
  type TeamOverrideEntry,
} from '../../helpers/team-overrides.helpers';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('TeamsCodec');

type TeamsSection = ParsedTemplatePayload['teams'];

/** Teams-service slice the export builder reads (list + detail). */
export interface TeamsExportService {
  listTeams: (
    projectId: string,
    options?: { limit?: number },
  ) => Promise<{
    items: Array<{
      id: string;
      name: string;
      description: string | null;
      teamLeadAgentId: string | null;
      memberCount: number;
    }>;
  }>;
  getTeam: (id: string) => Promise<{
    id: string;
    name: string;
    description: string | null;
    teamLeadAgentId: string | null;
    maxMembers: number;
    maxConcurrentTasks: number;
    allowTeamLeadCreateAgents: boolean;
    members: Array<{ agentId: string }>;
    profileIds: string[];
    profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
  } | null>;
}

// --- Export build (moved from project-export.ts `buildExportTeams`). -----------------
export async function buildExportTeams(
  project: { id: string },
  teamsService: TeamsExportService,
  storage: StorageService,
) {
  const { items: teamList } = await teamsService.listTeams(project.id, { limit: 10000 });
  const result: Array<{
    name: string;
    description: string | null;
    teamLeadAgentName: string | null;
    memberAgentNames: string[];
    maxMembers?: number;
    maxConcurrentTasks?: number;
    allowTeamLeadCreateAgents?: boolean;
    profileNames: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  }> = [];

  for (const teamSummary of teamList) {
    const team = await teamsService.getTeam(teamSummary.id);
    if (!team) continue;

    // Resolve member agent names
    const memberAgentNames: string[] = [];
    let teamLeadAgentName: string | null = null;
    for (const member of team.members) {
      try {
        const agent = await storage.getAgent(member.agentId);
        memberAgentNames.push(agent.name);
        if (member.agentId === team.teamLeadAgentId) {
          teamLeadAgentName = agent.name;
        }
      } catch {
        // Agent may have been deleted; skip
      }
    }

    // Resolve profile names
    const profileNames: string[] = [];
    for (const profileId of team.profileIds) {
      try {
        const profile = await storage.getAgentProfile(profileId);
        profileNames.push(profile.name);
      } catch {
        // Profile may have been deleted; skip
      }
    }

    // Resolve profileConfigSelections → profileSelections (name-based)
    const profileSelections: Array<{ profileName: string; configNames: string[] }> = [];
    if (team.profileConfigSelections && team.profileConfigSelections.length > 0) {
      const profileIdToName = new Map<string, string>();
      for (let i = 0; i < team.profileIds.length; i++) {
        try {
          const profile = await storage.getAgentProfile(team.profileIds[i]);
          profileIdToName.set(profile.id, profile.name);
        } catch {
          // already resolved above; skip deleted profiles
        }
      }

      for (const sel of team.profileConfigSelections) {
        const pName = profileIdToName.get(sel.profileId);
        if (!pName) continue;
        const configNames: string[] = [];
        for (const configId of sel.configIds) {
          try {
            const config = await storage.getProfileProviderConfig(configId);
            configNames.push(config.name);
          } catch {
            // config may have been deleted; skip
          }
        }
        if (configNames.length > 0) {
          profileSelections.push({ profileName: pName, configNames });
        }
      }
    }

    result.push({
      name: team.name,
      description: team.description,
      teamLeadAgentName,
      memberAgentNames,
      ...(team.maxMembers !== 5 ? { maxMembers: team.maxMembers } : {}),
      ...(team.maxConcurrentTasks !== 5 ? { maxConcurrentTasks: team.maxConcurrentTasks } : {}),
      ...(team.allowTeamLeadCreateAgents ? { allowTeamLeadCreateAgents: true } : {}),
      profileNames,
      ...(profileSelections.length > 0 ? { profileSelections } : {}),
    });
  }

  return result;
}

// --- Prune (moved from project-import.ts `pruneUnavailableTeamProfileSelections`). -----
export function pruneUnavailableTeamProfileSelections<
  TTeam extends {
    name: string;
    profileNames?: string[];
    profileSelections?: Array<{ profileName: string; configNames: string[] }>;
  },
>(
  exportedTeams: TTeam[],
  profiles: Array<{
    id?: string;
    name: string;
    providerConfigs?: Array<{ name: string }>;
  }>,
  profileIdMap: Record<string, string>,
  configLookupMap: Map<string, string>,
): TTeam[] {
  const profileNameToNewId = new Map<string, string>();
  const knownConfigNamesByNewProfileId = new Map<string, Set<string>>();

  for (const profile of profiles) {
    if (!profile.id) continue;
    const newProfileId = profileIdMap[profile.id];
    if (!newProfileId) continue;

    profileNameToNewId.set(profile.name.trim().toLowerCase(), newProfileId);
    knownConfigNamesByNewProfileId.set(
      newProfileId,
      new Set((profile.providerConfigs ?? []).map((config) => config.name.trim().toLowerCase())),
    );
  }

  return exportedTeams.map((team) => {
    if (!team.profileSelections || team.profileSelections.length === 0) {
      return team;
    }

    const profileSelections: Array<{ profileName: string; configNames: string[] }> = [];
    const profilesWithNoAvailableConfigs = new Set<string>();
    for (const selection of team.profileSelections) {
      if (selection.configNames.length === 0) {
        profileSelections.push(selection);
        continue;
      }

      const newProfileId = profileNameToNewId.get(selection.profileName.trim().toLowerCase());
      if (!newProfileId) {
        profileSelections.push(selection);
        continue;
      }

      const knownConfigNames = knownConfigNamesByNewProfileId.get(newProfileId) ?? new Set();
      const availableConfigNames: string[] = [];
      for (const configName of selection.configNames) {
        const lookupKey = buildProviderConfigLookupKey(newProfileId, configName);
        if (configLookupMap.has(lookupKey)) {
          availableConfigNames.push(configName);
          continue;
        }

        if (knownConfigNames.has(configName.trim().toLowerCase())) {
          logger.warn(
            {
              teamName: team.name,
              profileName: selection.profileName,
              configName,
            },
            'Team profile config unavailable after provider filtering; skipping config',
          );
          continue;
        }

        availableConfigNames.push(configName);
      }

      if (availableConfigNames.length > 0) {
        profileSelections.push({ ...selection, configNames: availableConfigNames });
      } else {
        profilesWithNoAvailableConfigs.add(selection.profileName.trim().toLowerCase());
        logger.warn(
          {
            teamName: team.name,
            profileName: selection.profileName,
          },
          'Team profile selection has no available configs after provider filtering; skipping selection',
        );
      }
    }

    const profileNames =
      profilesWithNoAvailableConfigs.size > 0
        ? team.profileNames?.filter(
            (profileName) => !profilesWithNoAvailableConfigs.has(profileName.trim().toLowerCase()),
          )
        : team.profileNames;

    const nextTeam =
      profileNames !== team.profileNames
        ? ({
            ...team,
            ...(profileNames !== undefined ? { profileNames } : {}),
          } as TTeam)
        : team;

    if (profileSelections.length > 0) {
      return { ...nextTeam, profileSelections };
    }

    const { profileSelections: _profileSelections, ...teamWithoutSelections } = nextTeam;
    return teamWithoutSelections as TTeam;
  });
}

class TeamsCodec implements TemplateSectionCodec<TeamsSection> {
  readonly declaration = {
    // `selectedProfilesByFamily` (applyTeamOverrides + prune), `profileIdMap` +
    // `configLookupMap` (prune) come from the ImportContext. Agent/profile name→id
    // resolution queries live storage (verbatim from createImportedTeams) — see apply.
    section: 'teams',
    reads: ['selectedProfilesByFamily', 'profileIdMap', 'configLookupMap'],
    writes: [],
    requiresState: ['agentsPersisted'],
    modes: ['replace', 'create'],
    // Matrix row 13: replace = fatal (scoped cleanup re-throws), create = non-fatal (logged).
    onFailure: { replace: 'fatal', create: 'swallow' } as const,
  } as const;

  pick(payload: ParsedTemplatePayload): TeamsSection {
    return payload.teams;
  }

  build() {
    // Export build is invoked directly by project-export via `buildExportTeams`.
    return [];
  }

  async apply(
    teams: TeamsSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    if (!rt.teamsService) {
      return { section: 'teams', log: { teams: 0 } };
    }
    if (!teams || teams.length === 0) {
      return { section: 'teams', log: { teams: 0 } };
    }

    const { projectId } = rt;
    const selectedProfilesByFamily = ctx.get('selectedProfilesByFamily');
    const teamOverrides = rt.teamOverrides;

    if (teamOverrides) {
      for (const override of teamOverrides) {
        if (
          !teams.some(
            (team) => team.name.trim().toLowerCase() === override.teamName.trim().toLowerCase(),
          )
        ) {
          logger.warn(
            { teamName: override.teamName },
            'teamOverrides references unknown team; skipping',
          );
        }
      }
    }

    const teamsToImport = applyTeamOverrides(
      teams as RemappableTeam[],
      teamOverrides as TeamOverrideEntry[] | undefined,
      selectedProfilesByFamily.profileNameRemapMap,
      selectedProfilesByFamily.profilesToCreate,
    );
    const profileIdMap = ctx.get('profileIdMap');
    const configLookupMap = ctx.get('configLookupMap');
    const teamsWithAvailableConfigs = pruneUnavailableTeamProfileSelections(
      teamsToImport,
      selectedProfilesByFamily.profilesToCreate,
      profileIdMap,
      configLookupMap,
    );

    // Build name→id maps from the project's CURRENT agents and profiles (verbatim from the
    // legacy createImportedTeams). The agentsPersisted precondition guarantees the agents
    // codec has run; reading live storage (rather than the ImportContext maps) preserves
    // the exact legacy resolution surface, including agents present in storage this run.
    const { storage } = rt;
    const { items: agents } = await storage.listAgents(projectId, { limit: 10000 });
    const agentNameToId = new Map<string, string>();
    for (const agent of agents) {
      agentNameToId.set(agent.name.trim().toLowerCase(), agent.id);
    }

    const { items: profiles } = await storage.listAgentProfiles({ projectId });
    const profileNameToId = new Map<string, string>();
    for (const profile of profiles) {
      profileNameToId.set(profile.name.trim().toLowerCase(), profile.id);
    }

    const createdTeamIds: string[] = [];

    try {
      for (const exportedTeam of teamsWithAvailableConfigs) {
        const created = await this.createTeam(
          projectId,
          exportedTeam,
          agentNameToId,
          profileNameToId,
          storage,
          rt,
        );
        createdTeamIds.push(created.id);
      }

      return { section: 'teams', log: { teams: createdTeamIds.length } };
    } catch (error) {
      // Scoped cleanup: delete only the teams created in THIS run so a partial failure
      // never leaves orphan teams behind. Pre-existing teams (replace path cleared them
      // up front via cleanupTeamsForProject; create path has none yet) are untouched.
      if (createdTeamIds.length > 0) {
        logger.warn(
          { createdTeamIds, error },
          'Teams import failed; cleaning up partially created teams',
        );
        try {
          await rt.teamsService.deleteTeamsByIds(createdTeamIds);
        } catch (cleanupError) {
          logger.error({ cleanupError }, 'Failed to clean up partially imported teams');
        }
      }
      throw error;
    }
  }

  /** Resolve one team's name-based refs to ids and persist it (verbatim createImportedTeams). */
  private async createTeam(
    projectId: string,
    exportedTeam: RemappableTeam,
    agentNameToId: Map<string, string>,
    profileNameToId: Map<string, string>,
    storage: CodecApplyRuntime['storage'],
    rt: CodecApplyRuntime,
  ): Promise<{ id: string }> {
    // Resolve member agent IDs
    const memberAgentIds: string[] = [];
    for (const memberName of exportedTeam.memberAgentNames) {
      const agentId = agentNameToId.get(memberName.trim().toLowerCase());
      if (!agentId) {
        throw new Error(
          `Team "${exportedTeam.name}" references agent "${memberName}" which was not found in the project`,
        );
      }
      memberAgentIds.push(agentId);
    }

    // Resolve team lead agent ID
    let teamLeadAgentId: string | null = null;
    if (exportedTeam.teamLeadAgentName) {
      teamLeadAgentId =
        agentNameToId.get(exportedTeam.teamLeadAgentName.trim().toLowerCase()) ?? null;
      if (!teamLeadAgentId) {
        throw new Error(
          `Team "${exportedTeam.name}" references team lead "${exportedTeam.teamLeadAgentName}" which was not found in the project`,
        );
      }
    }

    // Resolve profile IDs
    const profileIds: string[] = [];
    if (exportedTeam.profileNames) {
      for (const profileName of exportedTeam.profileNames) {
        const profileId = profileNameToId.get(profileName.trim().toLowerCase());
        if (!profileId) {
          throw new Error(
            `Team "${exportedTeam.name}" references profile "${profileName}" which was not found in the project`,
          );
        }
        profileIds.push(profileId);
      }
    }

    // Resolve profileSelections → profileConfigSelections (ID-based) — list each profile's
    // configs and map name→id (verbatim from createImportedTeams).
    let profileConfigSelections: Array<{ profileId: string; configIds: string[] }> | undefined;
    if (exportedTeam.profileSelections && exportedTeam.profileSelections.length > 0) {
      profileConfigSelections = [];
      for (const sel of exportedTeam.profileSelections) {
        const profileId = profileNameToId.get(sel.profileName.trim().toLowerCase());
        if (!profileId) {
          throw new Error(
            `Team "${exportedTeam.name}" references profile "${sel.profileName}" in profileSelections which was not found in the project`,
          );
        }
        const configs = await storage.listProfileProviderConfigsByProfile(profileId);
        const configNameToId = new Map<string, string>();
        for (const c of configs) {
          configNameToId.set(c.name.trim().toLowerCase(), c.id);
        }
        const configIds: string[] = [];
        for (const configName of sel.configNames) {
          const configId = configNameToId.get(configName.trim().toLowerCase());
          if (!configId) {
            throw new Error(
              `Team "${exportedTeam.name}" references config "${configName}" for profile "${sel.profileName}" which was not found`,
            );
          }
          configIds.push(configId);
        }
        if (configIds.length > 0) {
          profileConfigSelections.push({ profileId, configIds });
        }
      }
    }

    return rt.teamsService!.createTeam({
      projectId,
      name: exportedTeam.name,
      description: exportedTeam.description ?? null,
      teamLeadAgentId,
      memberAgentIds,
      ...(exportedTeam.maxMembers !== undefined ? { maxMembers: exportedTeam.maxMembers } : {}),
      ...(exportedTeam.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: exportedTeam.maxConcurrentTasks }
        : {}),
      ...(exportedTeam.allowTeamLeadCreateAgents !== undefined
        ? { allowTeamLeadCreateAgents: exportedTeam.allowTeamLeadCreateAgents }
        : {}),
      profileIds,
      ...(profileConfigSelections ? { profileConfigSelections } : {}),
    });
  }
}

export const teamsCodec = new TeamsCodec();
