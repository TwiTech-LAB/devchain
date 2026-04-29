import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  TeamMemberCapReachedError,
} from '../../../common/errors/error-types';
import { SessionsService } from '../../sessions/services/sessions.service';
import {
  STORAGE_SERVICE,
  type StorageService,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type { Team, TeamMember, CreateTeam, UpdateTeam } from '../../storage/models/domain.models';
import { TeamsStore, type TeamsListOptions } from '../storage/teams.store';
import { EventsService } from '../../events/services/events.service';
import { createLogger } from '../../../common/logging/logger';

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
    @Optional() private readonly eventsService?: EventsService,
  ) {}

  private getSessionsService(): SessionsService {
    if (!this.sessionsServiceRef) {
      this.sessionsServiceRef = this.moduleRef.get(SessionsService, { strict: false });
    }
    return this.sessionsServiceRef;
  }

  async createTeam(data: CreateTeam): Promise<Team> {
    // De-duplicate memberAgentIds and profileIds silently
    const uniqueMembers = [...new Set(data.memberAgentIds)];
    const uniqueProfileIds = data.profileIds ? [...new Set(data.profileIds)] : undefined;
    const teamLeadAgentId = data.teamLeadAgentId ?? null;

    // Rule 2: at least 1 member
    if (uniqueMembers.length < 1) {
      throw new ValidationError('A team must have at least 1 member');
    }

    // Rule 1: team lead must be in members
    if (teamLeadAgentId !== null && !uniqueMembers.includes(teamLeadAgentId)) {
      throw new ValidationError('Team lead must be included in the members list');
    }

    // Rule 3: all agents belong to same project
    await this.validateAgentsInProject(data.projectId, uniqueMembers);

    // Validate profiles belong to same project
    if (uniqueProfileIds && uniqueProfileIds.length > 0) {
      await this.validateProfilesInProject(data.projectId, uniqueProfileIds);
    }

    // Dedupe profileConfigSelections
    const dedupedSelections = this.dedupeProfileConfigSelections(data.profileConfigSelections);
    // Validate selections against profiles and config consistency
    if (dedupedSelections && dedupedSelections.length > 0) {
      const effectiveProfileIds = uniqueProfileIds ?? [];
      this.validateSelectionsAgainstProfiles(dedupedSelections, effectiveProfileIds);
      await this.validateConfigProfileConsistency(dedupedSelections);
    }
    // Drop empty configIds (auto-revert)
    const filteredSelections = dedupedSelections?.filter((s) => s.configIds.length > 0);

    // Capacity validation
    const effectiveMaxMembers = data.maxMembers ?? 5;
    const effectiveMaxConcurrentTasks = data.maxConcurrentTasks ?? effectiveMaxMembers;
    if (effectiveMaxConcurrentTasks > effectiveMaxMembers) {
      throw new ValidationError('maxConcurrentTasks cannot exceed maxMembers');
    }
    const nonLeadCount = uniqueMembers.filter((id) => id !== teamLeadAgentId).length;
    if (nonLeadCount > effectiveMaxMembers) {
      throw new ValidationError('Initial team exceeds maxMembers');
    }

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

  async updateTeam(id: string, data: UpdateTeam): Promise<Team> {
    // Fetch current team to validate cross-field consistency
    const current = await this.teamsStore.getTeam(id);
    if (!current) {
      const { NotFoundError } = await import('../../../common/errors/error-types');
      throw new NotFoundError('Team', id);
    }

    // De-duplicate memberAgentIds and profileIds when provided
    const dedupedMembers = data.memberAgentIds ? [...new Set(data.memberAgentIds)] : undefined;
    const dedupedProfileIds = data.profileIds ? [...new Set(data.profileIds)] : undefined;
    const effectiveMembers = dedupedMembers ?? current.members.map((m) => m.agentId);
    const effectiveLead =
      data.teamLeadAgentId !== undefined ? data.teamLeadAgentId : current.teamLeadAgentId;

    // Rule 2: at least 1 member (only if members are being changed)
    if (dedupedMembers !== undefined && effectiveMembers.length < 1) {
      throw new ValidationError('A team must have at least 1 member');
    }

    // Rule 1: team lead must be in members
    if (effectiveLead !== null && !effectiveMembers.includes(effectiveLead)) {
      throw new ValidationError('Team lead must be included in the members list');
    }

    // Rule 3: all agents belong to same project (only if members are being changed)
    if (dedupedMembers !== undefined) {
      await this.validateAgentsInProject(current.projectId, effectiveMembers);
    } else if (data.teamLeadAgentId !== undefined && effectiveLead !== null) {
      // Only lead changed — validate the new lead belongs to the project
      await this.validateAgentsInProject(current.projectId, [effectiveLead]);
    }

    // Validate profiles belong to same project
    if (dedupedProfileIds !== undefined && dedupedProfileIds.length > 0) {
      await this.validateProfilesInProject(current.projectId, dedupedProfileIds);
    }

    // Dedupe profileConfigSelections
    const dedupedSelections = this.dedupeProfileConfigSelections(data.profileConfigSelections);
    if (dedupedSelections && dedupedSelections.length > 0) {
      const effectiveProfileIds = dedupedProfileIds ?? current.profileIds;
      this.validateSelectionsAgainstProfiles(dedupedSelections, effectiveProfileIds);
      await this.validateConfigProfileConsistency(dedupedSelections);
    }
    const filteredSelections =
      dedupedSelections !== undefined
        ? dedupedSelections.filter((s) => s.configIds.length > 0)
        : undefined;

    // Capacity cross-field validation
    const eMM = data.maxMembers ?? current.maxMembers;
    const eMCT = data.maxConcurrentTasks ?? current.maxConcurrentTasks;
    if (eMCT > eMM) {
      throw new ValidationError('maxConcurrentTasks cannot exceed maxMembers');
    }

    // Member-count validation when members/lead/capacity change together
    if (
      dedupedMembers !== undefined ||
      data.teamLeadAgentId !== undefined ||
      data.maxMembers !== undefined
    ) {
      const finalNonLeadCount = effectiveMembers.filter((mid) => mid !== effectiveLead).length;
      if (finalNonLeadCount > eMM) {
        throw new ValidationError('Team member count exceeds maxMembers');
      }
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
      await this.eventsService?.publish('team.member.added', {
        teamId: team.id,
        projectId: input.projectId,
        teamLeadAgentId: team.teamLeadAgentId,
        teamName: team.name,
        addedAgentId: agent.id,
        addedAgentName: agent.name,
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
      await this.eventsService?.publish('team.member.added', {
        teamId: input.teamId,
        projectId: input.projectId,
        teamLeadAgentId: team.teamLeadAgentId,
        teamName: team.name,
        addedAgentId: agent.id,
        addedAgentName: agent.name,
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

    // 7. Publish events (best-effort)
    try {
      await this.eventsService?.publish('team.member.removed', {
        teamId: preDeleteData.teamId,
        projectId: input.projectId,
        teamLeadAgentId: preDeleteData.teamLeadAgentId,
        teamName: preDeleteData.teamName,
        removedAgentId: preDeleteData.removedAgentId,
        removedAgentName: preDeleteData.removedAgentName,
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

  private async validateAgentsInProject(projectId: string, agentIds: string[]): Promise<void> {
    for (const agentId of agentIds) {
      const agent = await this.storage.getAgent(agentId);
      if (agent.projectId !== projectId) {
        throw new ValidationError(`Agent "${agent.name}" belongs to a different project`, {
          agentId,
          expectedProjectId: projectId,
          actualProjectId: agent.projectId,
        });
      }
    }
  }

  private async validateProfilesInProject(projectId: string, profileIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(profileIds)];
    for (const profileId of uniqueIds) {
      const profile = await this.storage.getAgentProfile(profileId);
      if (profile.projectId !== projectId) {
        throw new ValidationError(`Profile "${profile.name}" belongs to a different project`, {
          profileId,
          expectedProjectId: projectId,
          actualProjectId: profile.projectId,
        });
      }
    }
  }

  private dedupeProfileConfigSelections(
    selections?: Array<{ profileId: string; configIds: string[] }>,
  ): Array<{ profileId: string; configIds: string[] }> | undefined {
    if (!selections) return undefined;
    const seen = new Set<string>();
    const result: Array<{ profileId: string; configIds: string[] }> = [];
    for (const sel of selections) {
      if (seen.has(sel.profileId)) continue;
      seen.add(sel.profileId);
      result.push({ profileId: sel.profileId, configIds: [...new Set(sel.configIds)] });
    }
    return result;
  }

  private validateSelectionsAgainstProfiles(
    selections: Array<{ profileId: string; configIds: string[] }>,
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

  private async validateConfigProfileConsistency(
    selections: Array<{ profileId: string; configIds: string[] }>,
  ): Promise<void> {
    for (const sel of selections) {
      for (const configId of sel.configIds) {
        const config = await this.storage.getProfileProviderConfig(configId);
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
}
