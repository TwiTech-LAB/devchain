import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { ProviderAdaptersModule } from '../adapters';
import { ProviderEffortSeedingService } from './provider-effort-seeding.service';

/**
 * Small module exposing the shared effort-seeding service. Kept standalone (not
 * folded into the heavier ProvidersModule) so the startup DataSeeder can import
 * it without pulling the full providers dependency graph — the service only
 * needs the adapter factory (defaults metadata) and storage (bulk delegate).
 */
@Module({
  imports: [ProviderAdaptersModule, StorageModule],
  providers: [ProviderEffortSeedingService],
  exports: [ProviderEffortSeedingService],
})
export class ProviderEffortSeedingModule {}
