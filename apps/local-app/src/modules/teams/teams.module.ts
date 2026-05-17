import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { TeamsController } from './controllers/teams.controller';
import { TeamsService } from './services/teams.service';
import { TeamsStore } from './storage/teams.store';
import { TeamConfigUpdatedNotifierSubscriber } from './subscribers/team-config-updated-notifier.subscriber';
import { TeamMembershipChangedNotifierSubscriber } from './subscribers/team-membership-changed-notifier.subscriber';

@Module({
  imports: [StorageModule, EventsCoreModule, AgentMessageDeliveryModule],
  controllers: [TeamsController],
  providers: [
    TeamsService,
    TeamsStore,
    TeamConfigUpdatedNotifierSubscriber,
    TeamMembershipChangedNotifierSubscriber,
  ],
  exports: [TeamsService],
})
export class TeamsModule {}
