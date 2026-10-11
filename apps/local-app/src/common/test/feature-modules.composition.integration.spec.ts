import { Test, type TestingModule } from '@nestjs/testing';
import { CloudModule } from '../../modules/cloud/cloud.module';
import { CloudSessionManagerService } from '../../modules/cloud/services/cloud-session-manager.service';
import { PreflightService } from '../../modules/core/services/preflight.service';
import { EventsService } from '../../modules/events/services/events.service';
import { GuestsModule } from '../../modules/guests/guests.module';
import { GuestHealthService } from '../../modules/guests/services/guest-health.service';
import { GuestsService } from '../../modules/guests/services/guests.service';
import { ProviderAdapterFactory } from '../../modules/providers/adapters/provider-adapter.factory';
import { SessionsService } from '../../modules/sessions/services/sessions.service';
import { DB_CONNECTION } from '../../modules/storage/db/db.provider';
import { TerminalGateway } from '../../modules/terminal/gateways/terminal.gateway';
import { FakeProcessExecutor } from '../../modules/terminal/services/process-executor/fake-process-executor';
import { ProcessExecutor } from '../../modules/terminal/services/process-executor/process-executor.port';
import { PtyService } from '../../modules/terminal/services/pty.service';
import { TerminalActivityService } from '../../modules/terminal/services/terminal-activity.service';
import { TerminalIOService } from '../../modules/terminal/services/terminal-io/terminal-io.service';
import { TerminalSeedService } from '../../modules/terminal/services/terminal-seed.service';
import { TerminalSessionRegistry } from '../../modules/terminal/services/terminal-session/terminal-session-registry';
import { WatcherRunnerService } from '../../modules/watchers/services/watcher-runner.service';
import { WatchersService } from '../../modules/watchers/services/watchers.service';
import { WatchersModule } from '../../modules/watchers/watchers.module';
import { createTestDatabase } from './test-database.helper';

// Nest composition is the cheapest layer that resolves the real construction graph.
describe('Feature module provider composition', () => {
  it('constructs guests, watchers, sessions, terminal and cloud with real providers', async () => {
    const { sqlite, db } = createTestDatabase();
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({
        imports: [GuestsModule, WatchersModule, CloudModule],
      })
        .overrideProvider(DB_CONNECTION)
        .useValue(db)
        .overrideProvider(ProcessExecutor)
        .useValue(new FakeProcessExecutor())
        .compile();

      for (const provider of [
        GuestsService,
        GuestHealthService,
        SessionsService,
        WatchersService,
        WatcherRunnerService,
        TerminalGateway,
        TerminalActivityService,
        TerminalSeedService,
        CloudSessionManagerService,
        TerminalIOService,
        PtyService,
        TerminalSessionRegistry,
        PreflightService,
        EventsService,
        ProviderAdapterFactory,
      ]) {
        expect(module.get(provider)).toBeInstanceOf(provider);
      }
    } finally {
      try {
        await module?.close();
      } finally {
        sqlite.close();
      }
    }
  });
});
