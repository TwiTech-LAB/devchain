import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { VaultUnavailableError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import { VaultStoreKey, type VaultStoreKeyMode } from '../storage/local/vault-store-key';
import type { VaultStoreMigrationResult, VaultStoreName } from '../storage/models/domain.models';
import { VaultKeyService, type VaultStatus } from './vault-key.service';

const logger = createLogger('VaultStoreMigrationService');

const MIGRATIONS = [
  'migrateIntegrationCredentialsToVault',
  'migrateProviderAuthPayloadsToVault',
  'migrateVmProviderTokensToVault',
] as const satisfies ReadonlyArray<keyof StorageService>;

type MigrationStorage = Pick<StorageService, (typeof MIGRATIONS)[number]>;

/**
 * - `not_applicable`: the Vault has no auto-unlock slot, is not set up, or this is a claimed VM;
 * - `waiting`: the stores wait for the Vault to unlock;
 * - `done`: every row is on the Vault key;
 * - `incomplete`: rows remain on the legacy key; the next unlock or start tries again.
 */
export type VaultStoreMigrationState =
  | 'not_applicable'
  | 'waiting'
  | 'running'
  | 'done'
  | 'incomplete';

/** Counts only; safe for REST and logs. */
export interface VaultStoreMigrationStatus {
  state: VaultStoreMigrationState;
  stores: Array<Omit<VaultStoreMigrationResult, 'migrated'>>;
}

/**
 * Which key the migrated stores use. Only a Vault that unlocks on its own at
 * start (`keystore` or `file`) protects them: with recovery-code-only
 * protection, every start would lock ClickUp/Jira, provider logins and Proxmox
 * until the user types the code.
 */
export function vaultStoreKeyMode(status: VaultStatus): VaultStoreKeyMode {
  if (status.reason === 'claimed_host') return 'legacy';
  if (status.state === 'unlocking') return 'locked';
  if (status.protection !== 'keystore' && status.protection !== 'file') return 'legacy';
  return status.state === 'unlocked' ? 'vault' : 'locked';
}

/**
 * Moves the ClickUp/Jira credentials, provider-login payloads and Proxmox
 * tokens from the integration credential key to the Vault data key. Runs after
 * each unlock until every row is moved; each row moves in its own transaction.
 */
@Injectable()
export class VaultStoreMigrationService implements OnModuleInit, OnModuleDestroy {
  private subscription: Subscription | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private results = new Map<VaultStoreName, VaultStoreMigrationResult>();
  private lastRunFailed = false;

  constructor(
    private readonly vault: VaultKeyService,
    @Inject(STORAGE_SERVICE) private readonly storage: MigrationStorage,
    storeKey: VaultStoreKey,
  ) {
    storeKey.bind({
      mode: () => this.mode(),
      state: () => this.vault.getState(),
      encrypt: (domain, recordId, field, plaintext) =>
        this.vault.encrypt(domain, recordId, field, plaintext),
      decrypt: (domain, recordId, field, envelope) =>
        this.vault.decrypt(domain, recordId, field, envelope).toString('utf8'),
    });
  }

  onModuleInit(): void {
    this.subscription = this.vault.statusChanges().subscribe((status) => {
      if (vaultStoreKeyMode(status) === 'vault') void this.run();
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  getStatus(): VaultStoreMigrationStatus {
    const stores = [...this.results.values()].map(({ migrated: _migrated, ...counts }) => counts);
    return { state: this.state(), stores };
  }

  /** Resolves when the current run, and any run requested during it, is over. */
  run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.migrateAll();
        } while (this.rerun && this.mode() === 'vault');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async migrateAll(): Promise<void> {
    if (this.mode() !== 'vault') return;
    this.lastRunFailed = false;
    for (const migration of MIGRATIONS) {
      try {
        const result = await this.storage[migration]();
        this.results.set(result.store, result);
        if (result.migrated > 0 || result.failed > 0) {
          logger.info(result, 'Stores moved to the Vault key');
        }
      } catch (error) {
        this.lastRunFailed = true;
        logger.warn(
          { error: error instanceof Error ? error.name : typeof error },
          'Moving stores to the Vault key stopped',
        );
        if (error instanceof VaultUnavailableError) return;
      }
    }
  }

  private mode(): VaultStoreKeyMode {
    return vaultStoreKeyMode(this.vault.getStatus());
  }

  private state(): VaultStoreMigrationState {
    const mode = this.mode();
    if (mode === 'legacy') return 'not_applicable';
    if (this.running) return 'running';
    if (mode === 'locked') return 'waiting';
    const results = [...this.results.values()];
    const complete =
      !this.lastRunFailed &&
      results.length === MIGRATIONS.length &&
      results.every((result) => result.vault === result.total);
    return complete ? 'done' : 'incomplete';
  }
}
