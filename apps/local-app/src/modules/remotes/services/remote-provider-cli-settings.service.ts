import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  type HostProviderCliSettings,
} from '@devchain/shared';
import { SettingsService } from '../../settings/services/settings.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { providerCliPolicyRevision } from '../host/host-provider-cli-policy';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('RemoteProviderCliSettingsService');

@Injectable()
export class RemoteProviderCliSettingsService implements OnModuleDestroy {
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
          'Provider CLI policy push failed; next poll will retry',
        ),
      )
      .finally(() => this.pushing.delete(remoteId));
    this.pushing.set(remoteId, work);
    return work;
  }

  private async push(remoteId: string): Promise<void> {
    const settings = this.settings.getProviderCliVersions();
    const providers = Object.fromEntries(
      PROVIDER_CLI_NAMES.map((provider) => [
        provider,
        { package: PROVIDER_CLI_NPM_PACKAGES[provider], version: settings[provider].version },
      ]),
    ) as HostProviderCliSettings['providers'];
    const body = { revision: providerCliPolicyRevision(providers), providers };
    const status = await this.host.getProviderCliSettingsStatus(remoteId);
    if (
      !this.stopped &&
      status.pendingRevision !== body.revision &&
      status.appliedRevision !== body.revision
    )
      await this.host.putProviderCliSettings(remoteId, body);
  }

  async checkNow(remoteId: string): Promise<void> {
    try {
      await this.pushIfChanged(remoteId);
      if (!this.stopped) await this.host.checkProviderClis(remoteId);
    } catch (error) {
      logger.debug({ remoteId, error: String(error) }, 'Remote provider CLI check request failed');
    }
  }
}
