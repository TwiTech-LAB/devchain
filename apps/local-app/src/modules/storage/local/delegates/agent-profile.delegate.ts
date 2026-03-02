import type { SQL } from 'drizzle-orm';
import type { ListResult, ProfileListOptions } from '../../interfaces/storage.interface';
import type {
  AgentProfile,
  CreateAgentProfile,
  UpdateAgentProfile,
} from '../../models/domain.models';
import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export interface AgentProfileStorageDelegateDependencies {
  getAgentProfile: (id: string) => Promise<AgentProfile>;
  listAgentProfiles: (options?: ProfileListOptions) => Promise<ListResult<AgentProfile>>;
}

export class AgentProfileStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: AgentProfileStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createAgentProfile(data: CreateAgentProfile): Promise<AgentProfile> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { agentProfiles } = await import('../../db/schema');

    const profile: AgentProfile = {
      id: randomUUID(),
      projectId: data.projectId ?? null,
      name: data.name,
      familySlug: data.familySlug ?? null,
      systemPrompt: data.systemPrompt ?? null,
      instructions: data.instructions ?? null,
      temperature: data.temperature ?? null,
      maxTokens: data.maxTokens ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(agentProfiles).values({
      id: profile.id,
      projectId: profile.projectId,
      name: profile.name,
      familySlug: profile.familySlug,
      systemPrompt: profile.systemPrompt,
      instructions: profile.instructions,
      temperature: profile.temperature != null ? Math.round(profile.temperature * 100) : null,
      maxTokens: profile.maxTokens,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });

    return profile;
  }

  async getAgentProfile(id: string): Promise<AgentProfile> {
    const { agentProfiles } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const result = await this.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, id))
      .limit(1);
    if (!result[0]) {
      throw new NotFoundError('Agent profile', id);
    }
    const profile = result[0];
    return {
      ...profile,
      temperature: profile.temperature != null ? profile.temperature / 100 : null,
    } as AgentProfile;
  }

  async listAgentProfiles(options: ProfileListOptions = {}): Promise<ListResult<AgentProfile>> {
    const { agentProfiles } = await import('../../db/schema');
    const { eq, isNull } = await import('drizzle-orm');
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    let whereClause: SQL | undefined;
    if (options.projectId !== undefined) {
      whereClause =
        options.projectId === null
          ? isNull(agentProfiles.projectId)
          : eq(agentProfiles.projectId, options.projectId);
    }

    const items = await this.db
      .select()
      .from(agentProfiles)
      .where(whereClause)
      .limit(limit)
      .offset(offset);

    return {
      items: items.map((p) => ({
        ...p,
        temperature: p.temperature != null ? p.temperature / 100 : null,
      })) as AgentProfile[],
      total: items.length,
      limit,
      offset,
    };
  }

  async updateAgentProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile> {
    const { agentProfiles } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const updateData: Record<string, unknown> = { ...data };
    if (data.temperature !== undefined && data.temperature !== null) {
      updateData.temperature = Math.round(data.temperature * 100);
    }
    if (data.temperature === null) {
      updateData.temperature = null;
    }
    if (data.instructions !== undefined) {
      updateData.instructions = data.instructions ?? null;
    }
    if (data.familySlug !== undefined) {
      updateData.familySlug = data.familySlug ?? null;
    }

    await this.db
      .update(agentProfiles)
      .set({ ...updateData, updatedAt: now })
      .where(eq(agentProfiles.id, id));

    return this.dependencies.getAgentProfile(id);
  }

  async deleteAgentProfile(id: string): Promise<void> {
    const { agentProfiles } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(agentProfiles).where(eq(agentProfiles.id, id));
  }

  async setAgentProfilePrompts(profileId: string, promptIdsOrdered: string[]): Promise<void> {
    const { agentProfilePrompts, prompts } = await import('../../db/schema');
    const { eq, inArray } = await import('drizzle-orm');

    // Validate profile exists and obtain its projectId
    const profile = await this.dependencies.getAgentProfile(profileId);

    // Validate provided prompts exist and belong to same project
    if (promptIdsOrdered.length > 0) {
      const items = await this.db
        .select({ id: prompts.id, projectId: prompts.projectId })
        .from(prompts)
        .where(inArray(prompts.id, promptIdsOrdered));

      const foundIds = new Set(items.map((i) => i.id));
      const missing = promptIdsOrdered.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ValidationError('Unknown prompt ids provided', { missing });
      }

      // Enforce project scoping: prompt.projectId must equal profile.projectId
      const crossProject = items.filter((i) => i.projectId !== (profile.projectId ?? null));
      if (crossProject.length > 0) {
        throw new ValidationError('Cross-project prompts are not allowed for this profile', {
          profileProjectId: profile.projectId ?? null,
          promptIds: crossProject.map((i) => i.id),
        });
      }
    }

    // Replace assignments atomically
    await this.db.transaction(async (tx) => {
      await tx.delete(agentProfilePrompts).where(eq(agentProfilePrompts.profileId, profileId));

      if (promptIdsOrdered.length === 0) return;

      const base = new Date();
      const rows = promptIdsOrdered.map((pid, idx) => ({
        profileId,
        promptId: pid,
        createdAt: new Date(base.getTime() + idx).toISOString(),
      }));
      await tx.insert(agentProfilePrompts).values(rows);
    });
  }

  async getAgentProfilePrompts(
    profileId: string,
  ): Promise<Array<{ promptId: string; createdAt: string }>> {
    const { agentProfilePrompts } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');
    const rows = await this.db
      .select({ promptId: agentProfilePrompts.promptId, createdAt: agentProfilePrompts.createdAt })
      .from(agentProfilePrompts)
      .where(eq(agentProfilePrompts.profileId, profileId))
      .orderBy(asc(agentProfilePrompts.createdAt));
    return rows as Array<{ promptId: string; createdAt: string }>;
  }

  async getAgentProfileWithPrompts(
    id: string,
  ): Promise<
    AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }
  > {
    const profile = await this.dependencies.getAgentProfile(id);
    const { agentProfilePrompts, prompts } = await import('../../db/schema');
    const { eq, asc } = await import('drizzle-orm');
    const rows = await this.db
      .select({
        promptId: agentProfilePrompts.promptId,
        createdAt: agentProfilePrompts.createdAt,
        title: prompts.title,
      })
      .from(agentProfilePrompts)
      .innerJoin(prompts, eq(agentProfilePrompts.promptId, prompts.id))
      .where(eq(agentProfilePrompts.profileId, id))
      .orderBy(asc(agentProfilePrompts.createdAt));
    const promptsDetailed = rows.map((row, idx) => ({
      promptId: row.promptId as string,
      title: row.title as string,
      order: idx + 1,
    }));
    return { ...profile, prompts: promptsDetailed };
  }

  async listAgentProfilesWithPrompts(options: ProfileListOptions = {}): Promise<
    ListResult<
      AgentProfile & {
        prompts: Array<{ promptId: string; title: string; order: number }>;
        provider?: { id: string; name: string };
      }
    >
  > {
    const base = await this.dependencies.listAgentProfiles(options);
    if (!base.items.length) return { ...base, items: [] };
    const ids = base.items.map((p) => p.id);
    const { agentProfilePrompts, prompts, profileProviderConfigs, providers } = await import(
      '../../db/schema'
    );
    const { inArray, asc, eq } = await import('drizzle-orm');

    // Fetch prompts for all profiles
    const promptRows = await this.db
      .select({
        profileId: agentProfilePrompts.profileId,
        promptId: agentProfilePrompts.promptId,
        createdAt: agentProfilePrompts.createdAt,
        title: prompts.title,
      })
      .from(agentProfilePrompts)
      .innerJoin(prompts, eq(agentProfilePrompts.promptId, prompts.id))
      .where(inArray(agentProfilePrompts.profileId, ids))
      .orderBy(asc(agentProfilePrompts.profileId), asc(agentProfilePrompts.createdAt));

    const groupedPrompts = new Map<
      string,
      Array<{ promptId: string; title: string; createdAt: string }>
    >();
    for (const r of promptRows) {
      const pid = r.profileId as string;
      const arr = groupedPrompts.get(pid) ?? [];
      arr.push({
        promptId: r.promptId as string,
        title: r.title as string,
        createdAt: r.createdAt as string,
      });
      groupedPrompts.set(pid, arr);
    }

    // Fetch provider configs for all profiles (batch load to avoid N+1)
    const configRows = await this.db
      .select({
        profileId: profileProviderConfigs.profileId,
        providerId: profileProviderConfigs.providerId,
        createdAt: profileProviderConfigs.createdAt,
      })
      .from(profileProviderConfigs)
      .where(inArray(profileProviderConfigs.profileId, ids))
      .orderBy(asc(profileProviderConfigs.profileId), asc(profileProviderConfigs.createdAt));

    // Get unique provider IDs
    const providerIds = [...new Set(configRows.map((r) => r.providerId as string))];

    // Fetch provider details
    const providerMap = new Map<string, { id: string; name: string }>();
    if (providerIds.length > 0) {
      const providerRows = await this.db
        .select({ id: providers.id, name: providers.name })
        .from(providers)
        .where(inArray(providers.id, providerIds));
      for (const p of providerRows) {
        providerMap.set(p.id as string, { id: p.id as string, name: p.name as string });
      }
    }

    // Group configs by profile (use first config's provider for badge)
    const firstProviderByProfile = new Map<string, { id: string; name: string }>();
    for (const r of configRows) {
      const pid = r.profileId as string;
      if (!firstProviderByProfile.has(pid)) {
        const provider = providerMap.get(r.providerId as string);
        if (provider) {
          firstProviderByProfile.set(pid, provider);
        }
      }
    }

    const items = base.items.map((p) => {
      const arr = groupedPrompts.get(p.id) ?? [];
      const promptsDetailed = arr.map((row, idx) => ({
        promptId: row.promptId,
        title: row.title,
        order: idx + 1,
      }));
      const provider = firstProviderByProfile.get(p.id);
      return { ...p, prompts: promptsDetailed, ...(provider && { provider }) };
    });

    return { ...base, items };
  }
}
