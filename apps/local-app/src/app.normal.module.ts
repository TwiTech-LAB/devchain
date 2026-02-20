import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CoreCommonModule } from './modules/core/core-common.module';
import { CoreNormalHealthModule } from './modules/core/core-normal-health.module';
import { CoreNormalModule } from './modules/core/core-normal.module';
import { StorageModule } from './modules/storage/storage.module';
import { TerminalModule } from './modules/terminal/terminal.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { McpModule } from './modules/mcp/mcp.module';
import { UiModule } from './modules/ui/ui.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SkillsModule } from './modules/skills/skills.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { PromptsModule } from './modules/prompts/prompts.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { AgentsModule } from './modules/agents/agents.module';
import { StatusesModule } from './modules/statuses/statuses.module';
import { EpicsModule } from './modules/epics/epics.module';
import { RecordsModule } from './modules/records/records.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FsModule } from './modules/fs/fs.module';
import { ChatModule } from './modules/chat/chat.module';
import { WatchersModule } from './modules/watchers/watchers.module';
import { SubscribersModule } from './modules/subscribers/subscribers.module';
import { RegistryModule } from './modules/registry/registry.module';
import { GuestsModule } from './modules/guests/guests.module';
import { HooksModule } from './modules/hooks/hooks.module';
import { DataSeederModule } from './modules/seeders/seeders.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { EventsInfraModule } from './modules/events/events-infra.module';
import { EventsDomainModule } from './modules/events/events-domain.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { AllWsExceptionsFilter } from './common/filters/ws-exception.filter';

@Module({
  imports: [
    EventsInfraModule,
    EventsDomainModule,
    CoreNormalHealthModule,
    CoreCommonModule,
    CoreNormalModule,
    StorageModule,
    TerminalModule,
    SessionsModule,
    McpModule,
    UiModule,
    SettingsModule,
    SkillsModule,
    ProjectsModule,
    PromptsModule,
    ProfilesModule,
    ProvidersModule,
    AgentsModule,
    StatusesModule,
    EpicsModule,
    RecordsModule,
    DocumentsModule,
    FsModule,
    ChatModule,
    WatchersModule,
    DataSeederModule,
    SubscribersModule,
    RegistryModule,
    GuestsModule,
    HooksModule,
  ],
  controllers: [],
  providers: [
    // Order matters: WS filter first (re-throws for non-WS), HTTP filter second.
    { provide: APP_FILTER, useClass: AllWsExceptionsFilter },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class NormalAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
