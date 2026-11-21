import { Module } from '@nestjs/common';
import { DB_FILE_PATH } from '../storage/db/db-file-path.provider';
import { DbModule } from '../storage/db/db.module';
import {
  RUNTIME_DIRECTORY_HOST,
  runtimeDirectoryDbPath,
  systemRuntimeDirectoryHost,
} from './runtime-directory';
import { RuntimeDirectoryService } from './runtime-directory.service';
import { SessionImageStore } from './session-image-store.service';

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: RUNTIME_DIRECTORY_HOST,
      inject: [DB_FILE_PATH],
      useFactory: (dbFilePath: string) =>
        systemRuntimeDirectoryHost(runtimeDirectoryDbPath(dbFilePath)),
    },
    RuntimeDirectoryService,
    SessionImageStore,
  ],
  exports: [RuntimeDirectoryService, SessionImageStore],
})
export class RuntimeDirectoryModule {}
