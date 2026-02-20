import { Module } from '@nestjs/common';
import { EventsInfraModule } from './events-infra.module';
import { EventsDomainModule } from './events-domain.module';

@Module({
  imports: [EventsInfraModule, EventsDomainModule],
  exports: [EventsInfraModule, EventsDomainModule],
})
export class EventsModule {}
