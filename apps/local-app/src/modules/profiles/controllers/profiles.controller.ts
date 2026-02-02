import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Inject,
  Query,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import {
  CreateAgentProfile,
  UpdateAgentProfile,
  AgentProfile,
  ProfileProviderConfig,
} from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import {
  AgentProfileWithPrompts,
  AgentProfileWithPromptsSchema,
  CreateProviderConfigSchema,
  ProfileProviderConfigSchema,
  ReorderProviderConfigsSchema,
} from '../dto';
import { ValidationError } from '../../../common/errors/error-types';

const logger = createLogger('ProfilesController');

// Note: providerId and options removed in Phase 4
// Provider configuration now lives in ProfileProviderConfig (created separately)
const CreateProfileSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  familySlug: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return null;
      }
      const trimmed = value.trim().toLowerCase();
      return trimmed.length > 0 ? trimmed : null;
    }),
  systemPrompt: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().nullable().optional(),
});

const UpdateProfileSchema = CreateProfileSchema.partial();

const ReplacePromptsSchema = z.object({
  promptIds: z.array(z.string()).default([]),
});

@Controller('api/profiles')
export class ProfilesController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get()
  async listProfiles(@Query('projectId') projectId?: string) {
    logger.info({ projectId }, 'GET /api/profiles');

    // Zod-validated query parsing for parity with standards
    const QuerySchema = z.object({ projectId: z.string().min(1, 'projectId is required') });
    let parsed: { projectId: string };
    try {
      parsed = QuerySchema.parse({ projectId: projectId ?? '' });
    } catch (err) {
      throw new BadRequestException({ message: 'projectId query parameter is required' });
    }

    const res = await this.storage.listAgentProfilesWithPrompts({ projectId: parsed.projectId });
    // keep response shape: prompts[] with embedded prompt { id, title }
    const items = res.items.map((prof) => ({
      ...prof,
      prompts: prof.prompts.map((p) => ({
        promptId: p.promptId,
        order: p.order,
        prompt: { id: p.promptId, title: p.title },
      })),
    }));
    return { ...res, items };
  }

  @Get(':id')
  async getProfile(@Param('id') id: string): Promise<AgentProfileWithPrompts> {
    logger.info({ id }, 'GET /api/profiles/:id');
    const prof = await this.storage.getAgentProfileWithPrompts(id);
    const shaped = {
      ...prof,
      prompts: prof.prompts.map((p) => ({ promptId: p.promptId, title: p.title, order: p.order })),
    };
    return AgentProfileWithPromptsSchema.parse(shaped);
  }

  @Post()
  async createProfile(@Body() body: unknown): Promise<AgentProfile> {
    logger.info('POST /api/profiles');
    const data = CreateProfileSchema.parse(body) as CreateAgentProfile;
    return this.storage.createAgentProfile(data);
  }

  @Put(':id')
  async updateProfile(@Param('id') id: string, @Body() body: unknown): Promise<AgentProfile> {
    logger.info({ id }, 'PUT /api/profiles/:id');
    const parsed = UpdateProfileSchema.parse(body) as UpdateAgentProfile & {
      projectId?: string | null;
    };

    // Disallow moving profiles across projects
    if (parsed.projectId !== undefined) {
      const existing = await this.storage.getAgentProfile(id);
      if (parsed.projectId !== existing.projectId) {
        throw new BadRequestException({
          message: 'Cannot change projectId of a profile',
          field: 'projectId',
        });
      }
      // Prevent passing projectId to storage update to avoid accidental writes
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { projectId, ...updateData } = parsed;
      return this.storage.updateAgentProfile(id, updateData);
    }

    return this.storage.updateAgentProfile(id, parsed);
  }

  @Put(':id/prompts')
  async replaceProfilePrompts(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{
    profileId: string;
    prompts: Array<{ promptId: string; title: string; order: number }>;
  }> {
    logger.info({ id }, 'PUT /api/profiles/:id/prompts');
    const { promptIds } = ReplacePromptsSchema.parse(body) as { promptIds: string[] };

    // Idempotent: de-dupe while preserving order of first appearance
    const seen = new Set<string>();
    const ordered = promptIds.filter((pid) => {
      if (seen.has(pid)) return false;
      seen.add(pid);
      return true;
    });

    try {
      await this.storage.setAgentProfilePrompts(id, ordered);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }

    // Build response using joined fetch
    const detailed = await this.storage.getAgentProfileWithPrompts(id);
    return {
      profileId: id,
      prompts: detailed.prompts.map((p) => ({
        promptId: p.promptId,
        title: p.title,
        order: p.order,
      })),
    };
  }

  @Delete(':id')
  async deleteProfile(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/profiles/:id');

    // Check if any agents are using this profile
    const profile = await this.storage.getAgentProfile(id);
    if (profile.projectId) {
      const agents = await this.storage.listAgents(profile.projectId, {
        limit: 10000,
        offset: 0,
      });
      const agentsUsingProfile = agents.items.filter((a) => a.profileId === id);

      if (agentsUsingProfile.length > 0) {
        const agentNames = agentsUsingProfile.map((a) => a.name).join(', ');
        throw new ConflictException({
          message: `Cannot delete profile: ${agentsUsingProfile.length} agent(s) are still using it`,
          details: `The following agents use this profile: ${agentNames}`,
          agentCount: agentsUsingProfile.length,
          agents: agentNames,
        });
      }
    }

    await this.storage.deleteAgentProfile(id);
  }

  // ============================================
  // PROFILE PROVIDER CONFIGS
  // ============================================

  @Get(':id/provider-configs')
  async listProviderConfigs(@Param('id') profileId: string): Promise<ProfileProviderConfig[]> {
    logger.info({ profileId }, 'GET /api/profiles/:id/provider-configs');
    // Verify profile exists first
    await this.storage.getAgentProfile(profileId);
    const configs = await this.storage.listProfileProviderConfigsByProfile(profileId);
    return configs.map((c) => ProfileProviderConfigSchema.parse(c));
  }

  @Post(':id/provider-configs')
  async createProviderConfig(
    @Param('id') profileId: string,
    @Body() body: unknown,
  ): Promise<ProfileProviderConfig> {
    logger.info({ profileId }, 'POST /api/profiles/:id/provider-configs');

    // Verify profile exists first
    await this.storage.getAgentProfile(profileId);

    const data = CreateProviderConfigSchema.parse(body);

    const config = await this.storage.createProfileProviderConfig({
      profileId,
      providerId: data.providerId,
      name: data.name,
      options: data.options ?? null,
      env: data.env ?? null,
    });

    return ProfileProviderConfigSchema.parse(config);
  }

  @Put(':id/provider-configs/order')
  async reorderProviderConfigs(
    @Param('id') profileId: string,
    @Body() body: unknown,
  ): Promise<{ success: boolean }> {
    logger.info({ profileId }, 'PUT /api/profiles/:id/provider-configs/order');

    // Verify profile exists first
    await this.storage.getAgentProfile(profileId);

    // Validate request body
    const data = ReorderProviderConfigsSchema.parse(body);
    const { configIds } = data;

    // Get all configs for this profile
    const configs = await this.storage.listProfileProviderConfigsByProfile(profileId);
    const configMap = new Map(configs.map((c) => [c.id, c]));

    // Validate all configs exist and belong to this profile
    for (const configId of configIds) {
      const config = configMap.get(configId);
      if (!config) {
        throw new BadRequestException(
          `Config ${configId} not found or does not belong to profile ${profileId}`,
        );
      }
    }

    // Check for duplicates (Zod schema doesn't check for duplicates in array)
    if (new Set(configIds).size !== configIds.length) {
      throw new BadRequestException('Duplicate configIds provided');
    }

    // Validate configIds includes all configs (must be a full permutation)
    if (configIds.length !== configs.length) {
      throw new BadRequestException(
        `All configs must be included in reorder. Expected ${configs.length} configs, got ${configIds.length}.`,
      );
    }
    const allConfigIds = new Set(configs.map((c) => c.id));
    const requestConfigIds = new Set(configIds);
    for (const configId of allConfigIds) {
      if (!requestConfigIds.has(configId)) {
        throw new BadRequestException(
          `All configs must be included in reorder. Missing config: ${configId}`,
        );
      }
    }

    // Perform atomic reorder with transaction
    await this.storage.reorderProfileProviderConfigs(profileId, configIds);

    return { success: true };
  }
}
