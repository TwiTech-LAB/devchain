import { Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import { existsSync, statSync } from 'fs';

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
}
