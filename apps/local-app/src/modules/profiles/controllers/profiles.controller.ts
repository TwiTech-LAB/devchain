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
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import {
  CreateAgentProfile,
  UpdateAgentProfile,
  AgentProfile,
} from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { AgentProfileWithPrompts, AgentProfileWithPromptsSchema } from '../dto';
import { ValidationError } from '../../../common/errors/error-types';

const logger = createLogger('ProfilesController');

const CreateProfileSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().min(1),
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
  options: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }
      if (value === null) {
        return null;
      }
      const trimmed = value.trim();
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
    await this.storage.deleteAgentProfile(id);
  }
}
