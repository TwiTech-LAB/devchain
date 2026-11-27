import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FileSyncStatusQuerySchema, type FileSyncStatusResponse } from './file-sync-status.dto';
import { FileSyncStatusService } from './file-sync-status.service';

@ApiTags('file-sync')
@Controller('api/remotes/file-sync')
export class FileSyncStatusController {
  constructor(private readonly status: FileSyncStatusService) {}

  @Get('status')
  @ApiOperation({ summary: 'Read the measured file sync status of each project on a VM' })
  @ApiQuery({ name: 'projectId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'details', required: false, schema: { type: 'string', enum: ['true'] } })
  @ApiResponse({ status: 200, description: "Status read from this PC's Syncthing only" })
  async read(@Query() query: unknown): Promise<FileSyncStatusResponse> {
    const { projectId, details } = FileSyncStatusQuerySchema.parse(query);
    return this.status.status({ projectId, details: details === 'true' });
  }
}
