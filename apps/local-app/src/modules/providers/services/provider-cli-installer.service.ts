import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { existsSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  NPM_PUBLIC_REGISTRY_URL,
  ProviderCliNameSchema,
  isExactStableSemver,
  type ProviderCliName,
  type ProviderCliInstallStatus,
  type ProviderCliVersionEntry,
} from '@devchain/shared';
import { getEnvConfig } from '../../../common/config/env.config';
import { resolveBinary } from '../../../common/resolve-binary';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { ProviderEffortSeedingService } from './provider-effort-seeding.service';
import { ProviderProjectSyncService } from './provider-project-sync.service';
import { ProviderCliInstallStateService } from './provider-cli-install-state.service';
import { applyProviderCliNoUpdate } from '../adapters/provider-cli-policy';

const logger = createLogger('ProviderCliInstallerService');

/** Scopes of the scoped provider packages (`@anthropic-ai`, `@openai`, `@github`), in package order. */
const PROVIDER_CLI_NPM_SCOPES = Object.values(PROVIDER_CLI_NPM_PACKAGES)
  .filter((name) => name.startsWith('@'))
  .map((name) => name.split('/')[0]);

export function providerCliInstallArgs(
  provider: ProviderCliName,
  version: string,
  prefix: string,
): string[] {
  ProviderCliNameSchema.parse(provider);
  if (!isExactStableSemver(version))
    throw new Error('Provider CLI version must be an exact stable semver');
  return [
    'install',
    '-g',
    '--prefix',
    prefix,
    `--registry=${NPM_PUBLIC_REGISTRY_URL}`,
    ...PROVIDER_CLI_NPM_SCOPES.map((scope) => `--${scope}:registry=${NPM_PUBLIC_REGISTRY_URL}`),
    '--include=optional',
    '--ignore-scripts=false',
    '--omit=dev',
    '--no-fund',
    '--no-audit',
    `${PROVIDER_CLI_NPM_PACKAGES[provider]}@${version}`,
  ];
}

@Injectable()
export class ProviderCliInstallerService implements OnModuleInit, OnModuleDestroy {
  private ready?: Promise<void>;
  private stopped = false;
  private readonly jobs = new Map<ProviderCliName, Promise<void>>();
  private readonly targets = new Map<ProviderCliName, string | null>();
  private readonly epochs = new Map<ProviderCliName, number>();
  private readonly processed = new Map<ProviderCliName, string>();
  private readonly mutations = new Map<ProviderCliName, Promise<unknown>>();

