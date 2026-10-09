import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EpicsModule } from '../epics/epics.module';
import { EventsCoreModule } from '../events/events-core.module';
import {
  ScheduledEpicsService,
  SCHEDULED_EPIC_RUNNER_REFRESH,
} from './services/scheduled-epics.service';
import { ScheduledEpicRunnerService } from './services/scheduled-epic-runner.service';
import { ScheduledEpicsController } from './controllers/scheduled-epics.controller';

@Module({
  imports: [StorageModule, EpicsModule, EventsCoreModule],
  controllers: [ScheduledEpicsController],
  providers: [
    ScheduledEpicsService,
    ScheduledEpicRunnerService,
    {
      provide: SCHEDULED_EPIC_RUNNER_REFRESH,
      useExisting: ScheduledEpicRunnerService,
    },
  ],
  exports: [ScheduledEpicsService, ScheduledEpicRunnerService, SCHEDULED_EPIC_RUNNER_REFRESH],
})
export class ScheduledEpicsModule {}
