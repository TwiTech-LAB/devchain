import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentTimeAccountingService } from './services/agent-time-accounting.service';
import { EpicTimeStore } from './services/epic-time.store';
import { EpicTimeService } from './services/epic-time.service';
import { AgentTimeBufferController } from './controllers/agent-time-buffer.controller';
import { EpicTimeController } from './controllers/epic-time.controller';
import { ExternalEstimateLogController } from './controllers/external-estimate-log.controller';
import { StorageModule } from '../storage/storage.module';
import { ExternalIntegrationsModule } from '../external-integrations/external-integrations.module';
import { EpicEstimateLoggingService } from './services/epic-estimate-logging.service';

@Module({
  imports: [DbModule, EventsCoreModule, StorageModule, ExternalIntegrationsModule],
  controllers: [EpicTimeController, AgentTimeBufferController, ExternalEstimateLogController],
  providers: [
    EpicTimeStore,
    AgentTimeAccountingService,
    EpicTimeService,
    EpicEstimateLoggingService,
  ],
  exports: [EpicTimeStore, AgentTimeAccountingService, EpicTimeService, EpicEstimateLoggingService],
})
export class EpicTimeModule {}
