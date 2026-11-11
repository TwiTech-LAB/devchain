import { Module } from '@nestjs/common';
import { RuntimeDirectoryModule } from '../runtime-directory/runtime-directory.module';
import { StorageModule } from '../storage/storage.module';
import { VaultVmCacheService } from './vault-vm-cache.service';

/** Free of `VaultKeyService`, so the runtime report can read the cache state without the key manager. */
@Module({
  imports: [StorageModule, RuntimeDirectoryModule],
  providers: [VaultVmCacheService],
  exports: [VaultVmCacheService],
})
export class VaultVmCacheModule {}
