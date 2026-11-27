import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type {
  HostIntegrationSecret,
  HostIntegrationsPush,
  HostIntegrationsStatus,
} from '@devchain/shared';
import { ConflictError, VaultUnavailableError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { OnCatalogEvent } from '../../events/catalog/on-catalog-event';
import type { RemoteBindingChangedEventPayload } from '../../events/catalog/remote.binding.changed';
import { KeyedFifoLock } from '../../external-integrations/subscribers/managed-projection-lock';
import {
  deliveredRows,
  hostIntegrationsRevision,
} from '../../external-integrations/vm-cache/integration-push-revision';
import {
  STORAGE_SERVICE,
  type IntegrationStorage,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  DeliveredIntegrationConnection,
  RemoteProjectBinding,
} from '../../storage/models/domain.models';
import { VaultKeyService } from '../../vault/vault-key.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteHealthState } from '../ports/remote-health.port';

const logger = createLogger('RemoteIntegrationPushService');

/**
 * What a VM's `GET /api/runtime` said about its integrations: a status this build reads,
 * no `integrations` field at all (an older or an unclaimed build), or a field this build
 * cannot read.
 */
export type VmIntegrationsReport =
  | { kind: 'status'; status: HostIntegrationsStatus }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/** Who may write a `remote` project's ordinary links; `unknown` when no one can be confirmed. */
export type RemoteLinkWriter = 'vm' | 'home' | 'unknown';

type PushStorage = Pick<
  RemoteStorage,
  'listRemoteProjectBindings' | 'markVmLinkOwners' | 'getVmLinkOwnerSince'
> &
  Pick<
    IntegrationStorage,
    | 'listIntegrationConnections'
    | 'getIntegrationConnectionById'
    | 'getIntegrationConnectionCredentialsById'
    | 'listOrdinaryExternalTaskLinkRows'
    | 'listExternalLinkReceiptIds'
  >;

/**
 * Home owns ClickUp/Jira connections; each VM gets those of the projects bound to it
 * (`remote` or `detaching`), so its agents call the vendor without home. Metadata always
 * goes; credentials go only while home can read them, and their absence revokes nothing.
 * The same push seeds a `remote` project's ordinary links once, and acknowledges the VM
 * link receipts home applied. A seed and a home write of the same project's links never
 * overlap (`withProjectLinks`): a link home writes during a seed would never reach the VM.
 */
@Injectable()
export class RemoteIntegrationPushService implements OnModuleDestroy {
  private readonly pushing = new Map<string, Promise<void>>();
  /** Per remote: the projects the VM last reported seeded. */
  private readonly seeded = new Map<string, Set<string>>();
  /** Per remote: receipts the VM accepted an ack for; home keeps their rows until a pull omits them. */
  private readonly acked = new Map<string, Set<string>>();
  /** Per remote: what its last poll reported about its integrations. */
  private readonly reports = new Map<string, VmIntegrationsReport>();
  /** Remotes whose cache can take a push: the last readable report was a status. */
  private readonly caches = new Set<string>();
  /** `remoteId/projectId@bindingCreatedAt` of the bindings whose VM link owner is recorded. */
  private readonly recordedOwners = new Set<string>();
  /** One FIFO lock per project id over its link writes and seeds. */
  private readonly linkLocks = new KeyedFifoLock();
  private stopped = false;
  private health: ((remoteId: string) => RemoteHealthState) | null = null;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: PushStorage,
    private readonly vault: VaultKeyService,
    private readonly host: RemoteHostClient,
  ) {}

  /** A push still in flight would land on the VM after shutdown: it finishes first. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.pushing.values());
  }

  /** The health service supplies its state at init; without it, no event-driven push runs. */
  useHealth(read: (remoteId: string) => RemoteHealthState): void {
    this.health = read;
  }

  /** Each successful health poll, of a VM of any version, reports what it sent. */
  noteReport(remoteId: string, report: VmIntegrationsReport): void {
    this.reports.set(remoteId, report);
    // An unreadable report proves nothing either way: what an earlier one showed stays.
    if (report.kind === 'status') this.caches.add(remoteId);
    else if (report.kind === 'absent') this.caches.delete(remoteId);
  }

  /**
   * Who writes `projectId`'s ordinary links on `remoteId`; null until the VM's first poll.
   * Once a seed was sent or reported, home's VM link owner record for the current binding
   * keeps the VM the owner whatever it reports later, also after a home restart: a home
   * write would be lost at the next pull. Before that, a VM that reports a seeded set
   * takes seeds and so owns them, and only a VM confirmed to take none (a status without
   * a seeded set, or no status at all) leaves them to home, since it never sends home a
   * link table. An unreadable report confirms neither.
   */
  async linkWriter(remoteId: string, projectId: string): Promise<RemoteLinkWriter | null> {
    if (await this.storage.getVmLinkOwnerSince(projectId)) return 'vm';
    const report = this.reports.get(remoteId);
    if (!report) return null;
    if (report.kind === 'unreadable') return 'unknown';
    return report.kind === 'status' && report.status.seededProjectIds ? 'vm' : 'home';
  }

  /**
   * Health poll: pushes when the VM's applied revision differs or its cache is not ready.
   * It runs also while the versions differ, so connection changes and revocations reach a
   * VM that reports a cache. A VM without a status (older build) gets nothing.
   */
  pushIfChanged(remoteId: string, vm: HostIntegrationsStatus | undefined): Promise<void> {
    if (!vm) return Promise.resolve();
    return this.run(remoteId, vm);
  }

  /** Disconnect shrinks the VM's projects (`detaching` stays until `deleted`): push at once. */
  @OnCatalogEvent('remote.binding.changed', { async: true })
  onBindingChanged(payload: RemoteBindingChangedEventPayload): Promise<void> {
    if (payload.state !== 'detaching' && payload.state !== 'deleted') return Promise.resolve();
    return this.pushNow(payload.remoteId);
  }

  /**
   * Pushes without comparing, after any push that started from the old state. Only to an
   * online VM whose last poll reported a cache, of any version. Never rejects: a failure
   * is logged and the next poll retries.
   */
  async pushNow(remoteId: string): Promise<void> {
    const state = this.health?.(remoteId);
    if (!state?.online || state.apiKeyRejected || !this.caches.has(remoteId)) return;
    // A poll can start another push while this one waits: wait until none is in flight.
    await this.idle(remoteId);
    return this.run(remoteId, null);
  }

  /**
   * Resolves once the VM reports the project's links seeded, pushing a seed when it is
   * not. Rejects with the push's error, or retryable `REMOTE_LINKS_NOT_SEEDED` when the
   * VM still lacks the seed (an older build, or the project is not `remote` on it).
   */
  async seedConfirmed(remoteId: string, projectId: string): Promise<void> {
    if (this.seeded.get(remoteId)?.has(projectId)) return;
    await this.idle(remoteId);
    if (this.seeded.get(remoteId)?.has(projectId)) return;
    if (this.stopped) throw linksNotSeeded(remoteId, projectId);
    const pushed = this.push(remoteId, null, [projectId]);
    void this.track(
      remoteId,
      pushed.catch(() => undefined),
    );
    await pushed;
    if (!this.seeded.get(remoteId)?.has(projectId)) throw linksNotSeeded(remoteId, projectId);
  }

  /** The VM refused a write as unseeded: the next `seedConfirmed` pushes the seed again. */
  forgetSeeded(remoteId: string, projectId: string): void {
    this.seeded.get(remoteId)?.delete(projectId);
  }

  /** Runs `fn` holding the link lock of every project in `projectIds`. */
  async withProjectLinks<T>(projectIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    return this.linkLocks.runAll(projectIds, fn);
  }

  private run(remoteId: string, vm: HostIntegrationsStatus | null): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.pushing.get(remoteId);
    if (pending) return pending;
    return this.track(
      remoteId,
      this.push(remoteId, vm).catch((error) =>
        logger.warn(
          { remoteId, error: error instanceof Error ? error.message : String(error) },
          'Integrations push failed; next poll will retry',
        ),
      ),
    );
  }

  /** Waits until no push to `remoteId` is in flight. */
  private async idle(remoteId: string): Promise<void> {
    for (let pending = this.pushing.get(remoteId); pending; pending = this.pushing.get(remoteId)) {
      await pending;
    }
  }

  /** Registers `push`, which never rejects, as the in-flight push to `remoteId` until it settles. */
  private track(remoteId: string, push: Promise<void>): Promise<void> {
    const tracked = push.finally(() => {
      if (this.pushing.get(remoteId) === tracked) this.pushing.delete(remoteId);
    });
    this.pushing.set(remoteId, tracked);
    return tracked;
  }

  /** `forceSeed`: projects to seed even when the VM's seeded set is not known yet. */
  private async push(
    remoteId: string,
    vm: HostIntegrationsStatus | null,
    forceSeed: readonly string[] = [],
  ): Promise<void> {
    const bindings = (await this.storage.listRemoteProjectBindings()).filter(
      (binding) =>
        binding.remoteId === remoteId &&
        (binding.state === 'remote' || binding.state === 'detaching'),
    );
    const projectIds = new Set(bindings.map((binding) => binding.projectId));
    const connections = deliveredRows(await this.storage.listIntegrationConnections()).filter(
      (connection) => projectIds.has(connection.projectId),
    );
    const revision = hostIntegrationsRevision(connections);
    const current = vm?.appliedRevision === revision;
    if (vm?.seededProjectIds) this.seeded.set(remoteId, new Set(vm.seededProjectIds));
    const seeded = this.seeded.get(remoteId);
    await this.markVmLinks(remoteId, bindings, seeded ?? []);
    // A VM that reports no seeded set takes no seed; a detaching project is not seeded.
    // A seed hands the links to the VM, so only a VM of this version gets one.
    const seedable = this.health?.(remoteId)?.versionMatches !== false;
    const unseeded = bindings
      .filter(
        (binding) =>
          seedable &&
          binding.state === 'remote' &&
          !seeded?.has(binding.projectId) &&
          (seeded !== undefined || forceSeed.includes(binding.projectId)),
      )
      .map((binding) => binding.projectId);
    return this.withProjectLinks(unseeded, async () => {
      // Before the seed leaves, and under the lock a link write decides in. A binding that
      // was replaced since `bindings` was read gets no record and no seed, whatever this
      // run recorded for it before.
      const owned = await this.markVmLinks(remoteId, bindings, unseeded, { confirm: true });
      return this.send(remoteId, vm, {
        revision,
        current,
        connections,
        projectIds,
        unseeded: unseeded.filter((projectId) => owned.has(projectId)),
      });
    });
  }

  /**
   * Records `remoteId` as the owner of the links of the `remote` bindings in `projectIds`,
   * each only while it is still the project's current binding. With `confirm`, every binding
   * is checked in storage, and the result is the projects whose record storage confirmed
   * for the binding read. Without it, a binding already recorded in this run is skipped.
   */
  private async markVmLinks(
    remoteId: string,
    bindings: readonly RemoteProjectBinding[],
    projectIds: Iterable<string>,
    { confirm = false }: { confirm?: boolean } = {},
  ): Promise<Set<string>> {
    const ids = new Set(projectIds);
    const key = (binding: RemoteProjectBinding) =>
      `${binding.remoteId}/${binding.projectId}@${binding.createdAt}`;
    const due = bindings.filter(
      (binding) =>
        binding.state === 'remote' &&
        binding.remoteId === remoteId &&
        ids.has(binding.projectId) &&
        (confirm || !this.recordedOwners.has(key(binding))),
    );
    const marked = new Set(due.length > 0 ? await this.storage.markVmLinkOwners(due) : []);
    for (const binding of due) {
      if (marked.has(binding.projectId)) this.recordedOwners.add(key(binding));
    }
    return marked;
  }

  private async send(
    remoteId: string,
    vm: HostIntegrationsStatus | null,
    plan: {
      revision: string;
      current: boolean;
      connections: DeliveredIntegrationConnection[];
      projectIds: ReadonlySet<string>;
      unseeded: readonly string[];
    },
  ): Promise<void> {
    const { revision, current, connections, projectIds, unseeded } = plan;
    const receiptIds = await this.storage.listExternalLinkReceiptIds([...projectIds]);
    const acked = new Set(
      [...(this.acked.get(remoteId) ?? [])].filter((id) => receiptIds.includes(id)),
    );
    this.acked.set(remoteId, acked);
    const acks = receiptIds.filter((id) => !acked.has(id));
    const linksDue =
      unseeded.length > 0 || (acks.length > 0 && (vm === null || (vm.pendingReceipts ?? 0) > 0));
    // A VM that cannot hold credentials gets metadata and link changes only.
    const secretsDue = !(current && vm && (vm.cacheReady || vm.cacheUnavailable !== null));
    if (!secretsDue && !linksDue) return;
    const secrets = !secretsDue || vm?.cacheUnavailable ? [] : await this.readSecrets(connections);
    if (current && secrets.length === 0 && !linksDue) return;
    const seed = await Promise.all(
      unseeded.map(async (projectId) => ({
        projectId,
        links: await this.storage.listOrdinaryExternalTaskLinkRows(projectId),
      })),
    );
    if (this.stopped) return;
    const body: HostIntegrationsPush = {
      revision,
      connections,
      ...(seed.length > 0 ? { seed } : {}),
      ...(acks.length > 0 ? { acks: acks.map((receiptId) => ({ receiptId })) } : {}),
      ...(secrets.length > 0 ? { secrets } : {}),
    };
    const seededAfter = await this.host.putIntegrations(remoteId, body);
    for (const id of acks) acked.add(id);
    if (seededAfter) this.seeded.set(remoteId, new Set(seededAfter));
    logger.info(
      {
        remoteId,
        connections: connections.length,
        secrets: secrets.length,
        seeded: seed.length,
        acks: acks.length,
      },
      'Pushed integration connections to the VM',
    );
  }

  /**
   * Credentials of `connections` that home can read now, each at the generation it
   * sends. None while the Vault is locked or unlocking. The result holds tokens: never log it.
   */
  private async readSecrets(
    connections: readonly DeliveredIntegrationConnection[],
  ): Promise<HostIntegrationSecret[]> {
    const state = this.vault.getState();
    if (state === 'locked' || state === 'unlocking') return [];
    const secrets: HostIntegrationSecret[] = [];
    for (const connection of connections) {
      let credentials;
      try {
        credentials = await this.storage.getIntegrationConnectionCredentialsById(connection.id);
      } catch (error) {
        if (error instanceof VaultUnavailableError) return [];
        logger.warn(
          { connectionId: connection.id, error: error instanceof Error ? error.name : 'unknown' },
          'Integration credentials unreadable; the VM gets the connection without them',
        );
        continue;
      }
      // A token replaced between the reads goes at the next poll, under its own generation.
      const after = await this.storage.getIntegrationConnectionById(connection.id);
      if (!credentials || after?.generation !== connection.generation) continue;
      secrets.push({ connectionId: connection.id, generation: connection.generation, credentials });
    }
    return secrets;
  }
}

function linksNotSeeded(remoteId: string, projectId: string): ConflictError {
  return new ConflictError(
    "The VM has not received this project's ClickUp and Jira links yet; try again shortly.",
    { code: 'REMOTE_LINKS_NOT_SEEDED', retryable: true, remoteId, projectId },
  );
}
