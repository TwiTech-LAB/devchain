import { Module } from '@nestjs/common';
import { RuntimeDirectoryModule } from '../../runtime-directory/runtime-directory.module';
import { StorageModule } from '../../storage/storage.module';
import { IntegrationVmCacheService } from './integration-vm-cache.service';

/** Free of vendor adapters, so the host route and the runtime report can use the cache alone. */
@Module({
  imports: [StorageModule, RuntimeDirectoryModule],
  providers: [IntegrationVmCacheService],
  exports: [IntegrationVmCacheService],
})
export class IntegrationVmCacheModule {}
