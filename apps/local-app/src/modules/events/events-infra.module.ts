import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DbModule } from '../storage/db/db.module';
import { CommittedEventStore } from './services/committed-event.store';
import { DurableEventRegistryService } from './services/durable-event-registry.service';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
    }),
    DbModule,
  ],
  providers: [CommittedEventStore, DurableEventRegistryService],
  exports: [EventEmitterModule, CommittedEventStore, DurableEventRegistryService],
})
export class EventsInfraModule {}
