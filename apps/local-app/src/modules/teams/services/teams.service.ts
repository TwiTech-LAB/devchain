import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  TeamMemberCapReachedError,
} from '../../../common/errors/error-types';
import { SessionsService } from '../../sessions/services/sessions.service';
import {
  STORAGE_SERVICE,
  type StorageService,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type {
  Agent,
  Team,
  TeamMember,
  CreateTeam,
  UpdateTeam,
} from '../../storage/models/domain.models';
import { TeamsStore, type TeamsListOptions } from '../storage/teams.store';
import {
  dedupeProfileConfigSelections,
  validateAgentsInProject,
  validateConfigProfileConsistency,
  validateConcurrentTasksCap,
  validateLeadInMembers,
  validateMemberCapacity,
  validateMemberNonEmpty,
  validateProfilesInProject,
  validateSelectionsAgainstProfiles,
} from './teams.validators';
import { EventsService } from '../../events/services/events.service';
import { SettingsService } from '../../settings/services/settings.service';
import { createLogger } from '../../../common/logging/logger';
import type { RecipientContext } from '../dtos/recipient-context.dto';

const logger = createLogger('TeamsService');

export interface TeamWithLeadName extends Team {
  memberCount: number;
  teamLeadAgentName: string | null;
}

@Injectable()
export class TeamsService {
  private sessionsServiceRef?: SessionsService;

  constructor(
    private readonly teamsStore: TeamsStore,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly moduleRef: ModuleRef,
    private readonly settingsService: SettingsService,
    @Optional() private readonly eventsService?: EventsService,
  ) {}

  private getSessionsService(): SessionsService {
    if (!this.sessionsServiceRef) {
      this.sessionsServiceRef = this.moduleRef.get(SessionsService, { strict: false });
    }
    return this.sessionsServiceRef;
  }

  private async resolveTeamEventNames(
    projectId: string,
    teamLeadAgentId: string | null,
  ): Promise<{ projectName?: string; teamLeadAgentName?: string }> {
    const result: { projectName?: string; teamLeadAgentName?: string } = {};

    try {
      const project = await this.storage.getProject(projectId);
      result.projectName = project.name;
    } catch {
      // Event enrichment is best-effort.
    }

    if (teamLeadAgentId) {
      try {
        const teamLeadAgent = await this.storage.getAgent(teamLeadAgentId);
        result.teamLeadAgentName = teamLeadAgent.name;
      } catch {
        // Event enrichment is best-effort.
      }
    }

    return result;
  }

  private buildLeadRecipientIds(teamLeadAgentId: string | null): string[] {
    return teamLeadAgentId ? [teamLeadAgentId] : [];
  }

  async createTeam(data: CreateTeam): Promise<Team> {
    // De-duplicate memberAgentIds and profileIds silently
    const uniqueMembers = [...new Set(data.memberAgentIds)];
    const uniqueProfileIds = data.profileIds ? [...new Set(data.profileIds)] : undefined;
    const teamLeadAgentId = data.teamLeadAgentId ?? null;

    validateMemberNonEmpty(uniqueMembers);
    validateLeadInMembers(teamLeadAgentId, uniqueMembers);
    await validateAgentsInProject(this.storage, data.projectId, uniqueMembers);

    if (uniqueProfileIds && uniqueProfileIds.length > 0) {
      await validateProfilesInProject(this.storage, data.projectId, uniqueProfileIds);
    }

    const dedupedSelections = dedupeProfileConfigSelections(data.profileConfigSelections);
    if (dedupedSelections && dedupedSelections.length > 0) {
      const effectiveProfileIds = uniqueProfileIds ?? [];
      validateSelectionsAgainstProfiles(dedupedSelections, effectiveProfileIds);
      await validateConfigProfileConsistency(this.storage, dedupedSelections);
    }
    const filteredSelections = dedupedSelections?.filter((s) => s.configIds.length > 0);

    const effectiveMaxMembers = data.maxMembers ?? 5;
    const effectiveMaxConcurrentTasks = data.maxConcurrentTasks ?? effectiveMaxMembers;
    validateConcurrentTasksCap(effectiveMaxConcurrentTasks, effectiveMaxMembers);
    validateMemberCapacity(
      uniqueMembers,
      teamLeadAgentId,
      effectiveMaxMembers,
      'Initial team exceeds maxMembers',
    );

    return this.teamsStore.createTeam({
      ...data,
      teamLeadAgentId,
      maxMembers: effectiveMaxMembers,
      maxConcurrentTasks: effectiveMaxConcurrentTasks,
      memberAgentIds: uniqueMembers,
      profileIds: uniqueProfileIds,
      profileConfigSelections: filteredSelections,
    });
  }

  async getTeam(id: string): Promise<
    | (Team & {
        members: TeamMember[];
        profileIds: string[];
        profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
      })
    | null
  > {
    return this.teamsStore.getTeam(id);
  }

  /**
   * Module-boundary facade for the cloud-tunnel `chat.listProfiles` RPC (the tunnel module
   * imports `TeamsService`, never `TeamsStore`). Returns the profile ids LINKED to `teamId`,
   * after asserting the team belongs to `projectId` so a caller cannot enumerate another
   * project's team profiles by id.
   */
  async listLinkedProfileIdsForTeam(projectId: string, teamId: string): Promise<string[]> {
    const team = await this.teamsStore.getTeam(teamId);
    if (!team) {
      throw new NotFoundError('Team', teamId);
    }
    if (team.projectId !== projectId) {
      throw new ForbiddenError('Team does not belong to the requested project', {
        code: 'TEAM_PROJECT_MISMATCH',
        teamId,
        projectId,
      });
    }
    return this.teamsStore.listProfilesForTeam(teamId);
  }

  /**
   * Module-boundary facade for the cloud-tunnel `chat.listProfiles` RPC with no team selected:
   * the "standalone" set — profile ids in `projectId` NOT linked to any of its teams. Project
   * scoping is intrinsic (the query filters by `projectId`).
   */
  async listUnlinkedProfileIds(projectId: string): Promise<string[]> {
    return this.teamsStore.listProfilesNotLinkedToAnyTeam(projectId);
  }

  async listTeams(
    projectId: string,
    options?: TeamsListOptions,
  ): Promise<ListResult<TeamWithLeadName>> {
    const result = await this.teamsStore.listTeams(projectId, options);

    // Single query to resolve lead agent names (no N+1)
    const agentsResult = await this.storage.listAgents(projectId, {
      limit: 1000,
    });
    const agentNameMap = new Map(agentsResult.items.map((a) => [a.id, a.name]));

    return {
      ...result,
      items: result.items.map((team) => ({
        ...team,
        teamLeadAgentName: team.teamLeadAgentId
          ? (agentNameMap.get(team.teamLeadAgentId) ?? null)
          : null,
      })),
    };
  }

  async findTeamByExactName(projectId: string, name: string): Promise<Team | null> {
    return this.teamsStore.findTeamByExactName(projectId, name.trim());
  }

  /**
   * Batched read for mobile team grouping (`chat.listTeams`): every team in the
   * project (in `listTeams` order) with its ordered member agent IDs, via a
   * single batched `teamMembers` query (no N+1). Delegates to
   * `TeamsStore.listTeamsWithMembers`; returns the minimal shape the mobile
   * client needs (id / name / lead / memberAgentIds). `memberCount` is derived
   * by the caller from `memberAgentIds.length`.
   */
  async listTeamsWithMemberIds(projectId: string): Promise<
    Array<{
      id: string;
      name: string;
      teamLeadAgentId: string | null;
      memberAgentIds: string[];
    }>
  > {
    const rows = await this.teamsStore.listTeamsWithMembers(projectId);
    return rows.map(({ team, memberAgentIds }) => ({
      id: team.id,
      name: team.name,
      teamLeadAgentId: team.teamLeadAgentId,
      memberAgentIds,
    }));
  }

  async updateTeam(id: string, data: UpdateTeam): Promise<Team> {
    // Fetch current team to validate cross-field consistency
    const current = await this.teamsStore.getTeam(id);
    if (!current) {
      throw new NotFoundError('Team', id);
    }

    // De-duplicate memberAgentIds and profileIds when provided
    const dedupedMembers = data.memberAgentIds ? [...new Set(data.memberAgentIds)] : undefined;
    const dedupedProfileIds = data.profileIds ? [...new Set(data.profileIds)] : undefined;
    const effectiveMembers = dedupedMembers ?? current.members.map((m) => m.agentId);
    const effectiveLead =
      data.teamLeadAgentId !== undefined ? data.teamLeadAgentId : current.teamLeadAgentId;

    if (dedupedMembers !== undefined) {
      validateMemberNonEmpty(effectiveMembers);
    }

    validateLeadInMembers(effectiveLead, effectiveMembers);

    if (dedupedMembers !== undefined) {
      await validateAgentsInProject(this.storage, current.projectId, effectiveMembers);
    } else if (data.teamLeadAgentId !== undefined && effectiveLead !== null) {
      // Only the lead changed — validate just the new lead, not all (stale) members.
      await validateAgentsInProject(this.storage, current.projectId, [effectiveLead]);
    }

    if (dedupedProfileIds !== undefined && dedupedProfileIds.length > 0) {
      await validateProfilesInProject(this.storage, current.projectId, dedupedProfileIds);
    }

    const dedupedSelections = dedupeProfileConfigSelections(data.profileConfigSelections);
    if (dedupedSelections && dedupedSelections.length > 0) {
      const effectiveProfileIds = dedupedProfileIds ?? current.profileIds;
      validateSelectionsAgainstProfiles(dedupedSelections, effectiveProfileIds);
      await validateConfigProfileConsistency(this.storage, dedupedSelections);
    }
    const filteredSelections =
      dedupedSelections !== undefined
        ? dedupedSelections.filter((s) => s.configIds.length > 0)
        : undefined;

    const eMM = data.maxMembers ?? current.maxMembers;
    const eMCT = data.maxConcurrentTasks ?? current.maxConcurrentTasks;
    validateConcurrentTasksCap(eMCT, eMM);

    if (
      dedupedMembers !== undefined ||
      data.teamLeadAgentId !== undefined ||
      data.maxMembers !== undefined
    ) {
      validateMemberCapacity(
        effectiveMembers,
        effectiveLead,
        eMM,
        'Team member count exceeds maxMembers',
      );
    }

    const storeData =
      dedupedMembers !== undefined
        ? {
            ...data,
            memberAgentIds: dedupedMembers,
            profileIds: dedupedProfileIds,
            profileConfigSelections: filteredSelections,
          }
        : { ...data, profileIds: dedupedProfileIds, profileConfigSelections: filteredSelections };

    const previousMaxMembers = current.maxMembers;
    const previousMaxConcurrentTasks = current.maxConcurrentTasks;
    const previousAllowTeamLeadCreateAgents = current.allowTeamLeadCreateAgents;
    const result = await this.teamsStore.updateTeam(id, storeData);
    const eventNames = await this.resolveTeamEventNames(current.projectId, result.teamLeadAgentId);
    const leadRecipientIds = this.buildLeadRecipientIds(result.teamLeadAgentId);

    if (
      result.maxMembers !== previousMaxMembers ||
      result.maxConcurrentTasks !== previousMaxConcurrentTasks ||
      result.allowTeamLeadCreateAgents !== previousAllowTeamLeadCreateAgents
    ) {
      try {
        await this.eventsService?.publish('team.config.updated', {
          teamId: id,
          projectId: current.projectId,
          teamLeadAgentId: result.teamLeadAgentId,
          teamName: result.name,
          projectName: eventNames.projectName,
          recipientIds: leadRecipientIds,
          agentName: eventNames.teamLeadAgentName,
          previous: {
            maxMembers: previousMaxMembers,
            maxConcurrentTasks: previousMaxConcurrentTasks,
            allowTeamLeadCreateAgents: previousAllowTeamLeadCreateAgents,
          },
          current: {
            maxMembers: result.maxMembers,
            maxConcurrentTasks: result.maxConcurrentTasks,
            allowTeamLeadCreateAgents: result.allowTeamLeadCreateAgents,
          },
        });
      } catch {
        // Event publish failure is non-fatal
      }
    }

    if (dedupedMembers !== undefined) {
      const previousMemberIds = new Set(current.members.map((m) => m.agentId));
      const nextMemberIds = new Set(dedupedMembers);
      const addedAgentIds = [...nextMemberIds].filter((aid) => !previousMemberIds.has(aid));
      const removedAgentIds = [...previousMemberIds].filter((aid) => !nextMemberIds.has(aid));

      for (const agentId of addedAgentIds) {
        try {
          const agent = await this.storage.getAgent(agentId).catch(() => null);
          await this.eventsService?.publish('team.member.added', {
            teamId: id,
            projectId: current.projectId,
            teamLeadAgentId: result.teamLeadAgentId,
            teamName: result.name,
            addedAgentId: agentId,
            addedAgentName: agent?.name ?? null,
            addedAgentDescription: agent?.description ?? null,
            projectName: eventNames.projectName,
            recipientIds: leadRecipientIds,
            agentName: agent?.name,
            teamLeadAgentName: eventNames.teamLeadAgentName,
          });
        } catch {
          // Best-effort
        }
      }

      for (const agentId of removedAgentIds) {
        try {
          const agent = await this.storage.getAgent(agentId).catch(() => null);
          await this.eventsService?.publish('team.member.removed', {
            teamId: id,
            projectId: current.projectId,
            teamLeadAgentId: result.teamLeadAgentId,
            teamName: result.name,
            removedAgentId: agentId,
            removedAgentName: agent?.name ?? null,
            projectName: eventNames.projectName,
            recipientIds: leadRecipientIds,
            agentName: agent?.name,
            teamLeadAgentName: eventNames.teamLeadAgentName,
          });
        } catch {
          // Best-effort
        }
      }
    }

    return result;
  }

  async disbandTeam(id: string): Promise<void> {
    return this.teamsStore.deleteTeam(id);
  }

  async deleteTeamsByProject(projectId: string): Promise<void> {
    return this.teamsStore.deleteTeamsByProject(projectId);
  }

  async deleteTeamsByIds(ids: string[]): Promise<void> {
    if (!ids || ids.length === 0) return;
    return this.teamsStore.deleteTeamsByIds(ids);
  }

  async listTeamsByAgent(agentId: string): Promise<Team[]> {
    return this.teamsStore.listTeamsByAgent(agentId);
  }

  async getRecipientContext(agentId: string, projectId: string): Promise<RecipientContext> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ValidationError('Agent belongs to a different project', {
        agentId,
        projectId,
        agentProjectId: agent.projectId,
      });
    }

    const teams = (await this.teamsStore.listTeamsByAgent(agentId)).filter(
      (team) => team.projectId === projectId,
    );
    const teamNames = teams.map((team) => team.name).sort((a, b) => a.localeCompare(b));
    const isTeamLead = teams.some((team) => team.teamLeadAgentId === agentId);
    const memberRole = isTeamLead ? 'lead' : teamNames.length > 0 ? 'member' : null;

    return {
      isTeamLead,
      teamNames,
      memberRole,
    };
  }

  async countBusyTeamMembers(teamId: string, teamLeadAgentId: string | null): Promise<number> {
    return this.teamsStore.countBusyTeamMembers(teamId, teamLeadAgentId);
  }

  async canDeleteAgent(agentId: string): Promise<{ canDelete: boolean; blockingTeams: string[] }> {
    const leadTeams = await this.teamsStore.getTeamLeadTeams(agentId);

    return {
      canDelete: true,
      blockingTeams: leadTeams.map((t) => t.name),
    };
  }

  async listConfigsVisibleToLead(
    leadAgentId: string,
    projectId: string,
  ): Promise<
    | { configName: string; description: string | null; profileName: string; teamName: string }[]
    | { error: { code: string; message: string; data?: unknown } }
  > {
    const ledTeams = await this.teamsStore.getTeamLeadTeams(leadAgentId);
    const projectTeams = ledTeams.filter((t) => t.projectId === projectId);
    if (projectTeams.length === 0) {
      return {
        error: {
          code: 'FORBIDDEN_NOT_TEAM_LEAD',
          message: 'You do not lead any teams in this project',
        },
      };
    }
    const seen = new Set<string>();
    const configs: {
      configName: string;
      description: string | null;
      profileName: string;
      teamName: string;
    }[] = [];
    for (const team of projectTeams) {
      const teamConfigs = await this.teamsStore.listConfigsForTeam(team.id);
      for (const config of teamConfigs) {
        const profile = await this.storage.getAgentProfile(config.profileId);
        const key = `${config.name.trim().toLowerCase()}|${profile.name.trim().toLowerCase()}|${team.name.trim().toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          configs.push({
            configName: config.name,
            description: config.description,
            profileName: profile.name,
            teamName: team.name,
          });
        }
      }
    }
    return configs;
  }

  private async resolveLedTeam(
    leadAgentId: string,
    projectId: string,
    teamName?: string,
  ): Promise<{ team: Team } | { error: { code: string; message: string; data?: unknown } }> {
    const ledTeams = await this.teamsStore.getTeamLeadTeams(leadAgentId);
    const projectTeams = ledTeams.filter((t) => t.projectId === projectId);

    if (projectTeams.length === 0) {
      return {
        error: {
          code: 'FORBIDDEN_NOT_TEAM_LEAD',
          message: 'You do not lead any teams in this project',
        },
      };
    }

    if (teamName) {
      const trimmedName = teamName.trim().toLowerCase();
      const matches = projectTeams.filter((t) => t.name.trim().toLowerCase() === trimmedName);
      if (matches.length === 0) {
        return {
          error: {
            code: 'TEAM_NOT_FOUND_OR_NOT_LED',
            message: `No team named "${teamName}" found among teams you lead`,
          },
        };
      }
      return { team: matches[0] };
    }

    if (projectTeams.length === 1) {
      return { team: projectTeams[0] };
    }

    return {
      error: {
        code: 'AMBIGUOUS_TEAM_LEAD',
        message: 'You lead multiple teams. Specify teamName to disambiguate.',
        data: { candidates: projectTeams.map((t) => ({ teamName: t.name })) },
      },
    };
  }

  async createTeamAgent(input: {
    leadAgentId: string;
    projectId: string;
    teamName?: string;
    name: string;
    description?: string;
    configName: string;
    profileName?: string;
  }): Promise<
    | {
        agent: {
          id: string;
          name: string;
          description: string | null;
          profileName: string;
          configName: string;
        };
        teamName: string;
      }
    | { error: { code: string; message: string; data?: unknown } }
  > {
    // 1. Resolve team
    const teamResult = await this.resolveLedTeam(
      input.leadAgentId,
      input.projectId,
      input.teamName,
    );
    if ('error' in teamResult) return teamResult;
    const { team } = teamResult;

    // 2. Check allowTeamLeadCreateAgents flag
    if (!team.allowTeamLeadCreateAgents) {
      return {
        error: {
          code: 'TEAM_LEAD_CREATION_DISABLED',
          message: 'Team does not allow lead-initiated agent creation',
          data: { teamId: team.id, teamName: team.name },
        },
      };
    }

    // 3. Resolve config
    const teamConfigs = await this.teamsStore.listConfigsForTeam(team.id);
    const configsWithProfiles: Array<{
      id: string;
      profileId: string;
      name: string;
      description: string | null;
      profileName: string;
    }> = [];
    for (const config of teamConfigs) {
      const profile = await this.storage.getAgentProfile(config.profileId);
      configsWithProfiles.push({
        id: config.id,
        profileId: config.profileId,
        name: config.name,
        description: config.description,
        profileName: profile.name,
      });
    }

    const trimmedConfigName = input.configName.trim().toLowerCase();
    let candidates = configsWithProfiles.filter(
      (c) => c.name.trim().toLowerCase() === trimmedConfigName,
    );
    if (input.profileName) {
      const trimmedProfileName = input.profileName.trim().toLowerCase();
      candidates = candidates.filter(
        (c) => c.profileName.trim().toLowerCase() === trimmedProfileName,
      );
    }

    if (candidates.length === 0) {
      return {
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: `No provider configuration named "${input.configName}" found for this team`,
        },
      };
    }
    if (candidates.length > 1) {
      return {
        error: {
          code: 'AMBIGUOUS_CONFIG_NAME',
          message: `Multiple configurations named "${input.configName}" found. Specify profileName to disambiguate.`,
          data: {
            candidates: candidates.map((c) => ({
              configName: c.name,
              profileName: c.profileName,
            })),
          },
        },
      };
    }

    const resolved = candidates[0];

    // 4. Check agent name uniqueness (case-insensitive, project-scoped)
    const { items: existingAgents } = await this.storage.listAgents(input.projectId, {
      limit: 10000,
    });
    const trimmedAgentName = input.name.trim().toLowerCase();
    if (existingAgents.some((a) => a.name.trim().toLowerCase() === trimmedAgentName)) {
      return {
        error: {
          code: 'AGENT_NAME_EXISTS',
          message: `An agent named "${input.name}" already exists in this project`,
        },
      };
    }

    // 5. Atomic transaction: create agent + add to team (capacity-aware)
    const effectiveDescription = input.description?.trim() || resolved.description?.trim() || '';
    let agent;
    try {
      agent = await this.teamsStore.createTeamAgentAtomicCapped({
        teamId: team.id,
        maxMembers: team.maxMembers,
        teamLeadAgentId: team.teamLeadAgentId,
        createAgentFn: () =>
          this.storage.createAgent({
            projectId: input.projectId,
            profileId: resolved.profileId,
            providerConfigId: resolved.id,
            name: input.name,
            description: effectiveDescription,
          }),
      });
    } catch (error) {
      if (error instanceof TeamMemberCapReachedError) {
        return {
          error: {
            code: 'TEAM_MEMBER_CAP_REACHED',
            message: error.message,
            data: error.details,
          },
        };
      }
      throw error;
    }

    // 6. Publish agent.created event (best-effort)
    try {
      await this.eventsService?.publish('agent.created', {
        agentId: agent.id,
        agentName: agent.name,
        projectId: input.projectId,
        profileId: resolved.profileId,
        providerConfigId: resolved.id,
        actor: { type: 'agent' as const, id: input.leadAgentId },
      });
    } catch (error) {
      logger.error(
        { agentId: agent.id, projectId: input.projectId, error },
        'Failed to publish agent.created event',
      );
    }

    // 7. Publish team.member.added event (best-effort)
    try {
      const eventNames = await this.resolveTeamEventNames(input.projectId, team.teamLeadAgentId);
      await this.eventsService?.publish('team.member.added', {
        teamId: team.id,
        projectId: input.projectId,
        teamLeadAgentId: team.teamLeadAgentId,
        teamName: team.name,
        addedAgentId: agent.id,
        addedAgentName: agent.name,
        addedAgentDescription: agent.description ?? null,
        projectName: eventNames.projectName,
        recipientIds: this.buildLeadRecipientIds(team.teamLeadAgentId),
        agentName: agent.name,
        teamLeadAgentName: eventNames.teamLeadAgentName,
      });
    } catch (error) {
      logger.error(
        { agentId: agent.id, projectId: input.projectId, teamId: team.id, error },
        'Failed to publish team.member.added event',
      );
    }

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        profileName: resolved.profileName,
        configName: resolved.name,
      },
      teamName: team.name,
    };
  }

  async createTeamAgentForRest(input: {
    actorLeadAgentId: string;
    projectId: string;
    teamId: string;
    providerConfigId: string;
    name: string;
    description?: string;
  }) {
    const team = await this.teamsStore.getTeam(input.teamId);
    if (!team || team.projectId !== input.projectId) {
      throw new NotFoundError('Team');
    }
    if (team.teamLeadAgentId === null) {
      throw new ValidationError('Team has no lead');
    }
    if (input.actorLeadAgentId !== team.teamLeadAgentId) {
      throw new ValidationError('Not team lead');
    }

    const config = await this.storage.getProfileProviderConfig(input.providerConfigId);
    const profile = await this.storage.getAgentProfile(config.profileId);
    if (profile.projectId !== team.projectId) {
      throw new NotFoundError('Provider config');
    }

    const teamProfileIds = await this.teamsStore.listProfilesForTeam(input.teamId);
    if (!teamProfileIds.includes(config.profileId)) {
      throw new ValidationError('Profile not linked to team');
    }

    const { items: existingAgents } = await this.storage.listAgents(input.projectId, {
      limit: 10000,
    });
    const trimmedName = input.name.trim().toLowerCase();
    if (existingAgents.some((a) => a.name.trim().toLowerCase() === trimmedName)) {
      throw new ConflictError(`An agent named "${input.name}" already exists in this project`);
    }

    const effectiveDescription = input.description?.trim() || config.description?.trim() || '';

    let agent;
    try {
      agent = await this.teamsStore.createTeamAgentAtomicCapped({
        teamId: input.teamId,
        maxMembers: team.maxMembers,
        teamLeadAgentId: team.teamLeadAgentId,
        createAgentFn: () =>
          this.storage.createAgent({
            projectId: input.projectId,
            profileId: config.profileId,
            providerConfigId: input.providerConfigId,
            name: input.name,
            description: effectiveDescription,
          }),
      });
    } catch (error) {
      if (error instanceof TeamMemberCapReachedError) {
        throw new ConflictError('Team is at member cap');
      }
      throw error;
    }

    try {
      await this.eventsService?.publish('agent.created', {
        agentId: agent.id,
        agentName: agent.name,
        projectId: input.projectId,
        profileId: config.profileId,
        providerConfigId: input.providerConfigId,
        actor: { type: 'agent' as const, id: input.actorLeadAgentId },
      });
    } catch (error) {
      logger.error(
        { agentId: agent.id, projectId: input.projectId, error },
        'Failed to publish agent.created event',
      );
    }

    try {
      const eventNames = await this.resolveTeamEventNames(input.projectId, team.teamLeadAgentId);
      await this.eventsService?.publish('team.member.added', {
        teamId: input.teamId,
        projectId: input.projectId,
        teamLeadAgentId: team.teamLeadAgentId,
        teamName: team.name,
        addedAgentId: agent.id,
        addedAgentName: agent.name,
        addedAgentDescription: agent.description ?? null,
        projectName: eventNames.projectName,
        recipientIds: this.buildLeadRecipientIds(team.teamLeadAgentId),
        agentName: agent.name,
        teamLeadAgentName: eventNames.teamLeadAgentName,
      });
    } catch {
      // Best-effort
    }

    return agent;
  }

  async deleteTeamAgent(input: {
    leadAgentId: string;
    projectId: string;
    name: string;
    teamName?: string;
  }): Promise<
    | { result: { deletedAgentId: string; deletedAgentName: string; teamName: string } }
    | { error: { code: string; message: string } }
  > {
    // 1. Resolve led team
    const teamResult = await this.resolveLedTeam(
      input.leadAgentId,
      input.projectId,
      input.teamName,
    );
    if ('error' in teamResult) return teamResult;
    const { team } = teamResult;

    // 2. Resolve target agent by name within team members
    const teamDetail = await this.teamsStore.getTeam(team.id);
    if (!teamDetail) {
      return { error: { code: 'TEAM_NOT_FOUND_OR_NOT_LED', message: 'Team no longer exists' } };
    }
    const memberAgentIds = teamDetail.members.map((m) => m.agentId);
    const { items: projectAgents } = await this.storage.listAgents(input.projectId, {
      limit: 10000,
    });
    const memberAgents = projectAgents.filter((a) => memberAgentIds.includes(a.id));

    const trimmedName = input.name.trim().toLowerCase();
    const nameMatches = memberAgents.filter((a) => a.name.trim().toLowerCase() === trimmedName);

    if (nameMatches.length === 0) {
      return {
        error: {
          code: 'AGENT_NOT_FOUND_IN_TEAM',
          message: `No agent named "${input.name}" found in team "${team.name}"`,
        },
      };
    }
    if (nameMatches.length > 1) {
      return {
        error: {
          code: 'AMBIGUOUS_AGENT_NAME',
          message: `Multiple agents named "${input.name}" found in team "${team.name}". Cannot disambiguate.`,
        },
      };
    }

    const targetAgent = nameMatches[0];

    // 3. Cross-team safety guards
    if (targetAgent.id === team.teamLeadAgentId) {
      return {
        error: {
          code: 'CANNOT_DELETE_TEAM_LEAD',
          message: `Cannot delete "${targetAgent.name}" — they are the team lead of "${team.name}"`,
        },
      };
    }

    // Defense-in-depth: the UI restricts adding agents to multiple teams, but the data model
    // permits it. If multi-team membership exists (via REST API directly, older data, or future
    // UI changes), refuse this delete and surface an explicit error so the operator can resolve
    // memberships first.
    const agentTeams = await this.teamsStore.listTeamsByAgent(targetAgent.id);
    for (const agentTeam of agentTeams) {
      if (agentTeam.id === team.id) continue;
      if (agentTeam.teamLeadAgentId === targetAgent.id) {
        return {
          error: {
            code: 'TARGET_LEADS_OTHER_TEAM',
            message: `Cannot delete "${targetAgent.name}" — they lead team "${agentTeam.name}"`,
          },
        };
      }
      return {
        error: {
          code: 'TARGET_BELONGS_TO_OTHER_TEAM',
          message: `Cannot delete "${targetAgent.name}" — they also belong to team "${agentTeam.name}". Remove them from that team first.`,
        },
      };
    }

    // 4. Auto-terminate running sessions (best-effort)
    try {
      const sessionsService = this.getSessionsService();
      const activeSessions = await sessionsService.listActiveSessions(
        input.projectId,
        new Set([targetAgent.id]),
      );
      for (const session of activeSessions) {
        try {
          await sessionsService.terminateSession(session.id);
        } catch (error) {
          logger.error(
            { sessionId: session.id, agentId: targetAgent.id, error },
            'Failed to terminate session before agent deletion',
          );
        }
      }
    } catch (error) {
      logger.error(
        { agentId: targetAgent.id, error },
        'Failed to list active sessions before agent deletion',
      );
    }

    // 5. Capture pre-delete data
    const preDeleteData = {
      teamId: team.id,
      teamName: team.name,
      teamLeadAgentId: team.teamLeadAgentId,
      removedAgentId: targetAgent.id,
      removedAgentName: targetAgent.name,
    };

    // 6. Delete agent
    try {
      await this.storage.deleteAgent(targetAgent.id);
    } catch (error) {
      if (error instanceof ConflictError) {
        return {
          error: { code: 'AGENT_HAS_RUNNING_SESSIONS', message: error.message },
        };
      }
      throw error;
    }

    // 7. Cleanup presets
    try {
      await this.settingsService.removeAgentFromProjectPresets(
        input.projectId,
        preDeleteData.removedAgentName,
      );
    } catch (error) {
      logger.error(
        {
          agentId: preDeleteData.removedAgentId,
          projectId: input.projectId,
          agentName: preDeleteData.removedAgentName,
          teamId: preDeleteData.teamId,
          error,
        },
        'Failed to remove agent from project presets after team-agent deletion',
      );
      throw error;
    }

    // 8. Publish events (best-effort)
    try {
      const eventNames = await this.resolveTeamEventNames(
        input.projectId,
        preDeleteData.teamLeadAgentId,
      );
      await this.eventsService?.publish('team.member.removed', {
        teamId: preDeleteData.teamId,
        projectId: input.projectId,
        teamLeadAgentId: preDeleteData.teamLeadAgentId,
        teamName: preDeleteData.teamName,
        removedAgentId: preDeleteData.removedAgentId,
        removedAgentName: preDeleteData.removedAgentName,
        projectName: eventNames.projectName,
        recipientIds: this.buildLeadRecipientIds(preDeleteData.teamLeadAgentId),
        agentName: preDeleteData.removedAgentName,
        teamLeadAgentName: eventNames.teamLeadAgentName,
      });
    } catch (error) {
      logger.error(
        { agentId: targetAgent.id, teamId: team.id, error },
        'Failed to publish team.member.removed event',
      );
    }

    try {
      await this.eventsService?.publish('agent.deleted', {
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        projectId: input.projectId,
        actor: { type: 'agent' as const, id: input.leadAgentId },
        teamId: team.id,
        teamName: team.name,
      });
    } catch (error) {
      logger.error(
        { agentId: targetAgent.id, projectId: input.projectId, error },
        'Failed to publish agent.deleted event',
      );
    }

    // 8. Return result
    return {
      result: {
        deletedAgentId: targetAgent.id,
        deletedAgentName: targetAgent.name,
        teamName: team.name,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Mobile chat-tunnel agent create/delete facades (MobileAddAgent T2).
  // The cloud-tunnel module composes these via TeamsService (never TeamsStore),
  // so the team-domain validation + event enrichment stay in one place.
  // ---------------------------------------------------------------------------

  /**
   * `chat.createTeamAgent` facade: resolve the team (assert it belongs to `projectId`, reject a
   * lead-less team), then delegate to {@link createTeamAgentForRest} with the team's own lead as
   * the actor (DEC-2: human-initiated, NOT gated on `allowTeamLeadCreateAgents`, mirroring REST).
   * `createTeamAgentForRest` validates profile-linked-to-team + per-project name-uniqueness, and
   * creates atomically under the member cap (emitting `agent.created` + `team.member.added`).
   */
  async createTeamAgentForChat(input: {
    projectId: string;
    teamId: string;
    name: string;
    providerConfigId: string;
    description?: string;
  }): Promise<Agent> {
    const team = await this.teamsStore.getTeam(input.teamId);
    if (!team) {
      throw new NotFoundError('Team', input.teamId);
    }
    if (team.projectId !== input.projectId) {
      throw new ForbiddenError('Team does not belong to the requested project', {
        code: 'TEAM_PROJECT_MISMATCH',
        teamId: input.teamId,
        projectId: input.projectId,
      });
    }
    if (team.teamLeadAgentId === null) {
      throw new ValidationError('Team has no lead');
    }
    return this.createTeamAgentForRest({
      actorLeadAgentId: team.teamLeadAgentId,
      projectId: input.projectId,
      teamId: input.teamId,
      providerConfigId: input.providerConfigId,
      name: input.name,
      description: input.description,
    });
  }

  /**
   * `chat.createIndependentAgent` facade: create a standalone (team-less) agent. Validates
   * provider-config ownership + profile project scoping (mirror agents.controller), then applies
   * a NEW case-insensitive per-project name-uniqueness guard.
   *
   * NEW BEHAVIOR (not a mirror): the REST `POST /api/agents` path does NOT dedupe agent names
   * (there is no DB unique index on `agents.name`), so this introduces an intentional
   * desktop/mobile asymmetry — the mobile create path refuses a duplicate name for parity with
   * the team-create path. The scan is non-atomic (pre-existing race, accepted for v1).
   */
  async createIndependentAgentForChat(input: {
    projectId: string;
    name: string;
    profileId: string;
    providerConfigId: string;
    description?: string;
  }): Promise<Agent> {
    // Project-guard the selected profile FIRST — prove it belongs to this project
    // before any config lookup, so config validation can never run against an
    // out-of-project profile and a foreign profile id is never revealed.
    const profile = await this.storage.getAgentProfile(input.profileId);
    if (profile.projectId !== input.projectId) {
      throw new ForbiddenError('Profile does not belong to the requested project', {
        code: 'PROFILE_PROJECT_MISMATCH',
        profileId: input.profileId,
        projectId: input.projectId,
      });
    }

    let config;
    try {
      config = await this.storage.getProfileProviderConfig(input.providerConfigId);
    } catch (error) {
      // Only the expected "config does not exist" becomes CONFIG_NOT_FOUND; never
      // swallow an arbitrary storage failure as a not-found.
      if (error instanceof NotFoundError) {
        throw new ValidationError('Provider config not found', {
          code: 'CONFIG_NOT_FOUND',
          configId: input.providerConfigId,
        });
      }
      throw error;
    }
    if (config.profileId !== input.profileId) {
      // Reject without revealing the config's owning profile id — it may belong to
      // another project's profile and must never be leaked to the client.
      throw new ValidationError('Provider config does not belong to the selected profile', {
        code: 'CONFIG_PROFILE_MISMATCH',
        configId: input.providerConfigId,
        expectedProfileId: input.profileId,
      });
    }

    // NEW per-project name-uniqueness guard (replicates the team-create path).
    const { items: existingAgents } = await this.storage.listAgents(input.projectId, {
      limit: 10000,
    });
    const trimmedName = input.name.trim().toLowerCase();
    if (existingAgents.some((a) => a.name.trim().toLowerCase() === trimmedName)) {
      throw new ConflictError(`An agent named "${input.name}" already exists in this project`);
    }

    const effectiveDescription = input.description?.trim() || config.description?.trim() || '';
    const agent = await this.storage.createAgent({
      projectId: input.projectId,
      profileId: input.profileId,
      providerConfigId: input.providerConfigId,
      name: input.name,
      description: effectiveDescription,
    });

    try {
      await this.eventsService?.publish('agent.created', {
        agentId: agent.id,
        agentName: agent.name,
        projectId: input.projectId,
        profileId: input.profileId,
        providerConfigId: input.providerConfigId,
        actor: null,
      });
    } catch (error) {
      logger.error(
        { agentId: agent.id, projectId: input.projectId, error },
        'Failed to publish agent.created event',
      );
    }

    return agent;
  }

  /**
   * `chat.deleteAgent` facade — the explicit non-lead delete contract (NOT routed through
   * {@link deleteTeamAgent}; different actor model). The caller has already asserted the agent
   * belongs to `projectId`.
   *
   * 1. ALL-TEAMS lead guard: reject (`AGENT_IS_TEAM_LEAD`) if the agent leads ANY team in the
   *    project — stricter than `deleteTeamAgent`'s single-team check; server-enforced even if the
   *    UI is bypassed.
   * 2. Capture pre-delete team-membership metadata BEFORE the cascade removes the rows.
   * 3. `storage.deleteAgent` (transactional: rejects running sessions, deletes stopped/failed,
   *    auto-disbands an emptied team, cascades `team_members`). DEC-3: NO auto-terminate — a
   *    `ConflictError` is surfaced as structured `AGENT_HAS_RUNNING_SESSIONS` (with the count).
   * 4. Best-effort preset cleanup (swallow on failure — the agent is already deleted; true
   *    best-effort, unlike the REST path which re-throws).
   * 5. Publish `agent.deleted`, plus `team.member.removed` (with full enrichment) for each team
   *    the agent was a member of — the generic delete path does NOT emit member-removed.
   */
  async deleteAgentForChat(input: { projectId: string; agentId: string }): Promise<void> {
    const agent = await this.storage.getAgent(input.agentId);

    const ledTeams = (await this.teamsStore.getTeamLeadTeams(input.agentId)).filter(
      (t) => t.projectId === input.projectId,
    );
    if (ledTeams.length > 0) {
      throw new ConflictError(
        `Cannot delete "${agent.name}" — they are the lead of team "${ledTeams[0].name}"`,
        {
          code: 'AGENT_IS_TEAM_LEAD',
          agentId: input.agentId,
          teamId: ledTeams[0].id,
          teamName: ledTeams[0].name,
        },
      );
    }

    // Capture membership BEFORE delete (the cascade clears team_members).
    const memberTeams = (await this.teamsStore.listTeamsByAgent(input.agentId)).filter(
      (t) => t.projectId === input.projectId,
    );

    try {
      await this.storage.deleteAgent(input.agentId);
    } catch (error) {
      if (error instanceof ConflictError) {
        // The delegate embeds the running-session count in the message; surface it structurally.
        const match = /(\d+)\s+active session/.exec(error.message);
        throw new ConflictError(error.message, {
          code: 'AGENT_HAS_RUNNING_SESSIONS',
          agentId: input.agentId,
          runningSessions: match ? Number(match[1]) : undefined,
        });
      }
      throw error;
    }

    // Best-effort preset cleanup (swallow — the delete already committed).
    try {
      await this.settingsService.removeAgentFromProjectPresets(input.projectId, agent.name);
    } catch (error) {
      logger.error(
        { agentId: input.agentId, projectId: input.projectId, agentName: agent.name, error },
        'Failed to remove agent from project presets after deletion',
      );
    }

    // team.member.removed (full enrichment) per team the agent was a member of.
    for (const team of memberTeams) {
      try {
        const eventNames = await this.resolveTeamEventNames(input.projectId, team.teamLeadAgentId);
        await this.eventsService?.publish('team.member.removed', {
          teamId: team.id,
          projectId: input.projectId,
          teamLeadAgentId: team.teamLeadAgentId,
          teamName: team.name,
          removedAgentId: agent.id,
          removedAgentName: agent.name,
          projectName: eventNames.projectName,
          recipientIds: this.buildLeadRecipientIds(team.teamLeadAgentId),
          agentName: agent.name,
          teamLeadAgentName: eventNames.teamLeadAgentName,
        });
      } catch (error) {
        logger.error(
          { agentId: input.agentId, teamId: team.id, error },
          'Failed to publish team.member.removed event',
        );
      }
    }

    // agent.deleted — human-initiated (actor: null), mirroring the generic controller delete.
    try {
      await this.eventsService?.publish('agent.deleted', {
        agentId: agent.id,
        agentName: agent.name,
        projectId: input.projectId,
        actor: null,
        teamId: memberTeams[0]?.id ?? null,
        teamName: memberTeams[0]?.name ?? null,
      });
    } catch (error) {
      logger.error(
        { agentId: input.agentId, projectId: input.projectId, error },
        'Failed to publish agent.deleted event',
      );
    }
  }
}
