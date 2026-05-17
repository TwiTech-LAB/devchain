import { Module, forwardRef } from '@nestjs/common';
import { SchedulesController } from './controllers/schedules.controller';
import { StorageModule } from '../storage/storage.module';
import { EpicsModule } from '../epics/epics.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { SchedulesService } from './services/schedules.service';
import { SchedulerRunnerService } from './services/scheduler-runner.service';

@Module({
  imports: [StorageModule, forwardRef(() => EpicsModule), EventsDomainModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerRunnerService],
  exports: [SchedulesService, SchedulerRunnerService],
})
export class SchedulesModule {}
