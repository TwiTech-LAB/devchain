import { Module, forwardRef } from '@nestjs/common';
import { GuestsService } from './services/guests.service';
import { GuestHealthService } from './services/guest-health.service';
import { StorageModule } from '../storage/storage.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EventsDomainModule } from '../events/events-domain.module';

@Module({
  imports: [StorageModule, forwardRef(() => TerminalModule), forwardRef(() => EventsDomainModule)],
  providers: [GuestsService, GuestHealthService],
  exports: [GuestsService, GuestHealthService],
})
export class GuestsModule {}
