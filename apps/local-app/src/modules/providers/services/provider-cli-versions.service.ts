import { ProviderCliInstallerService } from './provider-cli-installer.service';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getEnvConfig } from '../../../common/config/env.config';
import { createLogger } from '../../../common/logging/logger';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  type ProviderCliLookupResult,
  type ProviderCliName,
  type ProviderCliStatus,
  type ProviderCliVersionEntry,
  type ProviderClisOverview,
} from '@devchain/shared';
import { SettingsService } from '../../settings/services/settings.service';
import { ProviderCliNpmLookupService } from './provider-cli-npm-lookup.service';

const logger = createLogger('ProviderCliVersionsService');

export const PROVIDER_CLI_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Checks the public npm registry for provider CLI releases on every machine
 * (home and VMs run the same code): once at DevChain start without blocking
 * startup, then every 6 hours, plus on demand through "Check now". The check
 * delegates activation to the installer without delaying registry responses.
 * The installer owns machine-local status surfaced in the overview.
 */
@Injectable()
export class ProviderCliVersionsService implements OnModuleInit, OnModuleDestroy {
  private readonly lookups = new Map<ProviderCliName, ProviderCliLookupResult>();
  private remoteCheck: (() => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<Record<ProviderCliName, ProviderCliLookupResult>> | null = null;

  constructor(
    private readonly npmLookup: ProviderCliNpmLookupService,
    private readonly settings: SettingsService,
    private readonly installer: ProviderCliInstallerService,
  ) {}

  onModuleInit(): void {
    // `PROVIDER_CLI_CHECKS_ENABLED=false` turns off the scheduled checks; "Check now" still runs.
    if (!getEnvConfig().PROVIDER_CLI_CHECKS_ENABLED) return;
    this.timer = setInterval(() => this.checkInBackground(), PROVIDER_CLI_CHECK_INTERVAL_MS);
    // Fire-and-forget: a slow or unreachable registry must never delay startup.
    this.checkInBackground();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** "Check now": runs immediately and returns the fresh results. */
  async checkNow(
    includeRemotes = false,
  ): Promise<Record<ProviderCliName, ProviderCliLookupResult>> {
    if (!this.inFlight)
      this.inFlight = this.checkAll().finally(() => {
        this.inFlight = null;
      });
    const [results] = await Promise.all([
      this.inFlight,
      includeRemotes ? this.remoteCheck?.() : undefined,
    ]);
    return results;
  }

  registerRemoteCheck(check: () => Promise<void>): () => void {
    this.remoteCheck = check;
    return () => {
      if (this.remoteCheck === check) this.remoteCheck = null;
    };
  }

  getLookup(provider: ProviderCliName): ProviderCliLookupResult | null {
    return this.lookups.get(provider) ?? null;
  }

  getOverview(): ProviderClisOverview {
    const storedSettings = this.settings.getProviderCliVersions();
    const providers = {} as Record<ProviderCliName, ProviderCliStatus>;
    for (const provider of PROVIDER_CLI_NAMES) {
      providers[provider] = {
        provider,
        npmPackage: PROVIDER_CLI_NPM_PACKAGES[provider],
        setting: storedSettings[provider],
        lookup: this.lookups.get(provider) ?? null,
        install: this.installer.getStatus(provider),
      };
    }
    return { providers };
  }

  /** Validates and persists one provider's version entry. */
  async setVersion(
    provider: string,
    entry: ProviderCliVersionEntry,
  ): Promise<ProviderCliVersionEntry> {
    const saved = this.settings.setProviderCliVersion(provider, entry);
    await this.installer.policyChanged(provider as ProviderCliName);
    // The installer already has the latest target from the last check; only a
    // provider without one needs the registry now.
    if (!this.lookups.get(provider as ProviderCliName)?.latestVersion) this.checkInBackground();
    return saved;
  }

  private checkInBackground(): void {
    void this.checkNow().catch((error) => logger.warn({ error }, 'Provider CLI check failed'));
  }

  private async checkAll(): Promise<Record<ProviderCliName, ProviderCliLookupResult>> {
    const results = await Promise.all(
      PROVIDER_CLI_NAMES.map(async (provider) => {
        // A failure of one provider's lookup never fails the others.
        const result = await this.checkOne(provider);
        this.lookups.set(provider, result);
        void this.installer.reconcile(provider, result.latestVersion).catch((error) => {
          logger.warn({ provider, error }, 'Managed provider reconciliation failed');
        });
        return [provider, result] as const;
      }),
    );
    return Object.fromEntries(results) as Record<ProviderCliName, ProviderCliLookupResult>;
  }

  private async checkOne(provider: ProviderCliName): Promise<ProviderCliLookupResult> {
    const npmPackage = PROVIDER_CLI_NPM_PACKAGES[provider];
    const checkedAt = new Date().toISOString();
    // A failed lookup keeps what this machine last knew, so a machine that is
    // briefly offline still shows it.
    const previous = this.lookups.get(provider);
    // The pin list is a large download (every published version) that only
    // home's Providers page shows: a VM skips it, and a failed list never costs
    // the small `latest` lookup that installs depend on.
    const [latest, list] = await Promise.allSettled([
      this.npmLookup.fetchLatestVersion(npmPackage),
      this.installer.isHost()
        ? Promise.resolve([])
        : this.npmLookup.fetchStableVersions(npmPackage),
    ]);

    let versions = previous?.versions ?? [];
    if (list.status === 'fulfilled') {
      versions = list.value;
    } else {
      logger.warn(
        { provider, error: errorMessage(list.reason) },
        'Provider CLI version list lookup failed',
      );
    }

    if (latest.status === 'rejected') {
      const message = errorMessage(latest.reason);
      logger.warn({ provider, error: message }, 'Provider CLI npm lookup failed');
      return {
        latestVersion: previous?.latestVersion ?? null,
        versions,
        checkedAt,
        error: message,
      };
    }
    logger.info({ provider, latestVersion: latest.value }, 'Provider CLI npm lookup completed');
    return { latestVersion: latest.value, versions, checkedAt, error: null };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
