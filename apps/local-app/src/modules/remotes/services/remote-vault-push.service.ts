import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { HostVaultStatus } from '@devchain/shared';
import { VaultUnavailableError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { OnCatalogEvent } from '../../events/catalog/on-catalog-event';
import type { RemoteBindingChangedEventPayload } from '../../events/catalog/remote.binding.changed';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { VaultPushBuilder } from '../../vault/vault-push.builder';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteHealthState } from '../ports/remote-health.port';
import type { RemoteVaultDeliveryPort } from '../ports/remote-vault-delivery.port';

const logger = createLogger('RemoteVaultPushService');

/**
 * Home owns the Vault; each VM gets the entries granted to the projects it holds.
 * Nothing goes while home's Vault is not unlocked, so the VM keeps its cache.
 */
@Injectable()
export class RemoteVaultPushService implements RemoteVaultDeliveryPort, OnModuleDestroy {
  private readonly pushing = new Map<string, Promise<void>>();
  private stopped = false;
  private health: ((remoteId: string) => RemoteHealthState) | null = null;

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<RemoteStorage, 'listRemoteProjectBindings'>,
    private readonly builder: VaultPushBuilder,
    private readonly host: RemoteHostClient,
  ) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /**
   * The health service supplies its state at init, so the two services do not depend
   * on each other through Nest DI. Without it, no event-driven push runs.
   */
  useHealth(read: (remoteId: string) => RemoteHealthState): void {
    this.health = read;
  }

  /**
   * Health poll: pushes when the VM's applied revision differs or its cache is not
   * ready. A VM without a status (older build) or without a tmpfs directory gets nothing.
   */
  pushIfChanged(remoteId: string, vm: HostVaultStatus | undefined): Promise<void> {
    if (!vm || vm.cacheUnavailable !== null) return Promise.resolve();
    return this.run(remoteId, vm);
  }

  /**
   * Disconnect (`detaching`, then `deleted`) shrinks the VM's projects: push the smaller
   * set at once instead of at the next poll. After the last project leaves, the set is
   * empty and the VM removes its cache file. Connect pushes in its own `vault_push` step.
   */
  @OnCatalogEvent('remote.binding.changed', { async: true })
  onBindingChanged(payload: RemoteBindingChangedEventPayload): Promise<void> {
    if (payload.state !== 'detaching' && payload.state !== 'deleted') return Promise.resolve();
    return this.pushNow(payload.remoteId);
  }

  /**
   * Pushes without comparing, after any push that started from the old project set.
   * Only to an online VM of this version. Never rejects: a failure is logged and the
   * next poll retries.
   */
  async pushNow(remoteId: string): Promise<void> {
    const state = this.health?.(remoteId);
    if (!state?.online || !state.versionMatches || state.apiKeyRejected) return;
    await this.pushing.get(remoteId);
    return this.run(remoteId, null);
  }

  async pushConfirmed(remoteId: string): Promise<void> {
    // A push already running may predate the caller's write: wait for it, then push again.
    while (this.pushing.has(remoteId)) await this.pushing.get(remoteId);
    const work = this.push(remoteId, null);
    this.track(remoteId, work);
    if (!(await work)) {
      // `push` also returns false during shutdown; that is not a locked Vault.
      throw this.stopped
        ? new VaultUnavailableError(
            'stopping',
            'DevChain is stopping. Answer the request again after it restarts.',
          )
        : new VaultUnavailableError('locked', 'Unlock the Vault so home can send it to the VM.');
    }
  }

  private run(remoteId: string, vm: HostVaultStatus | null): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.pushing.get(remoteId);
    if (pending) return pending;
    return this.track(remoteId, this.push(remoteId, vm));
  }

  /** Makes `push` the one running for the remote; the tracked promise never rejects. */
  private track(remoteId: string, push: Promise<boolean>): Promise<void> {
    const tracked = push
      .then(() => undefined)
      .catch((error) =>
        logger.warn(
          { remoteId, error: error instanceof Error ? error.message : String(error) },
          'Vault push failed; next poll will retry',
        ),
      )
      .finally(() => {
        if (this.pushing.get(remoteId) === tracked) this.pushing.delete(remoteId);
      });
    this.pushing.set(remoteId, tracked);
    return tracked;
  }

  /** False when nothing was sent: the Vault is locked, the VM already holds this revision, or the service stopped. */
  private async push(remoteId: string, vm: HostVaultStatus | null): Promise<boolean> {
    if (!this.builder.canPush()) return false;
    const projectIds = (await this.storage.listRemoteProjectBindings())
      .filter((binding) => binding.remoteId === remoteId && binding.state === 'remote')
      .map((binding) => binding.projectId);
    const plan = await this.builder.plan(projectIds);
    if (vm && vm.appliedRevision === plan.revision && vm.cacheReady) return false;
    const body = await this.builder.payload(plan);
    if (this.stopped) return false;
    await this.host.putVault(remoteId, body);
    logger.info({ remoteId, entries: body.entries.length }, 'Pushed Vault entries to the VM');
    return true;
  }
}
