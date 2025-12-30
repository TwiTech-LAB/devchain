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
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { NotFoundError } from '../../../common/errors/error-types';

// Schema for per-project auto-clean status update
const AutoCleanStatusIdsSchema = z.object({
  statusIds: z.array(z.string().uuid()),
});

const logger = createLogger('SettingsController');

@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
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
}
