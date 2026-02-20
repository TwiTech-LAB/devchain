import { Module, forwardRef } from '@nestjs/common';
import { WatchersController } from './controllers/watchers.controller';
import { StorageModule } from '../storage/storage.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { WatchersService } from './services/watchers.service';
import { WatcherRunnerService } from './services/watcher-runner.service';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => SessionsModule),
    forwardRef(() => TerminalModule),
    forwardRef(() => EventsDomainModule),
  ],
  controllers: [WatchersController],
  providers: [WatchersService, WatcherRunnerService],
  exports: [WatchersService, WatcherRunnerService],
})
export class WatchersModule {}
