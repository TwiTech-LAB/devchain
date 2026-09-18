import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentTimeAccountingService } from './services/agent-time-accounting.service';
import { EpicTimeService } from './services/epic-time.service';
import { AgentTimeBufferController } from './controllers/agent-time-buffer.controller';
import { EpicTimeController } from './controllers/epic-time.controller';
import { ExternalEstimateLogController } from './controllers/external-estimate-log.controller';
import { StorageModule } from '../storage/storage.module';
import { ExternalIntegrationsModule } from '../external-integrations/external-integrations.module';
import { EpicEstimateLoggingService } from './services/epic-estimate-logging.service';
import { EpicTimeStoreModule } from './epic-time-store.module';

@Module({
  imports: [EpicTimeStoreModule, EventsCoreModule, StorageModule, ExternalIntegrationsModule],
  controllers: [EpicTimeController, AgentTimeBufferController, ExternalEstimateLogController],
  providers: [AgentTimeAccountingService, EpicTimeService, EpicEstimateLoggingService],
  exports: [AgentTimeAccountingService, EpicTimeService, EpicEstimateLoggingService],
})
export class EpicTimeModule {}
