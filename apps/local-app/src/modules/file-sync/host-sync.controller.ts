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
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createLogger } from '../../common/logging/logger';
import {
  FolderIdSchema,
  ForceCopyBackupRequestSchema,
  RemoteNeedQuerySchema,
  SyncDeviceSchema,
  SyncFolderPatchSchema,
  SyncFolderRequestSchema,
  SyncStatusQuerySchema,
  type FolderSyncStatus,
  type RemoteNeed,
  type SyncDevice,
  type SyncFolder,
  type ForceCopyBackup,
  type ReceiveOnlyChanges,
  type SyncFolderConfiguration,
} from './file-sync.dto';
import { FileSyncService } from './file-sync.service';

import { SyncthingRestError } from './syncthing-rest.client';
import { resolve } from 'node:path';
import { assertVmHomePath } from '../../common/filesystem/vm-home-path';
import { SyncInspectRequestSchema, type SyncPathInspection } from './sync-path-inspection.dto';
import { SyncPathInspector } from './sync-path-inspector';
import { SyncChownService } from './sync-chown.service';
import { SyncChownRequestSchema, type SyncChownResult } from './sync-chown.dto';

const logger = createLogger('HostSyncController');

/**
 * Routes a home instance calls to drive the host's Syncthing. Served by every
 * instance; the host resolves folder paths from its own project rows.
 */
@Controller('api/host/sync')
@ApiTags('Host sync')
export class HostSyncController {
  constructor(
    private readonly fileSync: FileSyncService,
    private readonly inspector: SyncPathInspector,
    private readonly owners: SyncChownService,
  ) {}

  @Post('chown')
  @HttpCode(200)
  chown(@Body() body: unknown): Promise<SyncChownResult> {
    return this.owners.repair(SyncChownRequestSchema.parse(body));
  }

  @Post('inspect')
  @HttpCode(200)
  async inspect(@Body() body: unknown): Promise<SyncPathInspection> {
    const { path, scan, paths, patterns } = SyncInspectRequestSchema.parse(body);
    await assertVmHomePath(resolve(path), {
      code: 'FILE_SYNC_INSPECT_OUTSIDE_HOME',
      message: 'Inspection paths must be under the VM home',
      linkMessage: 'Inspection paths must not be links',
      rejectAncestorLinks: true,
    });
    const [inspection, user] = await Promise.all([
      this.inspector.inspect(path, scan, paths, patterns),
      this.owners.user(),
    ]);
    return user ? { ...inspection, vmUser: user } : inspection;
  }

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

  @Post('force-copy-backup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Prepare a force-copy backup path without changing a share' })
  @ApiOkResponse({ description: 'The backup directory on this host' })
  forceCopyBackup(@Body() body: unknown): Promise<ForceCopyBackup> {
    return this.fileSync.forceCopyBackup(ForceCopyBackupRequestSchema.parse(body));
  }

  @Patch('folders/:id')
  @HttpCode(204)
  async updateFolder(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    const folderId = FolderIdSchema.parse(id);
    const patch = SyncFolderPatchSchema.parse(body);
    logger.info({ folderId, ...patch }, 'PATCH /api/host/sync/folders/:id');
    await this.fileSync.updateFolder(folderId, patch).catch(folderNotFound);
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

  @Post('folders/:id/override')
  @HttpCode(204)
  @ApiOperation({ summary: 'Override remote changes from a send-only folder' })
  @ApiNoContentResponse()
  async override(@Param('id') id: string): Promise<void> {
    await this.fileSync.override(FolderIdSchema.parse(id));
  }

  @Get('folders/:id/local-changes')
  @ApiOperation({ summary: 'Read the count and bounded sample of receive-only changes' })
  @ApiOkResponse({ description: 'The change count and at most 200 names' })
  localChanges(@Param('id') id: string): Promise<ReceiveOnlyChanges> {
    return this.fileSync.localChanges(FolderIdSchema.parse(id)).catch(folderNotFound);
  }

  @Get('folders/:id/configuration')
  @ApiOperation({ summary: 'Read folder direction, pause state and peer devices' })
  @ApiOkResponse({ description: 'The current VM folder configuration' })
  configuration(@Param('id') id: string): Promise<SyncFolderConfiguration> {
    return this.fileSync.folderConfiguration(FolderIdSchema.parse(id)).catch(folderNotFound);
  }

  @Get('status')
  async status(@Query() query: unknown): Promise<FolderSyncStatus> {
    const { folder, device, errors } = SyncStatusQuerySchema.parse(query);
    return this.fileSync
      .status(folder, device, { allErrors: errors === 'all' })
      .catch(folderNotFound);
  }

  @Get('folders/:id/remote-need')
  remoteNeed(@Param('id') id: string, @Query() query: unknown): Promise<RemoteNeed> {
    const { device } = RemoteNeedQuerySchema.parse(query);
    return this.fileSync.remoteNeed(FolderIdSchema.parse(id), device);
  }
}

/** Syncthing's 404 for an unknown folder becomes the route's own 404. */
function folderNotFound(error: unknown): never {
  if (error instanceof SyncthingRestError && error.status === 404)
    throw new NotFoundException('Sync folder not found');
  throw error;
}
