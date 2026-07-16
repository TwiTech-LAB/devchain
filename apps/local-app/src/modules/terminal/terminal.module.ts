import { Module, forwardRef } from '@nestjs/common';
import { TerminalStreamService } from './services/terminal-stream.service';
import { PtyService } from './services/pty.service';
import { TerminalGateway } from './gateways/terminal.gateway';
import { EventsCoreModule } from '../events/events-core.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalSeedService } from './services/terminal-seed.service';
import { TerminalSessionRegistry } from './services/terminal-session/terminal-session-registry';
import { SettingsService } from '../settings/services/settings.service';
import { TerminalRegistryRehydrator } from './services/terminal-registry-rehydrator.service';
import { TerminalActivityService } from './services/terminal-activity.service';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { TerminalDeliveryModule } from './terminal-delivery.module';
import { MetricsModule } from '../metrics/metrics.module';
import { TerminalSocketDrainAdapter } from './services/terminal-socket-drain.adapter';
import { TerminalSendSchedulerService } from './services/terminal-send-scheduler.service';

@Module({
  imports: [
    TerminalDeliveryModule,
    EventsCoreModule,
    SettingsModule,
    forwardRef(() => SessionsModule),
    RealtimeBroadcastModule,
    MetricsModule,
  ],
  providers: [
    TerminalStreamService,
    PtyService,
    TerminalGateway,
    TerminalSeedService,
    TerminalSocketDrainAdapter,
    TerminalSendSchedulerService,
    {
      provide: TerminalSessionRegistry,
      useFactory: (settingsService: SettingsService) =>
        new TerminalSessionRegistry(() => {
          const raw = settingsService.getSetting('activity.idleTimeoutMs');
          const parsed = Number(raw);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        }),
      inject: [SettingsService],
    },
    TerminalRegistryRehydrator,
    TerminalActivityService,
  ],
  exports: [
    TerminalStreamService,
    PtyService,
    TerminalGateway,
    TerminalSeedService,
    TerminalSendSchedulerService,
    TerminalDeliveryModule,
    TerminalSessionRegistry,
    TerminalActivityService,
  ],
})
export class TerminalModule {}
