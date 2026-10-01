import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { SettingsService } from '../services/settings.service';
import { SettingsDto, SettingsSchema } from '../dtos/settings.dto';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, PromptStorage } from '../../storage/interfaces/storage.interface';
import { NotFoundError } from '../../../common/errors/error-types';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';

// Schema for per-project auto-clean status update
const AutoCleanStatusIdsSchema = z.object({
  statusIds: z.array(z.string().uuid()),
});

const logger = createLogger('SettingsController');

@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: PromptStorage,
    private readonly admission: ProjectWriteAdmissionService,
  ) {}

  @Get()
  getSettings(): SettingsDto {
    logger.info('GET /api/settings');
    return this.settingsService.getSettings();
  }

  @Put()
  async updateSettings(@Body() body: unknown): Promise<SettingsDto> {
    logger.info('PUT /api/settings');
    const settings = SettingsSchema.parse(body);
    this.assertProjectSlicesWritable(settings);

    if (settings.initialSessionPromptId) {
      if (!settings.projectId && !settings.initialSessionPromptIds) {
        throw new BadRequestException({
          message: 'projectId is required when setting initialSessionPromptId',
          field: 'projectId',
        });
      }
      try {
        await this.storage.getPrompt(settings.initialSessionPromptId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new BadRequestException({
            message: 'Selected initial session prompt does not exist.',
            field: 'initialSessionPromptId',
          });
        }
        throw error;
      }
    }

    return this.settingsService.updateSettings(settings);
  }

  /**
   * Update auto-clean status IDs for a specific project.
   * Merges with existing autoClean.statusIds mapping.
   */
  @Post('autoclean/:projectId')
  async updateAutoCleanStatusIds(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<{ statusIds: string[] }> {
    logger.info({ projectId }, 'POST /api/settings/autoclean/:projectId');

    const parsed = AutoCleanStatusIdsSchema.parse(body);
    this.admission.assertWritable(projectId);

    // Get existing settings and merge
    const currentSettings = this.settingsService.getSettings();
    const existingMap = currentSettings.autoClean?.statusIds ?? {};

    await this.settingsService.updateSettings({
      autoClean: {
        statusIds: {
          ...existingMap,
          [projectId]: parsed.statusIds,
        },
      },
    });

    return { statusIds: parsed.statusIds };
  }

  /**
   * Project-keyed maps are stored whole, so an update changes a project when
   * its entry differs from the stored one, including by being left out.
   */
  private assertProjectSlicesWritable(update: SettingsDto): void {
    this.admission.assertWritable(update.projectId);
    const blocked = this.admission.listNonWritableProjectIds();
    if (blocked.length === 0) return;

    const current = this.settingsService.getSettings();
    const maps: Array<[Record<string, unknown> | undefined, Record<string, unknown> | undefined]> =
      [
        [update.initialSessionPromptIds, current.initialSessionPromptIds],
        [update.autoClean?.statusIds, current.autoClean?.statusIds],
        [update.messagePool?.projects, current.messagePool?.projects],
        [update.registryTemplates, current.registryTemplates],
        [update.projectPresets, current.projectPresets],
        [update.projectActivePresets, current.projectActivePresets],
      ];
    for (const [next, stored] of maps) {
      if (next === undefined) continue;
      for (const projectId of blocked) {
        if (JSON.stringify(next[projectId]) !== JSON.stringify(stored?.[projectId])) {
          this.admission.assertWritable(projectId);
        }
      }
    }
  }
}
