import { ProviderCliStateModule } from '../providers/services/provider-cli-state.module';
import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { RuntimeController } from './controllers/runtime.controller';
import { HostStatsController } from './controllers/host-stats.controller';
import { HealthService } from './services/health.service';
import { FileSyncModule } from '../file-sync/file-sync.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [FileSyncModule, StorageModule, ProviderCliStateModule],
  controllers: [HealthController, RuntimeController, HostStatsController],
  providers: [HealthService],
  exports: [HealthService],
})
export class CoreCommonModule {}
