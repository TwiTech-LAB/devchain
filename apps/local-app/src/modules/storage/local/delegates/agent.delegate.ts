import type { ListOptions, ListResult } from '../../interfaces/storage.interface';
import type {
  Agent,
  AgentProfile,
  CreateAgent,
  ProfileProviderConfig,
  UpdateAgent,
} from '../../models/domain.models';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('AgentStorageDelegate');

export interface AgentStorageDelegateDependencies {
  getAgent: (id: string) => Promise<Agent>;
  getAgentProfile: (id: string) => Promise<AgentProfile>;
  getProfileProviderConfig: (id: string) => Promise<ProfileProviderConfig>;
}

export class AgentStorageDelegate extends BaseStorageDelegate {
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
      description: data.description ?? null,
      providerConfigId: data.providerConfigId,
      modelOverride: data.modelOverride ?? null,
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
      profileId: agent.profileId,
      providerConfigId: agent.providerConfigId,
      modelOverride: agent.modelOverride,
      name: agent.name,
      description: agent.description,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });

    logger.info({ agentId: agent.id, projectId: agent.projectId }, 'Created agent');
    return agent;
  }

  async getAgent(id: string): Promise<Agent> {
    const { agents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Agent', id);
    }
    return this.mapAgentRow(result[0]);
  }

  async listAgents(projectId: string, options: ListOptions = {}): Promise<ListResult<Agent>> {
    const { agents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const items = await this.db
      .select()
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .limit(limit)
      .offset(offset);

    return {
      items: items.map((item) => this.mapAgentRow(item)),
      total: items.length,
      limit,
      offset,
    };
  }

  async getAgentByName(
    projectId: string,
    name: string,
  ): Promise<Agent & { profile?: AgentProfile }> {
    const { agents } = await import('../../db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const normalized = name.toLowerCase();

    const result = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, projectId), sql`lower(${agents.name}) = ${normalized}`))
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
    const { agents } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
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

    const updatePayload: UpdateAgent = { ...data };

    await this.db
      .update(agents)
      .set({ ...updatePayload, updatedAt: now })
      .where(eq(agents.id, id));

    return this.dependencies.getAgent(id);
  }

  async deleteAgent(id: string): Promise<void> {
    const { agents, sessions } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Check for related sessions
    const relatedSessions = await this.db.select().from(sessions).where(eq(sessions.agentId, id));

    // Check if there are any running sessions
    const runningSessions = relatedSessions.filter((s) => s.status === 'running');

    if (runningSessions.length > 0) {
      throw new ConflictError(
        `Cannot delete agent: ${runningSessions.length} active session(s) are still running. Please terminate the active sessions first.`,
      );
    }

    // Automatically delete stopped/failed sessions
    const completedSessions = relatedSessions.filter(
      (s) => s.status === 'stopped' || s.status === 'failed',
    );

    if (completedSessions.length > 0) {
      logger.info(
        { agentId: id, count: completedSessions.length },
        'Auto-deleting completed sessions for agent',
      );

      for (const session of completedSessions) {
        await this.db.delete(sessions).where(eq(sessions.id, session.id));
      }
    }

    await this.db.delete(agents).where(eq(agents.id, id));
    logger.info({ agentId: id, deletedSessions: completedSessions.length }, 'Deleted agent');
  }

  private mapAgentRow(row: {
    id: string;
    projectId: string;
    profileId: string;
    providerConfigId: string;
    modelOverride?: string | null;
    name: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
  }): Agent {
    return {
      id: row.id,
      projectId: row.projectId,
      profileId: row.profileId,
      providerConfigId: row.providerConfigId,
      modelOverride: row.modelOverride ?? null,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
