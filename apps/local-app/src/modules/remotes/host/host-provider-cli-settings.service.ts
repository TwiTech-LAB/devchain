import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDER_CLI_NAMES,
  HostProviderCliSettingsSchema,
  type HostProviderCliSettings,
  type HostProviderCliSettingsStatus,
  type ProviderCliInstallStatus,
  type ProviderCliName,
} from '@devchain/shared';
import { SettingsService } from '../../settings/services/settings.service';
import { ProviderCliInstallStateService } from '../../providers/services/provider-cli-install-state.service';
import { ProviderCliInstallerService } from '../../providers/services/provider-cli-installer.service';
import { ProviderCliVersionsService } from '../../providers/services/provider-cli-versions.service';
import { HostHelperService } from './host-helper.service';
import { createLogger } from '../../../common/logging/logger';
import { providerCliPolicyRevision } from './host-provider-cli-policy';

const logger = createLogger('HostProviderCliSettingsService');

function providerState(input: {
  error: string | null;
  install: ProviderCliInstallStatus;
  acceptedVersion: string | null;
  target: string | null | undefined;
}): HostProviderCliSettingsStatus['providers'][ProviderCliName]['state'] {
  const { error, install, acceptedVersion, target } = input;
  if (error) return 'failed';
  if (install.state === 'installing') return 'pending';
  if (target && install.installedVersion === target) return 'applied';
  if (acceptedVersion === null || !target) return 'accepted';
  return 'pending';
}

@Injectable()
export class HostProviderCliSettingsService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;
  private accepted: HostProviderCliSettings | null = null;

  constructor(
    private readonly helper: HostHelperService,
    private readonly local: ProviderCliInstallStateService,
    private readonly settings: SettingsService,
    private readonly versions: ProviderCliVersionsService,
    private readonly installer: ProviderCliInstallerService,
  ) {}

  onModuleInit(): void {
    if (!this.helper.isClaimedHost()) return;
    try {
      const body = HostProviderCliSettingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (body.revision !== providerCliPolicyRevision(body.providers))
        throw new Error('Stored provider CLI policy revision mismatch');
      this.accepted = body;
      this.saveSettings(body);
      this.applyInBackground();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn({ error }, 'Could not recover host provider CLI policy');
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private get path(): string {
    return join(this.local.root, 'host-policy.json');
  }

  accept(body: HostProviderCliSettings): void {
    this.local.writeJsonAtomic(this.path, body);
    this.saveSettings(body);
    this.accepted = body;
    this.applyInBackground();
  }

  private saveSettings(body: HostProviderCliSettings): void {
    for (const provider of PROVIDER_CLI_NAMES) {
      this.settings.setProviderCliVersion(provider, {
        version: body.providers[provider].version,
        homeManaged: true,
      });
    }
  }

  private applyInBackground(): void {
    setImmediate(() => {
      if (this.stopped) return;
      for (const provider of PROVIDER_CLI_NAMES)
        void this.installer
          .policyChanged(provider)
          .catch((error) => logger.warn({ provider, error }, 'Host provider policy apply failed'));
      this.checkInBackground();
    });
  }

  checkNow(): void {
    setImmediate(() => {
      if (this.stopped) return;
      this.checkInBackground();
    });
  }

  private checkInBackground(): void {
    void this.versions
      .checkNow()
      .catch((error) => logger.warn({ error }, 'Host provider CLI check failed'));
  }

  status(): HostProviderCliSettingsStatus {
    const providers = {} as HostProviderCliSettingsStatus['providers'];
    for (const provider of PROVIDER_CLI_NAMES) {
      const acceptedVersion = this.accepted?.providers[provider].version ?? null;
      const install = this.installer.getStatus(provider);
      const lookup = this.versions.getLookup(provider);
      const target = acceptedVersion === 'latest' ? lookup?.latestVersion : acceptedVersion;
      const error = install.error ?? (acceptedVersion === 'latest' ? lookup?.error : null) ?? null;
      providers[provider] = {
        acceptedVersion,
        installedVersion: install.installedVersion,
        state: providerState({ error, install, acceptedVersion, target }),
        error,
      };
    }
    const applied =
      this.accepted !== null &&
      PROVIDER_CLI_NAMES.every((provider) => providers[provider].state === 'applied');
    return {
      acceptedRevision: this.accepted?.revision ?? null,
      pendingRevision: applied ? null : (this.accepted?.revision ?? null),
      appliedRevision: applied ? this.accepted!.revision : null,
      providers,
    };
  }
}
