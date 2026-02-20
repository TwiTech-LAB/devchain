import { Module, forwardRef } from '@nestjs/common';
import { HooksController } from './controllers/hooks.controller';
import { HooksService } from './services/hooks.service';
import { HooksConfigService } from './services/hooks-config.service';
import { StorageModule } from '../storage/storage.module';
import { EventsDomainModule } from '../events/events-domain.module';

@Module({
  imports: [StorageModule, forwardRef(() => EventsDomainModule)],
  controllers: [HooksController],
  providers: [HooksService, HooksConfigService],
  exports: [HooksService, HooksConfigService],
})
export class HooksModule {}
