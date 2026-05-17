import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { AgentsModule } from '../agents/agents.module';
import { ChatModule } from '../chat/chat.module';
import { CloudModule } from '../cloud/cloud.module';
import { EpicsModule } from '../epics/epics.module';
import { GuestsModule } from '../guests/guests.module';
import { HooksModule } from '../hooks/hooks.module';
import { ProjectsModule } from '../projects/projects.module';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { RegistryModule } from '../registry/registry.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { TerminalModule } from '../terminal/terminal.module';
import { TeamsModule } from '../teams/teams.module';
import { WatchersModule } from '../watchers/watchers.module';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { DbModule } from '../storage/db/db.module';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from './events-core.module';
import { EventsInfraModule } from './events-infra.module';
import { CatalogBroadcasterService } from './services/catalog-broadcaster.service';
import { EventLogService } from './services/event-log.service';
import { EventsService } from './services/events.service';
import { EventsStreamService } from './services/events-stream.service';

describe('EventsCoreModule', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('compiles standalone and resolves event-core services', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventsCoreModule],
    })
      .overrideProvider(DB_CONNECTION)
      .useValue({})
      .overrideProvider(STORAGE_SERVICE)
      .useValue({})
      .compile();

    expect(moduleRef.get(EventsService)).toBeInstanceOf(EventsService);
    expect(moduleRef.get(EventLogService)).toBeInstanceOf(EventLogService);
    expect(moduleRef.get(EventsStreamService)).toBeInstanceOf(EventsStreamService);
    expect(moduleRef.get(CatalogBroadcasterService)).toBeInstanceOf(CatalogBroadcasterService);
  });

  it('imports only event-core infrastructure modules', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, EventsCoreModule) as unknown[]) ?? [];
    const allowedImports = [EventsInfraModule, DbModule, StorageModule, RealtimeBroadcastModule];
    const forbiddenDomainImports = [
      AgentMessageDeliveryModule,
      AgentsModule,
      ChatModule,
      CloudModule,
      EpicsModule,
      GuestsModule,
      HooksModule,
      ProjectsModule,
      RegistryModule,
      ReviewsModule,
      SessionsModule,
      SubscribersModule,
      TerminalModule,
      TeamsModule,
      WatchersModule,
    ];

    expect(imports).toEqual(allowedImports);
    expect(imports).toEqual(expect.not.arrayContaining(forbiddenDomainImports));
  });
});
