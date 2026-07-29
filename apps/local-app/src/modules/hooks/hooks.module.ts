import { Module } from '@nestjs/common';
import { HooksController } from './controllers/hooks.controller';
import { HooksService } from './services/hooks.service';
import { HooksConfigService } from './services/hooks-config.service';
import { CopilotHooksConfigService } from './services/copilot-hooks-config.service';
import { PendingAskUserQuestionService } from './services/pending-ask-user-question.service';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { RuntimeContextCaptureModule } from '../runtime-context-capture/runtime-context-capture.module';

@Module({
  imports: [StorageModule, EventsCoreModule, RuntimeContextCaptureModule],
  controllers: [HooksController],
  providers: [
    HooksService,
    HooksConfigService,
    CopilotHooksConfigService,
    PendingAskUserQuestionService,
  ],
  exports: [
    HooksService,
    HooksConfigService,
    CopilotHooksConfigService,
    PendingAskUserQuestionService,
  ],
})
export class HooksModule {}
