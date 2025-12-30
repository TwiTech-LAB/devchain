import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { CreateStatus, UpdateStatus, Status } from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('StatusesController');

const CreateStatusSchema = z.object({
  projectId: z.string().uuid(),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().min(0),
  mcpHidden: z.boolean().optional().default(false),
});

const UpdateStatusSchema = z.object({
  label: z.string().min(1).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  position: z.number().int().min(0).optional(),
  mcpHidden: z.boolean().optional(),
});

@Controller('api/statuses')
export class StatusesController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get()
  async listStatuses(@Query('projectId') projectId: string) {
    logger.info({ projectId }, 'GET /api/statuses');
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.storage.listStatuses(projectId);
  }

  @Get(':id')
  async getStatus(@Param('id') id: string): Promise<Status> {
    logger.info({ id }, 'GET /api/statuses/:id');
    return this.storage.getStatus(id);
  }

  @Post()
  async createStatus(@Body() body: unknown): Promise<Status> {
    logger.info('POST /api/statuses');
    const data = CreateStatusSchema.parse(body) as CreateStatus;
    return this.storage.createStatus(data);
  }

  @Put(':id')
  async updateStatus(@Param('id') id: string, @Body() body: unknown): Promise<Status> {
    logger.info({ id }, 'PUT /api/statuses/:id');
    const data = UpdateStatusSchema.parse(body) as UpdateStatus;
    return this.storage.updateStatus(id, data);
  }

  @Delete(':id')
  async deleteStatus(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/statuses/:id');
    await this.storage.deleteStatus(id);
  }

  @Post('reorder')
  async reorderStatuses(@Body() body: { projectId: string; statusIds: string[] }) {
    logger.info({ projectId: body.projectId }, 'POST /api/statuses/reorder');

    // Update positions sequentially to avoid unique constraint conflicts
    // First pass: set all to temporary high positions
    for (let i = 0; i < body.statusIds.length; i++) {
      await this.storage.updateStatus(body.statusIds[i], { position: 1000 + i });
    }

    // Second pass: set them to their final positions
    for (let i = 0; i < body.statusIds.length; i++) {
      await this.storage.updateStatus(body.statusIds[i], { position: i });
    }

    return { success: true };
  }
}
