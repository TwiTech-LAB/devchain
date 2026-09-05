import { Module } from '@nestjs/common';
import { EpicsController } from './controllers/epics.controller';
import { EpicCommentsController } from './controllers/epic-comments.controller';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { EpicsService } from './services/epics.service';
import { EpicRelationsService } from './services/epic-relations.service';
import { SettingsModule } from '../settings/settings.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { TeamsModule } from '../teams/teams.module';
import { EpicAssignmentNotifierSubscriber } from './subscribers/epic-assignment-notifier.subscriber';
import { SubEpicCreatedNotifierSubscriber } from './subscribers/sub-epic-created-notifier.subscriber';

@Module({
  imports: [
    StorageModule,
    EventsCoreModule,
    SettingsModule,
    AgentMessageDeliveryModule,
    TeamsModule,
  ],
  controllers: [EpicsController, EpicCommentsController],
  providers: [
    EpicsService,
    EpicRelationsService,
    EpicAssignmentNotifierSubscriber,
    SubEpicCreatedNotifierSubscriber,
  ],
  exports: [EpicsService, EpicRelationsService],
})
export class EpicsModule {}
