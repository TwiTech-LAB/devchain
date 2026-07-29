import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { LocalStorageService } from './local/local-storage.service';
import { STORAGE_SERVICE } from './interfaces/storage.interface';
import { SNAPSHOT_PROMPT_WRITER } from './interfaces/snapshot-prompt-writer.interface';

@Module({
  imports: [DbModule],
  providers: [
    LocalStorageService,
    {
      provide: STORAGE_SERVICE,
      useExisting: LocalStorageService,
    },
    {
      provide: SNAPSHOT_PROMPT_WRITER,
      useExisting: LocalStorageService,
    },
  ],
  exports: [STORAGE_SERVICE, SNAPSHOT_PROMPT_WRITER],
})
export class StorageModule {}
