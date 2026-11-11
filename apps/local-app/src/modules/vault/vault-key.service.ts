import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BehaviorSubject, type Observable } from 'rxjs';
import { getEnvConfig } from '../../common/config/env.config';
import {
  ConflictError,
  ForbiddenError,
  StorageError,
  ValidationError,
  VaultUnavailableError,
} from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import { isClaimedHost } from '../remotes/host-api-key';
import { STORAGE_SERVICE, type VaultKeySlotStorage } from '../storage/interfaces/storage.interface';
import type {
  CreateVaultKeySlot,
  VaultKeySlot,
  VaultKeySlotKind,
} from '../storage/models/domain.models';
import {
  deriveRecoveryKek,
  envelopeDekVersion,
  generateRecoveryCode,
  generateVaultKey,
  newRecoveryKdfParams,
  open,
  parseRecoveryCode,
  seal,
  slotAad,
  valueAad,
} from './vault-crypto';
import { VaultFileKey } from './vault-file-key';
import {
  VAULT_KEYSTORE,
  VaultKeystoreUnavailableError,
  type VaultKeystore,
} from './vault-keystore';

const logger = createLogger('VaultKeyService');

const DEK_VERSION = 1;
const PENDING_CODE_DOMAIN = 'vault';
const PENDING_CODE_FIELD = 'pending-recovery-code';

export type VaultState = 'not_set_up' | 'unlocking' | 'locked' | 'unlocked';
export type VaultProtection = 'keystore' | 'file' | 'recovery';
export type VaultSetupMode = 'file' | 'recovery';
/** Why the Vault is `not_set_up` or `locked`; null while unlocking or unlocked. */
export type VaultStateReason =
  | 'claimed_host'
  | 'keystore_unavailable'
  | 'keystore_missing'
  | 'keystore_timeout'
  | 'keystore_error'
  | 'key_mismatch'
  | 'file_key_missing'
  | 'recovery_required';

/** Never carries a key or a recovery code; safe for REST, events and logs. */
export interface VaultStatus {
  state: VaultState;
  protection: VaultProtection | null;
  reason: VaultStateReason | null;
  keystoreAvailable: boolean;
  recoveryCodePending: boolean;
}

export const VAULT_OPTIONS = Symbol('VAULT_OPTIONS');

export interface VaultOptions {
  /** How long start waits for an automatic unlock before it reports `locked`. */
  unlockTimeoutMs: number;
  /** First background retry delay after a keystore timeout or error; it doubles per retry. */
  retryIntervalMs: number;
  /** Directory of the `file` protection key. */
  fileKeyDirectory: string;
}

const RETRIED_REASONS: ReadonlySet<VaultStateReason> = new Set([
  'keystore_timeout',
  'keystore_error',
]);
// A retry can show the user another keystore prompt, so retries back off and stop.
const MAX_RETRIES = 6;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

interface NewVault {
  vaultId: string;
  dek: Buffer;
  recoverySlot: CreateVaultKeySlot;
}

/**
 * Owns the Vault data key (DEK) and its lock state. The DEK lives only in this
 * process's memory; the DB holds copies wrapped by a key-encryption key from
 * the OS credential store, a recovery code, or the opt-in key file.
 */
