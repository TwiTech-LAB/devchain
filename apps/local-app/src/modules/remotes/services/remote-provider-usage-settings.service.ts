import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { SettingsService } from '../../settings/services/settings.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { providerUsageSettingsRevision } from '../host/host-provider-usage-revision';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('RemoteProviderUsageSettingsService');

/** Home owns the usage refresh settings; each health poll brings a VM up to home's values. */
@Injectable()
export class RemoteProviderUsageSettingsService implements OnModuleDestroy {
  private readonly pushing = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly settings: SettingsService,
    private readonly host: RemoteHostClient,
  ) {}
  onModuleDestroy(): void {
    this.stopped = true;
  }

  pushIfChanged(remoteId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.pushing.get(remoteId);
    if (pending) return pending;
    const work = this.push(remoteId)
      .catch((error) =>
        logger.debug(
          { remoteId, error: String(error) },
          'Provider usage settings push failed; next poll will retry',
        ),
      )
      .finally(() => this.pushing.delete(remoteId));
    this.pushing.set(remoteId, work);
    return work;
  }

  private async push(remoteId: string): Promise<void> {
    const settings = this.settings.getProviderUsageConfig();
    const body = { revision: providerUsageSettingsRevision(settings), settings };
    const status = await this.host.getProviderUsageSettingsStatus(remoteId);
    if (!this.stopped && status.appliedRevision !== body.revision)
      await this.host.putProviderUsageSettings(remoteId, body);
  }
}
