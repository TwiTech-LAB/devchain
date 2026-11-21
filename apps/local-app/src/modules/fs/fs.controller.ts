import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import { existsSync, statSync } from 'fs';
import { ListFoldersSchema, listFolders, type FolderList } from './folder-list';

const logger = createLogger('FsController');

const StatPathSchema = z.object({
  path: z.string().min(1),
});

@Controller('api/fs')
export class FsController {
  @Post('stat')
  async statPath(@Body() body: unknown) {
    logger.info('POST /api/fs/stat');
    const { path } = StatPathSchema.parse(body);

    try {
      if (existsSync(path)) {
        const stats = statSync(path);
        return {
          exists: true,
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
        };
      }
      return { exists: false };
    } catch (error) {
      logger.error({ error, path }, 'Error checking path');
      return { exists: false, error: 'Permission denied or invalid path' };
    }
  }

  /** This PC only; the UI calls it as a home request, never through the `/r` proxy. */
  @Post('list')
  @HttpCode(200)
  list(@Body() body: unknown): Promise<FolderList> {
    logger.info('POST /api/fs/list');
    return listFolders(ListFoldersSchema.parse(body ?? {}));
  }
}
