import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { EpicTimeStore } from './services/epic-time.store';

/**
 * Shared EpicTimeStore provider. It imports only DbModule so the Epic-time
 * feature module and the session lifecycle module can inject the store
 * without importing each other.
 */
@Module({
  imports: [DbModule],
  providers: [EpicTimeStore],
  exports: [EpicTimeStore],
})
export class EpicTimeStoreModule {}
