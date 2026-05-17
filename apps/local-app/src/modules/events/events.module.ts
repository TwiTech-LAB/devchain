import { Module } from '@nestjs/common';
import { EventsCoreModule } from './events-core.module';

@Module({
  imports: [EventsCoreModule],
  exports: [EventsCoreModule],
})
export class EventsModule {}
