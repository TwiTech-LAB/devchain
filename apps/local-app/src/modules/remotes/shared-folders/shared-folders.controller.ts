import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { ShareIdSchema } from '../../file-sync/file-sync.dto';
import type { RemoteOperation } from '../../storage/models/domain.models';
import {
  CreateSharedFolderSchema,
  UpdateSharedFolderIgnoresSchema,
  type SharedFolderDto,
  type SharedFolderEntry,
  type StopSharingResult,
} from './shared-folders.dto';
import { SharedFoldersService } from './shared-folders.service';

const logger = createLogger('SharedFoldersController');
const UuidSchema = z.string().uuid();

@ApiTags('remotes')
@Controller('api/remotes/:id/shared-folders')
export class SharedFoldersController {
  constructor(private readonly sharedFolders: SharedFoldersService) {}

  @Get()
  @ApiOperation({ summary: "List this PC's folders shared with the VM, with their state" })
  @ApiOkResponse({ description: 'Shared folders, sorted by path' })
  async list(@Param('id') id: string): Promise<{ items: SharedFolderDto[] }> {
    logger.info({ remoteId: id }, 'GET /api/remotes/:id/shared-folders');
    return { items: await this.sharedFolders.list(UuidSchema.parse(id)) };
  }

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Share a folder of this PC with the VM at the same path' })
  @ApiResponse({ status: 202, description: 'The started share operation' })
  @ApiResponse({ status: 403, description: 'The path is refused' })
  @ApiResponse({ status: 404, description: 'The folder does not exist on this PC' })
  @ApiResponse({ status: 409, description: 'The path overlaps an existing share' })
  share(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    logger.info({ remoteId: id }, 'POST /api/remotes/:id/shared-folders');
    const { path, ignores } = CreateSharedFolderSchema.parse(body);
    return this.sharedFolders.share(UuidSchema.parse(id), path, ignores);
  }

  @Delete(':shareId')
  @ApiOperation({ summary: 'Stop sharing the folder; files stay on both sides' })
  @ApiOkResponse({ description: 'Whether the VM also stopped sharing it' })
  @ApiResponse({ status: 409, description: "The share's operation is still open" })
  stop(@Param('id') id: string, @Param('shareId') shareId: string): Promise<StopSharingResult> {
    logger.info({ remoteId: id, shareId }, 'DELETE /api/remotes/:id/shared-folders/:shareId');
    return this.sharedFolders.stop(UuidSchema.parse(id), ShareIdSchema.parse(shareId));
  }

  @Put(':shareId/ignores')
  @ApiOperation({ summary: 'Save the ignore patterns and apply them on the VM and this PC' })
  @ApiOkResponse({ description: 'The entry with patternsApplied true' })
  @ApiResponse({ status: 409, description: "The share's operation is still open" })
  @ApiResponse({ status: 503, description: 'Saved, but a side did not apply; save again' })
  updateIgnores(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @Body() body: unknown,
  ): Promise<SharedFolderEntry> {
    logger.info({ remoteId: id, shareId }, 'PUT /api/remotes/:id/shared-folders/:shareId/ignores');
    const { ignores } = UpdateSharedFolderIgnoresSchema.parse(body);
    return this.sharedFolders.updateIgnores(
      UuidSchema.parse(id),
      ShareIdSchema.parse(shareId),
      ignores,
    );
  }
}
