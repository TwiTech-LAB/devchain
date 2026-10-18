import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsLifecycleModule } from '../sessions/sessions-lifecycle.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsDeliveryModule } from '../sessions/sessions-delivery.module';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { TeamsController } from './controllers/teams.controller';
import { TeamsService } from './services/teams.service';
import { TeamsStore } from './storage/teams.store';
import { TeamConfigUpdatedNotifierSubscriber } from './subscribers/team-config-updated-notifier.subscriber';
import { TeamMembershipChangedNotifierSubscriber } from './subscribers/team-membership-changed-notifier.subscriber';

@Module({
  imports: [
    StorageModule,
    EventsCoreModule,
    AgentMessageDeliveryModule,
    SettingsModule,
    SessionsLifecycleModule,
    SessionsReadModule,
    SessionsDeliveryModule,
    ProviderAdaptersModule,
  ],
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
