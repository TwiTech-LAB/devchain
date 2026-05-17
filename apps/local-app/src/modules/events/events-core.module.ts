import { Module } from '@nestjs/common';
import { EventsInfraModule } from './events-infra.module';
import { EventLogController } from './controllers/event-log.controller';
import { CatalogBroadcasterService } from './services/catalog-broadcaster.service';
import { EventLogService } from './services/event-log.service';
import { EventsService } from './services/events.service';
import { EventsStreamService } from './services/events-stream.service';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { DbModule } from '../storage/db/db.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [EventsInfraModule, DbModule, StorageModule, RealtimeBroadcastModule],
  controllers: [EventLogController],
  providers: [EventsService, EventLogService, EventsStreamService, CatalogBroadcasterService],
  exports: [EventsService, EventLogService, EventsStreamService, CatalogBroadcasterService],
})
export class EventsCoreModule {}
