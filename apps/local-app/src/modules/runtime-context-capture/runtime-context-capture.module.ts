import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { EventsInfraModule } from '../events/events-infra.module';
import { RuntimeContextCaptureService } from './runtime-context-capture.service';
import { ClaudeLaunchSettingsMaterializerService } from './claude-launch-settings-materializer.service';

@Module({
  imports: [DbModule, EventsInfraModule],
  providers: [RuntimeContextCaptureService, ClaudeLaunchSettingsMaterializerService],
  exports: [RuntimeContextCaptureService, ClaudeLaunchSettingsMaterializerService],
})
export class RuntimeContextCaptureModule {}
