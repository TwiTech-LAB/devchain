import { Injectable } from '@nestjs/common';
import type { ProviderUsageSettings } from '@devchain/shared';
import { SettingsService } from '../../settings/services/settings.service';
import type { HostProviderUsageSettingsStatus } from '../contract/host-routes';
import { providerUsageSettingsRevision } from './host-provider-usage-revision';

/**
 * The VM's usage refresh settings, set by home. The status reports the values the VM
 * runs with, so a change made on the VM itself also brings home's push back.
 */
@Injectable()
export class HostProviderUsageSettingsService {
  constructor(private readonly settings: SettingsService) {}

  status(): HostProviderUsageSettingsStatus {
    return {
      appliedRevision: providerUsageSettingsRevision(this.settings.getProviderUsageConfig()),
    };
  }

  async accept(settings: ProviderUsageSettings): Promise<void> {
    await this.settings.updateSettings({ providerUsage: settings });
  }
}
