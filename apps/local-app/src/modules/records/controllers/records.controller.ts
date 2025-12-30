import { Controller, Get, Param, Query, Inject, BadRequestException } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EpicRecord } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('RecordsController');

@Controller('api/records')
export class RecordsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get()
  async listRecords(
    @Query('epicId') epicId: string,
    @Query('type') type?: string,
    @Query('tags') tags?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    logger.info({ epicId, type, tags, limit, offset }, 'GET /api/records');
    if (!epicId) {
      throw new BadRequestException('epicId query parameter required');
    }

    const options: {
      limit?: number;
      offset?: number;
    } = {};

    if (limit) {
      options.limit = parseInt(limit, 10);
    }
    if (offset) {
      options.offset = parseInt(offset, 10);
    }

    // Get all records for the epic
    const result = await this.storage.listRecords(epicId, options);

    // Apply filters
    let filtered = result.items;

    if (type) {
      filtered = filtered.filter((r) => r.type === type);
    }

    if (tags) {
      const tagArray = tags.split(',').map((t) => t.trim());
      filtered = filtered.filter((r) => {
        return tagArray.every((tag) => r.tags.includes(tag));
      });
    }

    return {
      items: filtered,
      total: filtered.length,
      limit: result.limit,
      offset: result.offset,
    };
  }

  @Get(':id')
  async getRecord(@Param('id') id: string): Promise<EpicRecord> {
    logger.info({ id }, 'GET /api/records/:id');
    return this.storage.getRecord(id);
  }
}
