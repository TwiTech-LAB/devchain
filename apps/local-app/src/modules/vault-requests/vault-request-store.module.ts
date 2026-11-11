import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { VaultRequestStore } from './vault-request.store';

/**
 * The pending-request store on its own, so `VaultModule` (the use gate) and
 * `VaultRequestsModule` (the answers) can both hold it without importing each other.
 */
@Module({
  imports: [EventsCoreModule],
  providers: [VaultRequestStore],
  exports: [VaultRequestStore],
})
export class VaultRequestStoreModule {}
