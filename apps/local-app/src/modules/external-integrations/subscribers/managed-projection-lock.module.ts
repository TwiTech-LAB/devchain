import { Module } from '@nestjs/common';
import { ManagedProjectionLock } from './managed-projection-lock';

/**
 * The one `ManagedProjectionLock` of the app: managed sync, epic link changes and
 * replica applies must all serialize on the same instance.
 */
@Module({
  providers: [ManagedProjectionLock],
  exports: [ManagedProjectionLock],
})
export class ManagedProjectionLockModule {}
