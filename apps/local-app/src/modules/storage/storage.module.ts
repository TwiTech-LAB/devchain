import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { LocalStorageService } from './local/local-storage.service';
import { STORAGE_SERVICE } from './interfaces/storage.interface';

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useClass: LocalStorageService,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
