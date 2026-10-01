import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createLogger } from '../../common/logging/logger';
import {
  FolderIdSchema,
  SyncDeviceSchema,
  SyncFolderPatchSchema,
  SyncFolderRequestSchema,
  SyncStatusQuerySchema,
  type FolderSyncStatus,
  type SyncDevice,
  type SyncFolder,
} from './file-sync.dto';
import { FileSyncService } from './file-sync.service';

import { SyncthingRestError } from './syncthing-rest.client';

const logger = createLogger('HostSyncController');

/**
 * Routes a home instance calls to drive the host's Syncthing. Served by every
 * instance; the host resolves folder paths from its own project rows.
 */
@Controller('api/host/sync')
export class HostSyncController {
  constructor(private readonly fileSync: FileSyncService) {}

  @Get('device')
  device(): SyncDevice {
    return this.fileSync.device();
  }

  @Post('peer')
  @HttpCode(204)
  async peer(@Body() body: unknown): Promise<void> {
    const peer = SyncDeviceSchema.parse(body);
    logger.info({ deviceId: peer.deviceId }, 'POST /api/host/sync/peer');
    await this.fileSync.addPeer(peer);
  }

  @Post('folders')
  @HttpCode(200)
  folders(@Body() body: unknown): Promise<SyncFolder> {
    const request = SyncFolderRequestSchema.parse(body);
    logger.info(
      { projectId: request.projectId, kind: request.kind, type: request.type },
      'POST /api/host/sync/folders',
    );
    return this.fileSync.ensureFolder(request);
  }

  @Patch('folders/:id')
  @HttpCode(204)
  async updateFolder(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    const folderId = FolderIdSchema.parse(id);
    const patch = SyncFolderPatchSchema.parse(body);
    logger.info({ folderId, ...patch }, 'PATCH /api/host/sync/folders/:id');
    try {
      await this.fileSync.updateFolder(folderId, patch);
    } catch (error) {
      if (error instanceof SyncthingRestError && error.status === 404) {
        throw new NotFoundException('Sync folder not found');
      }
      throw error;
    }
  }

  @Delete('folders/:id')
  @HttpCode(204)
  async removeFolder(@Param('id') id: string): Promise<void> {
    const folderId = FolderIdSchema.parse(id);
    logger.info({ folderId }, 'DELETE /api/host/sync/folders/:id');
    await this.fileSync.removeFolder(folderId);
  }

  @Post('folders/:id/scan')
  @HttpCode(204)
  async scan(@Param('id') id: string): Promise<void> {
    await this.fileSync.rescan(FolderIdSchema.parse(id));
  }

  /** Discards the host's local changes in a receive-only folder. */
  @Post('folders/:id/revert')
  @HttpCode(204)
  async revert(@Param('id') id: string): Promise<void> {
    const folderId = FolderIdSchema.parse(id);
    logger.info({ folderId }, 'POST /api/host/sync/folders/:id/revert');
    await this.fileSync.revertLocalChanges(folderId);
  }

  @Get('status')
  status(@Query() query: unknown): Promise<FolderSyncStatus> {
    const { folder, device } = SyncStatusQuerySchema.parse(query);
    return this.fileSync.status(folder, device);
  }
}
