import { Module } from '@nestjs/common';
import { HooksController } from './controllers/hooks.controller';
import { HooksService } from './services/hooks.service';
import { HooksConfigService } from './services/hooks-config.service';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';

@Module({
  imports: [StorageModule, EventsCoreModule],
  controllers: [HooksController],
  providers: [HooksService, HooksConfigService],
  exports: [HooksService, HooksConfigService],
})
export class HooksModule {}
