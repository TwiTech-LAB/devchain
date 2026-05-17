import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CoreCommonModule } from './modules/core/core-common.module';
import { CoreMainHealthModule } from './modules/core/core-main-health.module';
import { CoreNormalModule } from './modules/core/core-normal.module';
import { StorageModule } from './modules/storage/storage.module';
import { TerminalModule } from './modules/terminal/terminal.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SessionsReadModule } from './modules/sessions/sessions-read.module';
import { SessionsDeliveryModule } from './modules/sessions/sessions-delivery.module';
import { McpFullModule } from './modules/mcp/mcp-full.module';
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
import { ScheduledEpicsModule } from './modules/scheduled-epics/scheduled-epics.module';
import { RecordsModule } from './modules/records/records.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FsModule } from './modules/fs/fs.module';
import { ChatModule } from './modules/chat/chat.module';
import { WatchersModule } from './modules/watchers/watchers.module';
import { SubscribersModule } from './modules/subscribers/subscribers.module';
import { RegistryModule } from './modules/registry/registry.module';
import { GuestsModule } from './modules/guests/guests.module';
import { HooksModule } from './modules/hooks/hooks.module';
import { SessionReaderModule } from './modules/session-reader/session-reader.module';
import { TeamsModule } from './modules/teams/teams.module';
import { DataSeederModule } from './modules/seeders/seeders.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { EventsCoreModule } from './modules/events/events-core.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { AllWsExceptionsFilter } from './common/filters/ws-exception.filter';
import { OrchestratorStorageModule } from './modules/orchestrator/orchestrator-storage/orchestrator-storage.module';
import { OrchestratorDockerModule } from './modules/orchestrator/docker/docker.module';
import { OrchestratorGitModule } from './modules/orchestrator/git/git.module';
import { OrchestratorWorktreesModule } from './modules/orchestrator/worktrees/worktrees.module';
import { OrchestratorSyncModule } from './modules/orchestrator/sync/sync.module';
import { OrchestratorProxyModule } from './modules/orchestrator/proxy/orchestrator-proxy.module';
import { CodebaseOverviewAnalyzerModule } from './modules/codebase-overview-analyzer/codebase-overview-analyzer.module';
import { CloudModule } from './modules/cloud/cloud.module';
import { CloudTunnelModule } from './modules/cloud-tunnel/cloud-tunnel.module';

@Module({
  imports: [
    EventsCoreModule,
    CoreMainHealthModule,
    CoreCommonModule,
    CoreNormalModule,
    StorageModule,
    TerminalModule,
    SessionsModule,
    SessionsReadModule,
    SessionsDeliveryModule,
    McpFullModule,
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
    ScheduledEpicsModule,
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
    SessionReaderModule,
    TeamsModule,
    OrchestratorStorageModule,
    OrchestratorDockerModule,
    OrchestratorGitModule,
    OrchestratorWorktreesModule,
    OrchestratorSyncModule,
    OrchestratorProxyModule,
    CodebaseOverviewAnalyzerModule,
    CloudModule,
    CloudTunnelModule,
  ],
  controllers: [],
  providers: [
    // Order matters: WS filter first (re-throws for non-WS), HTTP filter second.
    { provide: APP_FILTER, useClass: AllWsExceptionsFilter },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class MainAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
