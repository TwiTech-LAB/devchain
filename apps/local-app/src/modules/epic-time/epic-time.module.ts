import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentTimeAccountingService } from './services/agent-time-accounting.service';
import { EpicTimeStore } from './services/epic-time.store';
import { EpicTimeService } from './services/epic-time.service';
import { EpicTimeController } from './controllers/epic-time.controller';

@Module({
  imports: [DbModule, EventsCoreModule],
  controllers: [EpicTimeController],
  providers: [EpicTimeStore, AgentTimeAccountingService, EpicTimeService],
  exports: [EpicTimeStore, AgentTimeAccountingService, EpicTimeService],
})
export class EpicTimeModule {}
