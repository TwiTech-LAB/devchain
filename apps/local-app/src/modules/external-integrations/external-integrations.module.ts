import { Module } from '@nestjs/common';
import { ClickUpExternalTaskProvider } from './adapters/clickup-external-task.provider';
import { JiraExternalTaskProvider } from './adapters/jira-external-task.provider';
import { ExternalTaskProviderRegistry } from './external-task-provider.registry';
import { EXTERNAL_TASK_PROVIDERS, type ExternalTaskProvider } from './ports/external-task-provider';
import { SafeVendorHttpClient } from './transport/safe-vendor-http-client';
import { StorageModule } from '../storage/storage.module';
import { IntegrationConnectionsController } from './connections/integration-connections.controller';
import { IntegrationConnectionsService } from './connections/integration-connections.service';
import { ExternalMyWorkController } from './my-work/external-my-work.controller';
import { ExternalMyWorkService } from './my-work/external-my-work.service';
import { ExternalEditSessionService } from './my-work/external-edit-session.service';
import { ExternalTimeMutationService } from './my-work/external-time-mutation.service';
import { ExternalEditSessionStore } from './sessions/external-edit-session.store';
import { ExternalTimeMutationStore } from './sessions/external-time-mutation.store';
import { ProviderOperationGate } from './sessions/provider-operation-gate';
import {
  EXTERNAL_RICH_CAPABILITIES,
  EXTERNAL_RICH_CAPABILITIES_TOKEN,
} from './models/external-rich-capabilities';

@Module({
  imports: [StorageModule],
  controllers: [IntegrationConnectionsController, ExternalMyWorkController],
  providers: [
    {
      provide: SafeVendorHttpClient,
      useFactory: () => new SafeVendorHttpClient(),
    },
    ClickUpExternalTaskProvider,
    JiraExternalTaskProvider,
    {
      provide: EXTERNAL_TASK_PROVIDERS,
      inject: [ClickUpExternalTaskProvider, JiraExternalTaskProvider],
      useFactory: (
        clickup: ClickUpExternalTaskProvider,
        jira: JiraExternalTaskProvider,
      ): ExternalTaskProvider[] => [clickup, jira],
    },
    ExternalTaskProviderRegistry,
    {
      provide: EXTERNAL_RICH_CAPABILITIES_TOKEN,
      useValue: EXTERNAL_RICH_CAPABILITIES,
    },
    // One shared gate instance: provider writes and connection replacement
    // must serialize against each other for the same provider.
    ProviderOperationGate,
    ExternalEditSessionStore,
    ExternalTimeMutationStore,
    IntegrationConnectionsService,
    ExternalMyWorkService,
    ExternalEditSessionService,
    ExternalTimeMutationService,
  ],
  exports: [ExternalTaskProviderRegistry, EXTERNAL_TASK_PROVIDERS, ProviderOperationGate],
})
export class ExternalIntegrationsModule {}