  constructor(
    private readonly state: ProviderCliInstallStateService,
    private readonly settings: SettingsService,
    private readonly executor: ProcessExecutor,
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<
      StorageService,
      'createProvider' | 'listProviders' | 'updateProvider'
    >,
    private readonly sessions: ActiveSessionLookup,
    private readonly effortSeeding: ProviderEffortSeedingService,
    private readonly projectSync: ProviderProjectSyncService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.initialize();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private initialize(): Promise<void> {
    return (this.ready ??= (async () => {
      await mkdir(join(this.state.root, 'bin'), { recursive: true });
      for (const provider of PROVIDER_CLI_NAMES) {
        await this.cleanStaging(provider);
        if (this.state.read(provider).state === 'installing')
          this.state.patch(provider, { state: 'idle' });
      }
    })());
  }

  getStatus(provider: ProviderCliName): ProviderCliInstallStatus {
    return this.state.getStatus(provider);
  }

  /** True on a claimed VM: it always manages its CLIs and never shows a pin list. */
  isHost(): boolean {
    return existsSync(join(getEnvConfig().DEVCHAIN_HOST_ETC_DIR, 'claim.json'));
  }

  private policy(provider: ProviderCliName): ProviderCliVersionEntry {
    return this.settings.getProviderCliVersions()[provider];
  }

  private managed(policy: ProviderCliVersionEntry): boolean {
    return this.isHost() || policy.homeManaged;
  }

  /** Called as soon as a setting changes, before any registry request can finish. */
  async policyChanged(provider: ProviderCliName): Promise<void> {
    this.bumpEpoch(provider);
    if (!this.managed(this.policy(provider))) {
      await this.restoreOwnInstall(provider);
      return;
    }
    this.reconcileInBackground(provider);
  }

  /** Binary-path edits serialize with activation, but never wait for npm. */
  async editBinaryPath<T>(
    providerName: string,
    path: string | null,
    edit: () => Promise<T>,
  ): Promise<T> {
    const parsed = ProviderCliNameSchema.safeParse(providerName.toLowerCase());
    if (!parsed.success || this.isHost()) return edit();
    const provider = parsed.data;
    return this.withMutation(provider, async () => {
      const result = await edit();
      const policy = this.policy(provider);
      if (policy.homeManaged || this.state.read(provider).originalBinPath !== undefined) {
        this.settings.setProviderCliVersion(provider, { ...policy, homeManaged: false });
        this.bumpEpoch(provider);
        this.state.patch(provider, { originalBinPath: path, state: 'idle', error: null });
      }
      return result;
    });
  }

  async reconcile(provider: ProviderCliName, latestVersion: string | null): Promise<void> {
    if (this.stopped) return;
    this.targets.set(provider, latestVersion);
    await this.initialize();
    if (!this.managed(this.policy(provider))) return this.restoreOwnInstall(provider);
    const existing = this.jobs.get(provider);
    if (existing) return existing;
    const job = this.runJobs(provider).finally(() => {
      this.jobs.delete(provider);
      if (
        !this.stopped &&
        this.managed(this.policy(provider)) &&
        this.processed.get(provider) !== this.requestKey(provider)
      ) {
        this.reconcileInBackground(provider);
      }
    });
    this.jobs.set(provider, job);
    return job;
  }

  private async runJobs(provider: ProviderCliName): Promise<void> {
    let previousKey: string | undefined;
    while (!this.stopped && this.managed(this.policy(provider))) {
      const policy = this.policy(provider);
      const target = this.targetVersion(provider, policy);
      const epoch = this.epoch(provider);
      const key = this.requestKey(provider);
      this.processed.set(provider, key);
      if (key === previousKey) return;
      previousKey = key;
      if (!target) return;
      await this.install(provider, target, policy, epoch);
    }
  }

  private requestKey(provider: ProviderCliName): string {
    const policy = this.policy(provider);
    return JSON.stringify([policy, this.targetVersion(provider, policy), this.epoch(provider)]);
  }

  /** The version a policy resolves to: its pin, or the latest known release for `latest`. */
  private targetVersion(
    provider: ProviderCliName,
    policy: ProviderCliVersionEntry,
  ): string | null | undefined {
    return policy.version === 'latest' ? this.targets.get(provider) : policy.version;
  }

  private epoch(provider: ProviderCliName): number {
    return this.epochs.get(provider) ?? 0;
  }

  private bumpEpoch(provider: ProviderCliName): void {
    this.epochs.set(provider, this.epoch(provider) + 1);
  }

  private reconcileInBackground(provider: ProviderCliName): void {
    void this.reconcile(provider, this.targets.get(provider) ?? null).catch((error) =>
      logger.warn({ provider, error }, 'Managed provider reconciliation failed'),
    );
  }

  private current(
    provider: ProviderCliName,
    target: string,
    policy: ProviderCliVersionEntry,
    epoch: number,
  ): boolean {
    const now = this.policy(provider);
    return (
      !this.stopped &&
      this.managed(now) &&
      now.version === policy.version &&
      now.homeManaged === policy.homeManaged &&
      this.epoch(provider) === epoch &&
      (now.version !== 'latest' || this.targets.get(provider) === target)
    );
  }

  private async install(
    provider: ProviderCliName,
    version: string,
    policy: ProviderCliVersionEntry,
    epoch: number,
  ): Promise<void> {
    let staging: string | undefined;
    try {
      if (!isExactStableSemver(version))
        throw new Error('Provider CLI version must be an exact stable semver');
      const directory = join(this.state.directory(provider), version);
      const local = this.state.read(provider);
      const { items } = await this.storage.listProviders();
      if (!this.current(provider, version, policy, epoch)) return;
      if (
        local.installedVersion === version &&
        items.some(
          (row) => row.name.toLowerCase() === provider && row.binPath === this.state.link(provider),
        ) &&
        existsSync(this.state.link(provider))
      ) {
        this.state.write(provider, {
          ...local,
          desiredVersion: policy.version,
          state: 'idle',
          error: null,
        });
        await this.retain(provider);
        return;
      }
      this.state.write(provider, {
        ...local,
        desiredVersion: policy.version,
        state: 'installing',
        error: null,
      });
      if (!existsSync(directory)) {
        const npm =
          (await resolveBinary(join(dirname(process.execPath), 'npm'), this.executor)) ??
          (await resolveBinary('npm', this.executor));
        if (!npm) throw new Error('npm not found; stays on own install');
        staging = join(this.state.directory(provider), `.staging-${randomUUID()}`);
        await mkdir(staging, { recursive: true });
        const result = await this.executor.run({
          argv: [npm, ...providerCliInstallArgs(provider, version, staging)],
          cwd: staging,
          mode: 'pipe',
          timeout: 10 * 60_000,
          outputLimits: { maxBytes: 64 * 1024 },
        });
        if (!result.success || result.exitCode !== 0)
          throw new Error(
            result.timedOut
              ? 'npm install timed out'
              : `npm install failed (exit ${result.exitCode})`,
          );
        await this.checkInstall(provider, version, staging);
        await rename(staging, directory);
        staging = undefined;
      }
      await this.checkInstall(provider, version, directory);
      await this.withMutation(provider, async () => {
        const { items } = await this.storage.listProviders();
        const row = items.find((item) => item.name.toLowerCase() === provider);
        if (!this.current(provider, version, policy, epoch)) return;
        const local = this.state.read(provider);
        const link = this.state.link(provider);
        const originalBinPath =
          row?.binPath === link ? local.originalBinPath : (row?.binPath ?? null);
        this.state.patch(provider, { originalBinPath });
        let oldLink: string | null = null;
        try {
          oldLink = readlinkSync(link);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.switchLink(link, join(directory, 'bin', provider));
        try {
          if (row) await this.storage.updateProvider(row.id, { binPath: link });
          else {
            const created = await this.storage.createProvider({
              name: provider,
              binPath: link,
              mcpConfigured: false,
              mcpEndpoint: null,
              mcpRegisteredAt: null,
            });
            await this.effortSeeding
              .seedForProvider(created)
              .catch((error) => logger.warn({ provider, error }, 'Provider effort seeding failed'));
            await this.projectSync
              .syncProviderToAllProjects(created.id)
              .catch((error) => logger.warn({ provider, error }, 'Provider project sync failed'));
          }
        } catch (error) {
          if (oldLink) this.switchLink(link, oldLink);
          else unlinkSync(link);
          throw error;
        }
        this.state.patch(provider, {
          installedVersion: version,
          previousVersion:
            local.installedVersion !== version ? local.installedVersion : local.previousVersion,
          state: 'idle',
          error: null,
          checkedAt: new Date().toISOString(),
        });
      });
      await this.retain(provider);
    } catch (error) {
      if (this.current(provider, version, policy, epoch)) {
        this.state.patch(provider, {
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        });
      }
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      if (this.state.read(provider).state === 'installing')
        this.state.patch(provider, { state: 'idle' });
    }
  }

  private async checkInstall(
    provider: ProviderCliName,
    version: string,
    directory: string,
  ): Promise<void> {
    const pkg = JSON.parse(
      await readFile(
        join(directory, 'lib', 'node_modules', PROVIDER_CLI_NPM_PACKAGES[provider], 'package.json'),
        'utf8',
      ),
    );
    if (pkg.version !== version)
      throw new Error(
        `Installed package version mismatch: expected ${version}, got ${String(pkg.version)}`,
      );
    const command = applyProviderCliNoUpdate(
      provider,
      [join(directory, 'bin', provider), '--version'],
      process.env,
    );
    const result = await this.executor.run({
      argv: command.argv,
      env: command.env,
      cwd: directory,
      mode: 'pipe',
      timeout: 30_000,
      outputLimits: { maxBytes: 8192 },
    });
    if (!result.success || result.exitCode !== 0)
      throw new Error('Installed provider CLI failed its start probe');
  }

  private switchLink(link: string, target: string): void {
    const temporary = `${link}.${randomUUID()}.tmp`;
    symlinkSync(target, temporary);
    try {
      renameSync(temporary, link);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private async restoreOwnInstall(provider: ProviderCliName): Promise<void> {
    await this.withMutation(provider, async () => {
      if (this.managed(this.policy(provider))) return;
      const local = this.state.read(provider);
      const { items } = await this.storage.listProviders();
      const row = items.find((item) => item.name.toLowerCase() === provider);
      if (this.managed(this.policy(provider))) return;
      if (row?.binPath === this.state.link(provider) && local.originalBinPath !== undefined)
        await this.storage.updateProvider(row.id, { binPath: local.originalBinPath });
      this.state.write(provider, {
        ...local,
        desiredVersion: this.policy(provider).version,
        state: 'idle',
        error: null,
      });
    });
  }

  private async cleanStaging(provider: ProviderCliName): Promise<void> {
    const directory = this.state.directory(provider);
    await mkdir(directory, { recursive: true });
    for (const entry of await readdir(directory))
      if (entry.startsWith('.staging-'))
        await rm(join(directory, entry), { recursive: true, force: true });
  }

  private async retain(provider: ProviderCliName): Promise<void> {
    const sessions = await this.sessions.listRunningProviderSessions();
    // Legacy sessions without a launch snapshot may still use any provider's files.
    if (
      sessions.some(
        (session) =>
          !session.providerNameAtLaunch || session.providerNameAtLaunch.toLowerCase() === provider,
      )
    )
      return;
    const local = this.state.read(provider);
    for (const entry of await readdir(this.state.directory(provider))) {
      if (
        isExactStableSemver(entry) &&
        entry !== local.installedVersion &&
        entry !== local.previousVersion
      )
        await rm(join(this.state.directory(provider), entry), { recursive: true, force: true });
    }
  }

  private async withMutation<T>(provider: ProviderCliName, run: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(provider) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.mutations.set(provider, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(provider) === next) this.mutations.delete(provider);
    }
  }
}