@Injectable()
export class VaultKeyService implements OnModuleInit, OnModuleDestroy {
  private readonly options: VaultOptions;
  private readonly fileKey: VaultFileKey;
  private readonly statusSubject: BehaviorSubject<VaultStatus>;
  private slots: VaultKeySlot[] = [];
  private keystoreAvailable = false;
  private dek: Buffer | null = null;
  private vaultId: string | null = null;
  private pendingRecoveryCode: string | null = null;
  private automatic: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: VaultKeySlotStorage,
    @Inject(VAULT_KEYSTORE) private readonly keystore: VaultKeystore,
    @Optional() @Inject(VAULT_OPTIONS) options?: Partial<VaultOptions>,
  ) {
    this.options = {
      unlockTimeoutMs: 3000,
      retryIntervalMs: 30_000,
      fileKeyDirectory: join(homedir(), '.devchain', 'vault'),
      ...options,
    };
    this.fileKey = new VaultFileKey(this.options.fileKeyDirectory);
    this.statusSubject = new BehaviorSubject<VaultStatus>(this.buildStatus('unlocking', null));
  }

  /**
   * Nest awaits this before the server listens. A keystore prompt can wait
   * without limit, so the wait is bounded and the attempt continues behind it.
   */
  async onModuleInit(): Promise<void> {
    if (this.isClaimed()) {
      this.publish('not_set_up', 'claimed_host');
      return;
    }
    if (!(await this.within(this.startAutomatic())) && this.getState() === 'unlocking') {
      this.publish(this.slots.length > 0 ? 'locked' : 'not_set_up', 'keystore_timeout');
      this.scheduleRetry();
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dek?.fill(0);
    this.dek = null;
    this.pendingRecoveryCode = null;
    this.statusSubject.complete();
  }

  getState(): VaultState {
    return this.statusSubject.value.state;
  }

  getStatus(): VaultStatus {
    return this.statusSubject.value;
  }

  statusChanges(): Observable<VaultStatus> {
    return this.statusSubject.asObservable();
  }

  /** The recovery code until the user confirms it was saved; only while unlocked. */
  getPendingRecoveryCode(): string | null {
    return this.dek ? this.pendingRecoveryCode : null;
  }

  /** Throws `VaultUnavailableError` unless the Vault is unlocked. */
  encrypt(domain: string, recordId: string, field: string, plaintext: string | Buffer): string {
    const dek = this.requireDek();
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return seal(dek, DEK_VERSION, valueAad(domain, recordId, field, DEK_VERSION), data);
  }

  /**
   * Throws `VaultUnavailableError` unless the Vault is unlocked, and
   * `StorageError` when the envelope does not open under this binding.
   */
  decrypt(domain: string, recordId: string, field: string, envelope: string): Buffer {
    const dek = this.requireDek();
    try {
      const dekVersion = envelopeDekVersion(envelope);
      if (dekVersion !== DEK_VERSION) throw new Error('Unknown data key version');
      return open(dek, valueAad(domain, recordId, field, dekVersion), envelope);
    } catch {
      throw new StorageError('Unable to decrypt the stored value.');
    }
  }

  /** First setup without a keystore. DevChain never chooses `file` on its own. */
  async setup(mode: VaultSetupMode): Promise<VaultStatus> {
    this.assertHome();
    return this.serial(async () => {
      this.slots = await this.storage.listVaultKeySlots();
      if (this.slots.length > 0) {
        throw new ConflictError('The Vault is already set up.', { code: 'VAULT_ALREADY_SET_UP' });
      }
      const vault = await this.newVault();
      const slots = [vault.recoverySlot];
      if (mode === 'file') {
        slots.push(this.wrapSlot(vault, 'file', this.fileKey.readOrCreate()));
      }
      this.slots = await this.storage.initializeVaultKeySlots(slots);
      this.unlock(vault.dek, vault.vaultId);
      logger.info({ mode }, 'Vault set up');
      return this.getStatus();
    });
  }

  /**
   * Unlocks with the recovery code. When an OS credential store is available,
   * also stores a new keystore slot, so the next start unlocks on its own.
   */
  async unlockWithRecoveryCode(recoveryCode: string): Promise<VaultStatus> {
    this.assertHome();
    const unlocked = await this.serial(async () => {
      if (this.dek) return false;
      this.slots = await this.storage.listVaultKeySlots();
      const slot = this.slots.find((candidate) => candidate.kind === 'recovery');
      if (!slot?.kdfParams) {
        throw new ConflictError('The Vault is not set up.', { code: 'VAULT_NOT_SET_UP' });
      }
      const secret = parseRecoveryCode(recoveryCode);
      const dek = secret
        ? this.unwrap(slot, await deriveRecoveryKek(secret, slot.kdfParams))
        : null;
      if (!dek) {
        logger.warn('Vault recovery code rejected');
        throw new ValidationError('The recovery code is not correct.', {
          code: 'VAULT_RECOVERY_CODE_INVALID',
        });
      }
      this.unlock(dek, slot.vaultId);
      logger.info('Vault unlocked with the recovery code');
      return true;
    });
    if (unlocked) {
      this.keystoreAvailable = this.keystore.isAvailable();
      if (this.keystoreAvailable) await this.within(this.addKeystoreSlot());
    }
    return this.getStatus();
  }

  async confirmRecoveryCode(): Promise<VaultStatus> {
    this.assertHome();
    return this.serial(async () => {
      await this.storage.clearVaultPendingRecoveryCode();
      this.pendingRecoveryCode = null;
      this.slots = await this.storage.listVaultKeySlots();
      this.republish();
      logger.info('Vault recovery code confirmed');
      return this.getStatus();
    });
  }

  private startAutomatic(): Promise<void> {
    if (!this.automatic) {
      this.automatic = this.runAutomatic().finally(() => {
        this.automatic = null;
        this.scheduleRetry();
      });
    }
    return this.automatic;
  }

  private async runAutomatic(): Promise<void> {
    try {
      this.slots = await this.storage.listVaultKeySlots();
      this.keystoreAvailable = this.keystore.isAvailable();
      if (this.slots.length === 0) await this.autoSetup();
      else await this.autoUnlock();
    } catch (error) {
      logger.warn({ error: describeError(error) }, 'Vault automatic unlock failed');
      if (!this.dek) {
        this.publish(
          this.slots.length > 0 ? 'locked' : 'not_set_up',
          error instanceof VaultKeystoreUnavailableError
            ? 'keystore_unavailable'
            : 'keystore_error',
        );
      }
    }
  }

  /** With a keystore, the first start makes the DEK, a keystore slot and a recovery slot. */
  private async autoSetup(): Promise<void> {
    if (!this.keystoreAvailable) {
      this.publish('not_set_up', 'keystore_unavailable');
      return;
    }
    const vault = await this.newVault();
    const kek = generateVaultKey();
    const keystoreSlot = this.wrapSlot(vault, 'keystore', kek);
    const account = keystoreSlot.keystoreAccount!;
    await this.keystore.write(account, kek);
    await this.serial(async () => {
      try {
        this.slots = await this.storage.initializeVaultKeySlots([keystoreSlot, vault.recoverySlot]);
      } catch (error) {
        if (error instanceof ConflictError) {
          // The user set the Vault up while the keystore write waited.
          this.removeKeystoreItem(account);
          return;
        }
        throw error;
      }
      this.unlock(vault.dek, vault.vaultId);
      logger.info({ mode: 'keystore' }, 'Vault set up');
    });
  }

  private async autoUnlock(): Promise<void> {
    // A recovery-code unlock can land while `runAutomatic` waits for the slot list: keep the DEK and its state.
    if (this.dek) return;
    const fileSlot = this.slots.find((slot) => slot.kind === 'file');
    if (fileSlot) {
      const kek = this.fileKey.read();
      const dek = kek ? this.unwrap(fileSlot, kek) : null;
      if (dek) {
        await this.serial(async () => {
          if (!this.dek) this.unlock(dek, fileSlot.vaultId);
        });
        return;
      }
    }
    const keystoreSlot = this.slots.find((slot) => slot.kind === 'keystore');
    if (!keystoreSlot?.keystoreAccount) {
      this.publish('locked', fileSlot ? 'file_key_missing' : 'recovery_required');
      return;
    }
    if (!this.keystoreAvailable) {
      this.publish('locked', 'keystore_unavailable');
      return;
    }
    const kek = await this.keystore.read(keystoreSlot.keystoreAccount);
    await this.serial(async () => {
      if (this.dek) return;
      if (!kek) {
        this.publish('locked', 'keystore_missing');
        return;
      }
      const dek = this.unwrap(keystoreSlot, kek);
      if (!dek) {
        this.publish('locked', 'key_mismatch');
        return;
      }
      this.unlock(dek, keystoreSlot.vaultId);
    });
  }

  /** Writes a new keystore item, then replaces the keystore slot when the write lands. */
  private async addKeystoreSlot(): Promise<void> {
    const dek = this.dek;
    const vaultId = this.vaultId;
    if (!dek || !vaultId) return;
    const kek = generateVaultKey();
    const slot = this.wrapSlot({ vaultId, dek }, 'keystore', kek);
    const account = slot.keystoreAccount!;
    try {
      await this.keystore.write(account, kek);
    } catch (error) {
      logger.warn({ error: describeError(error) }, 'Vault keystore slot not created');
      return;
    }
    await this.serial(async () => {
      const previous = this.slots.find((candidate) => candidate.kind === 'keystore');
      await this.storage.replaceVaultKeySlot(slot);
      this.slots = await this.storage.listVaultKeySlots();
      this.republish();
      logger.info('Vault keystore slot created');
      if (previous?.keystoreAccount) this.removeKeystoreItem(previous.keystoreAccount);
    });
  }

  private scheduleRetry(): void {
    const status = this.getStatus();
    if (status.state === 'unlocked') this.retries = 0;
    if (
      this.destroyed ||
      this.retryTimer ||
      this.retries >= MAX_RETRIES ||
      !status.reason ||
      !RETRIED_REASONS.has(status.reason)
    ) {
      return;
    }
    const delay = Math.min(this.options.retryIntervalMs * 2 ** this.retries, MAX_RETRY_DELAY_MS);
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startAutomatic();
    }, delay);
    this.retryTimer.unref();
  }

  private async newVault(): Promise<NewVault> {
    const vaultId = randomUUID();
    const dek = generateVaultKey();
    const code = generateRecoveryCode();
    const kdfParams = newRecoveryKdfParams();
    const kek = await deriveRecoveryKek(parseRecoveryCode(code)!, kdfParams);
    const recoverySlot = this.wrapSlot({ vaultId, dek }, 'recovery', kek, {
      kdfParams,
      pendingRecoveryCode: seal(
        dek,
        DEK_VERSION,
        valueAad(PENDING_CODE_DOMAIN, vaultId, PENDING_CODE_FIELD, DEK_VERSION),
        Buffer.from(code, 'utf8'),
      ),
    });
    return { vaultId, dek, recoverySlot };
  }

  private wrapSlot(
    vault: Pick<NewVault, 'vaultId' | 'dek'>,
    kind: VaultKeySlotKind,
    kek: Buffer,
    extra: Partial<Pick<CreateVaultKeySlot, 'kdfParams' | 'pendingRecoveryCode'>> = {},
  ): CreateVaultKeySlot {
    const id = randomUUID();
    return {
      id,
      vaultId: vault.vaultId,
      kind,
      dekVersion: DEK_VERSION,
      wrappedDek: seal(kek, DEK_VERSION, slotAad(vault.vaultId, id, kind, DEK_VERSION), vault.dek),
      // The vault id keeps instances with different DB_PATH apart under one OS user.
      keystoreAccount: kind === 'keystore' ? `vault-${vault.vaultId}-${id}` : null,
      kdfParams: extra.kdfParams ?? null,
      pendingRecoveryCode: extra.pendingRecoveryCode ?? null,
    };
  }

  private unwrap(slot: VaultKeySlot, kek: Buffer): Buffer | null {
    try {
      return open(kek, slotAad(slot.vaultId, slot.id, slot.kind, slot.dekVersion), slot.wrappedDek);
    } catch {
      return null;
    }
  }

  private unlock(dek: Buffer, vaultId: string): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dek = dek;
    this.vaultId = vaultId;
    const sealed = this.slots.find((slot) => slot.pendingRecoveryCode)?.pendingRecoveryCode;
    this.pendingRecoveryCode = null;
    if (sealed) {
      try {
        this.pendingRecoveryCode = open(
          dek,
          valueAad(PENDING_CODE_DOMAIN, vaultId, PENDING_CODE_FIELD, DEK_VERSION),
          sealed,
        ).toString('utf8');
      } catch {
        logger.warn('Vault pending recovery code could not be opened');
      }
    }
    this.publish('unlocked', null);
  }

  private removeKeystoreItem(account: string): void {
    void this.keystore.remove(account).catch((error: unknown) => {
      logger.warn({ error: describeError(error) }, 'Vault keystore item not removed');
    });
  }

  private requireDek(): Buffer {
    if (!this.dek) throw new VaultUnavailableError(this.getState());
    return this.dek;
  }

  /** Throws 403 `VAULT_HOME_ONLY` on a claimed VM; every Vault write calls it first. */
  assertHome(): void {
    if (this.isClaimed()) {
      throw new ForbiddenError('The Vault is available only on the home instance.', {
        code: 'VAULT_HOME_ONLY',
      });
    }
  }

  private isClaimed(): boolean {
    return isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR);
  }

  /** True when `task` settled before the unlock time limit. */
  private async within(task: Promise<unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.options.unlockTimeoutMs);
    });
    try {
      return await Promise.race([
        task.then(
          () => true,
          () => true,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private republish(): void {
    const status = this.getStatus();
    this.publish(status.state, status.reason);
  }

  private publish(state: VaultState, reason: VaultStateReason | null): void {
    if (this.destroyed) return;
    const next = this.buildStatus(state, reason);
    const current = this.statusSubject.value;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    logger.info(next, 'Vault status changed');
    this.statusSubject.next(next);
  }

  private buildStatus(state: VaultState, reason: VaultStateReason | null): VaultStatus {
    // The first kind in PROTECTION_ORDER that has a slot names the protection.
    const protection =
      PROTECTION_ORDER.find((kind) => this.slots.some((slot) => slot.kind === kind)) ?? null;
    return {
      state,
      protection,
      reason,
      keystoreAvailable: this.keystoreAvailable,
      recoveryCodePending: this.slots.some((slot) => slot.pendingRecoveryCode !== null),
    };
  }
}

const PROTECTION_ORDER: readonly VaultProtection[] = ['file', 'keystore', 'recovery'];

/** Error class and code only: messages of fs and keystore errors can carry paths. */
function describeError(error: unknown): { name: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { name: typeof error };
}
