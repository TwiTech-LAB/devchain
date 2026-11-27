import type {
  AgentReadOptions,
  AgentStorage,
  AgentUpdateResult,
  DeleteAgentOptions,
  ListOptions,
  ListResult,
} from '../../interfaces/storage.interface';
import type {
  Agent,
  AgentProfile,
  CreateAgent,
  ProfileProviderConfig,
  UpdateAgent,
} from '../../models/domain.models';
import {
  AgentDisabledError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { eq as eqSync } from 'drizzle-orm';
import { createLogger } from '../../../../common/logging/logger';
import { agents as agentsTable } from '../../db/schema';
import { resolveFamilyAgentIds } from '../../sessions/session-row.store';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('AgentStorageDelegate');

export interface AgentStorageDelegateDependencies {
  getAgent: (id: string) => Promise<Agent>;
  getAgentProfile: (id: string) => Promise<AgentProfile>;
  getProfileProviderConfig: (id: string) => Promise<ProfileProviderConfig>;
}

export class AgentStorageDelegate extends BaseStorageDelegate implements AgentStorage {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: AgentStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createAgent(data: CreateAgent): Promise<Agent> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { agents } = await import('../../db/schema');

    const agent: Agent = {
      id: randomUUID(),
      ...data,
      isProjectOwner: data.isProjectOwner ?? false,
      description: data.description ?? null,
      providerConfigId: data.providerConfigId,
      modelOverride: data.modelOverride ?? null,
      effortOverride: data.effortOverride ?? null,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };

    // Validate that profile belongs to the same project
    const profile = await this.dependencies.getAgentProfile(agent.profileId);
    if (profile.projectId !== agent.projectId) {
      throw new ValidationError('Agent.profileId must belong to the same project as the agent.', {
        agentProjectId: agent.projectId,
        profileProjectId: profile.projectId,
        profileId: agent.profileId,
      });
    }

    // Validate that providerConfigId exists and belongs to the specified profile
    const config = await this.dependencies.getProfileProviderConfig(agent.providerConfigId);
    if (config.profileId !== agent.profileId) {
      throw new ValidationError('Provider config does not belong to the specified profile.', {
        providerConfigId: agent.providerConfigId,
        configProfileId: config.profileId,
        expectedProfileId: agent.profileId,
      });
    }

    await this.db.insert(agents).values({
      id: agent.id,
      projectId: agent.projectId,
      isProjectOwner: agent.isProjectOwner,
      profileId: agent.profileId,
      providerConfigId: agent.providerConfigId,
      modelOverride: agent.modelOverride,
      effortOverride: agent.effortOverride,
      name: agent.name,
      description: agent.description,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });

    logger.info({ agentId: agent.id, projectId: agent.projectId }, 'Created agent');
    return agent;
  }

  async getAgent(id: string): Promise<Agent> {
    return this.getAgentSync(id);
  }

  getAgentSync(id: string): Agent {
    const row = this.db.select().from(agentsTable).where(eqSync(agentsTable.id, id)).limit(1).get();
    if (!row) {
      throw new NotFoundError('Agent', id);
    }
    return this.mapAgentRow(row);
  }

  isAgentDisabled(id: string): boolean {
    const row = this.db
      .select({ disabled: agentsTable.disabled })
      .from(agentsTable)
      .where(eqSync(agentsTable.id, id))
      .get();
    return row?.disabled ?? false;
  }

  async listAgents(
    projectId: string,
    options: ListOptions & AgentReadOptions = {},
  ): Promise<ListResult<Agent>> {
    const { agents } = await import('../../db/schema');
    const { and, eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.projectId, projectId),
          options.excludeDisabled ? eq(agents.disabled, false) : undefined,
        ),
      )
      .limit(limit)
      .offset(offset);

    return {
      items: items.map((item) => this.mapAgentRow(item)),
      total: items.length,
      limit,
      offset,
    };
  }

  async listProjectOwners(projectIds: string[]): Promise<Agent[]> {
    if (projectIds.length === 0) {
      return [];
    }

    const { agents } = await import('../../db/schema');
    const { and, eq, inArray } = await import('drizzle-orm');
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.isProjectOwner, true), inArray(agents.projectId, projectIds)));

    // The partial unique index on (project_id) for owner rows guarantees that
    // this single read can produce at most one owner for each project.
    return rows.map((row) => this.mapAgentRow(row));
  }

  async getAgentByName(
    projectId: string,
    name: string,
    options: AgentReadOptions = {},
  ): Promise<Agent & { profile?: AgentProfile }> {
    const { agents } = await import('../../db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const normalized = name.toLowerCase();

    const result = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.projectId, projectId),
          sql`lower(${agents.name}) = ${normalized}`,
          options.excludeDisabled ? eq(agents.disabled, false) : undefined,
        ),
      )
      .limit(1);

    const record = result[0];
    if (!record) {
      throw new NotFoundError('Agent', `${projectId}:${name}`);
    }

    const agent = this.mapAgentRow(record);
    const profile = await this.dependencies.getAgentProfile(agent.profileId);

    return { ...agent, profile };
  }

  async updateAgent(id: string, data: UpdateAgent): Promise<Agent> {
    return (await this.updateAgentReportingWrites(id, data)).agent;
  }

  async updateAgentReportingWrites(id: string, data: UpdateAgent): Promise<AgentUpdateResult> {
    const { agents } = await import('../../db/schema');
    const { and, eq } = await import('drizzle-orm');
    const now = new Date().toISOString();
    let currentAgent: Agent | null = null;

    // If projectId, profileId, or providerConfigId changes, validate relationships
    if (
      data.projectId !== undefined ||
      data.profileId !== undefined ||
      data.providerConfigId !== undefined
    ) {
      currentAgent = await this.dependencies.getAgent(id);
      const newProjectId = data.projectId ?? currentAgent.projectId;
      const newProfileId = data.profileId ?? currentAgent.profileId;
      const newProviderConfigId = data.providerConfigId ?? currentAgent.providerConfigId;

      // Validate profile belongs to project
      const profile = await this.dependencies.getAgentProfile(newProfileId);
      if (profile.projectId !== newProjectId) {
        throw new ValidationError('Agent.profileId must belong to the same project as the agent.', {
          agentProjectId: newProjectId,
          profileProjectId: profile.projectId,
          profileId: newProfileId,
        });
      }

      // Validate providerConfigId belongs to the profile
      const config = await this.dependencies.getProfileProviderConfig(newProviderConfigId);
      if (config.profileId !== newProfileId) {
        throw new ValidationError('Provider config does not belong to the specified profile.', {
          providerConfigId: newProviderConfigId,
          configProfileId: config.profileId,
          expectedProfileId: newProfileId,
        });
      }
    }

    if (data.isProjectOwner === true) {
      return this.txRunner.runImmediate(() => {
        const target = this.db.select().from(agents).where(eq(agents.id, id)).limit(1).get();
        if (!target) {
          throw new NotFoundError('Agent', id);
        }
        if (target.disabled) {
          throw new AgentDisabledError(target);
        }

        const projectId = target.projectId;
        const displacedOwnerIds = this.db
          .update(agents)
          .set({ isProjectOwner: false, updatedAt: now })
          .where(and(eq(agents.projectId, projectId), eq(agents.isProjectOwner, true)))
          .returning({ id: agents.id })
          .all()
          .map((row) => row.id)
          .filter((ownerId) => ownerId !== id);

        const result = this.db
          .update(agents)
          .set({ ...data, isProjectOwner: true, updatedAt: now })
          .where(eq(agents.id, id))
          .run();
        if (result.changes !== 1) {
          throw new NotFoundError('Agent', id);
        }

        const updated = this.db.select().from(agents).where(eq(agents.id, id)).limit(1).get();
        if (!updated) {
          throw new NotFoundError('Agent', id);
        }
        return { agent: this.mapAgentRow(updated), writtenAgentIds: [id, ...displacedOwnerIds] };
      });
    }

    const updatePayload: UpdateAgent = { ...data };

    await this.db
      .update(agents)
      .set({ ...updatePayload, updatedAt: now })
      .where(eq(agents.id, id));

    return { agent: await this.dependencies.getAgent(id), writtenAgentIds: [id] };
  }

  async deleteAgent(id: string, options: DeleteAgentOptions = {}): Promise<void> {
    const { agents, sessions, teamMembers, teams } = await import('../../db/schema');
    const { and, eq, inArray, sql } = await import('drizzle-orm');

    this.txRunner.runImmediate(() => {
      if (options.protectProjectOwner || options.protectTeamLead || options.protectDisabled) {
        const target = this.db
          .select({
            projectId: agents.projectId,
            isProjectOwner: agents.isProjectOwner,
            name: agents.name,
            disabled: agents.disabled,
          })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1)
          .get();

        if (options.protectDisabled && target?.disabled) {
          throw new AgentDisabledError({ id, name: target.name });
        }

        if (options.protectProjectOwner && target?.isProjectOwner) {
          throw new ConflictError(`Cannot delete "${target.name}" — they are the Project Owner`, {
            code: 'AGENT_IS_PROJECT_OWNER',
            agentId: id,
            projectId: target.projectId,
          });
        }

        if (options.protectTeamLead) {
          const ledTeam = this.db
            .select({ id: teams.id, name: teams.name, projectId: teams.projectId })
            .from(teams)
            .where(eq(teams.teamLeadAgentId, id))
            .limit(1)
            .get();

          if (ledTeam) {
            throw new ConflictError(
              `Cannot delete "${target?.name ?? id}" — they are the lead of team "${ledTeam.name}"`,
              {
                code: 'AGENT_IS_TEAM_LEAD',
                agentId: id,
                projectId: ledTeam.projectId,
                teamId: ledTeam.id,
                teamName: ledTeam.name,
              },
            );
          }
        }
      }

      const relatedSessions = this.db.select().from(sessions).where(eq(sessions.agentId, id)).all();
      const runningSessions = relatedSessions.filter((s) => s.status === 'running');

      if (runningSessions.length > 0) {
        throw new ConflictError(
          `Cannot delete agent: ${runningSessions.length} active session(s) are still running. Please terminate the active sessions first.`,
        );
      }

      const memberTeams = this.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.agentId, id))
        .all();

      const teamIdsToDisband: string[] = [];

      for (const memberTeam of memberTeams) {
        const countResult = this.db
          .select({ count: sql<number>`count(*)` })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, memberTeam.teamId))
          .all();

        if (Number(countResult[0]?.count ?? 0) <= 1) {
          teamIdsToDisband.push(memberTeam.teamId);
        }
      }

      const uniqueTeamIdsToDisband = [...new Set(teamIdsToDisband)];
      if (uniqueTeamIdsToDisband.length > 0) {
        logger.info(
          { agentId: id, teamIds: uniqueTeamIdsToDisband },
          'Disbanding teams that would become empty after agent deletion',
        );
        this.db.delete(teams).where(inArray(teams.id, uniqueTeamIdsToDisband)).run();
      }

      const completedSessions = relatedSessions.filter(
        (s) => s.status === 'stopped' || s.status === 'failed',
      );

      const heir = completedSessions.length > 0 ? this.findSessionHeir(id) : null;
      if (heir) {
        logger.info(
          { agentId: id, heirAgentId: heir, count: completedSessions.length },
          'Moving completed sessions of the agent to a family member',
        );
        this.db
          .update(sessions)
          .set({ agentId: heir, updatedAt: new Date().toISOString() })
          .where(and(eq(sessions.agentId, id), inArray(sessions.status, ['stopped', 'failed'])))
          .run();
      } else if (completedSessions.length > 0) {
        logger.info(
          { agentId: id, count: completedSessions.length },
          'Auto-deleting completed sessions for agent',
        );

        for (const session of completedSessions) {
          this.db.delete(sessions).where(eq(sessions.id, session.id)).run();
        }
      }

      this.db.delete(agents).where(eq(agents.id, id)).run();
      logger.info(
        {
          agentId: id,
          deletedSessions: heir ? 0 : completedSessions.length,
          movedSessions: heir ? completedSessions.length : 0,
          disbandedTeams: uniqueTeamIdsToDisband.length,
        },
        'Deleted agent',
      );
    });
  }

  /** The family member that keeps a deleted agent's sessions: enabled first, then name, then id. */
  private findSessionHeir(agentId: string): string | null {
    const members = resolveFamilyAgentIds(this.rawClient, agentId).filter((id) => id !== agentId);
    if (members.length === 0) return null;
    const heir = this.rawClient
      .prepare<{ members: string }, { id: string }>(
        `SELECT id FROM agents WHERE id IN (SELECT value FROM json_each(@members))
         ORDER BY disabled, LOWER(name), id LIMIT 1`,
      )
      .get({ members: JSON.stringify(members) });
    return heir?.id ?? null;
  }

  async disableAgent(id: string): Promise<{ agent: Agent; changed: boolean }> {
    const { agents, teamMembers, teams } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    return this.txRunner.runImmediateQueued(() => {
      const target = this.db.select().from(agents).where(eq(agents.id, id)).limit(1).get();
      if (!target) {
        throw new NotFoundError('Agent', id);
      }
      // Eligibility guards the enabled-to-disabled step only; a repeat keeps the flag as is.
      if (target.disabled) {
        return { agent: this.mapAgentRow(target), changed: false };
      }

      if (target.isProjectOwner) {
        throw new ConflictError(`Cannot disable "${target.name}" — they are the Project Owner`, {
          code: 'AGENT_IS_PROJECT_OWNER',
          agentId: id,
          projectId: target.projectId,
        });
      }

      const ledTeam = this.db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(eq(teams.teamLeadAgentId, id))
        .limit(1)
        .get();
      if (ledTeam) {
        throw new ConflictError(
          `Cannot disable "${target.name}" — they are the lead of team "${ledTeam.name}"`,
          {
            code: 'AGENT_IS_TEAM_LEAD',
            agentId: id,
            projectId: target.projectId,
            teamId: ledTeam.id,
            teamName: ledTeam.name,
          },
        );
      }

      const membership = this.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.agentId, id))
        .limit(1)
        .get();
      if (!membership) {
        throw new ConflictError(`Cannot disable "${target.name}" — they are not in a team`, {
          code: 'AGENT_NOT_IN_TEAM',
          agentId: id,
          projectId: target.projectId,
        });
      }

      const updatedAt = new Date().toISOString();
      this.db.update(agents).set({ disabled: true, updatedAt }).where(eq(agents.id, id)).run();
      logger.info({ agentId: id, projectId: target.projectId }, 'Disabled agent');
      return { agent: this.mapAgentRow({ ...target, disabled: true, updatedAt }), changed: true };
    });
  }

  async enableAgent(id: string): Promise<Agent> {
    const { agents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    return this.txRunner.runImmediateQueued(() => {
      const target = this.db.select().from(agents).where(eq(agents.id, id)).limit(1).get();
      if (!target) {
        throw new NotFoundError('Agent', id);
      }
      if (!target.disabled) {
        return this.mapAgentRow(target);
      }
      const updatedAt = new Date().toISOString();
      this.db.update(agents).set({ disabled: false, updatedAt }).where(eq(agents.id, id)).run();
      logger.info({ agentId: id, projectId: target.projectId }, 'Enabled agent');
      return this.mapAgentRow({ ...target, disabled: false, updatedAt });
    });
  }

  private mapAgentRow(row: {
    id: string;
    projectId: string;
    isProjectOwner: boolean;
    profileId: string;
    providerConfigId: string;
    modelOverride?: string | null;
    effortOverride?: string | null;
    name: string;
    description: string | null;
    disabled: boolean;
    createdAt: string;
    updatedAt: string;
  }): Agent {
    return {
      id: row.id,
      projectId: row.projectId,
      isProjectOwner: row.isProjectOwner,
      profileId: row.profileId,
      providerConfigId: row.providerConfigId,
      modelOverride: row.modelOverride ?? null,
      effortOverride: row.effortOverride ?? null,
      name: row.name,
      description: row.description,
      disabled: row.disabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
