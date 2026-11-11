import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getEnvConfig } from '../../common/config/env.config';
import { createLogger } from '../../common/logging/logger';
import type { VaultRequestPendingEventPayload } from '../events/catalog/vault.request.pending';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../remotes/ports/remote-health.port';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type RemoteStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import type { Agent } from '../storage/models/domain.models';
import { VaultAccessService, type VaultGrantedView } from '../vault/vault-access.service';
import { classifyRequest } from './vault-request.service';
import { VaultRequestStore, type VaultRequest } from './vault-request.store';

const logger = createLogger('VaultRequestMirrorService');

type MirrorStorage = Pick<RemoteStorage, 'listRemoteProjectBindings'> &
  Pick<AgentStorage, 'getAgent'> &
  Pick<VaultEntryStorage, 'listVaultEntries'>;

/**
 * Home's copy of the Vault requests pending on each claimed VM, so every answering
 * surface here sees them. Each version-matched health poll fetches the VM's list; the
 * VM owns the request and its lifetime, and home only shows and answers it.
 *
 * Home trusts a reported request only when its project is held by that VM and its agent
 * belongs to that project here: a session-only answer sends the value to the VM.
 */
@Injectable()
export class VaultRequestMirrorService implements OnModuleInit, OnModuleDestroy {
  /**
   * The latest fetch or loss of each remote. A newer one makes an older result stale.
   * Versions come from one sequence, so an entry can be dropped without reuse.
   */
  private readonly versions = new Map<string, number>();
  private sequence = 0;
  /** Store changes for one remote apply in order, never interleaved. */
  private readonly applying = new Map<string, Promise<void>>();
  private unregister?: () => void;

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly host: RemoteHostClient,
    @Inject(STORAGE_SERVICE) private readonly storage: MirrorStorage,
    private readonly store: VaultRequestStore,
    private readonly access: VaultAccessService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.health.registerPollListener({
      polled: (remoteId) => void this.poll(remoteId),
      lost: (remoteId) => void this.lose(remoteId),
    });
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async poll(remoteId: string): Promise<void> {
    const version = this.bump(remoteId);
    try {
      const reported = await this.host.listVaultRequests(remoteId);
      if (this.versions.get(remoteId) !== version) return;
      const accepted = await this.accept(remoteId, reported);
      await this.apply(remoteId, version, () =>
        this.store.syncRemote(remoteId, accepted, getEnvConfig().REMOTES_HEALTH_INTERVAL_MS),
      );
    } catch (error) {
      // Every poll retries; the requests already mirrored keep their timers meanwhile.
      logger.debug(
        { remoteId, error: error instanceof Error ? error.message : String(error) },
        'Vault request polling failed',
      );
    }
  }

  async lose(remoteId: string): Promise<void> {
    if (!this.versions.has(remoteId)) return;
    const version = this.bump(remoteId);
    await this.apply(remoteId, version, () => this.store.dropRemote(remoteId));
    if (this.versions.get(remoteId) === version) this.versions.delete(remoteId);
  }

  private bump(remoteId: string): number {
    const version = ++this.sequence;
    this.versions.set(remoteId, version);
    return version;
  }

  private apply(remoteId: string, version: number, work: () => Promise<void>): Promise<void> {
    const run = (this.applying.get(remoteId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => (this.versions.get(remoteId) === version ? work() : undefined));
    this.applying.set(remoteId, run);
    return run.finally(() => {
      if (this.applying.get(remoteId) === run) this.applying.delete(remoteId);
    });
  }

  private async accept(
    remoteId: string,
    reported: VaultRequestPendingEventPayload[],
  ): Promise<VaultRequest[]> {
    if (reported.length === 0) return [];
    const held = new Set(
      (await this.storage.listRemoteProjectBindings())
        .filter((binding) => binding.remoteId === remoteId && binding.state === 'remote')
        .map((binding) => binding.projectId),
    );
    // Requests of one report share agents and projects: read each once per poll.
    const agentReads = new Map<string, ReturnType<MirrorStorage['getAgent']>>();
    const grantedViews = new Map<string, Promise<VaultGrantedView | null>>();
    const entryReads = new Map<string, ReturnType<MirrorStorage['listVaultEntries']>>();
    const cachedEntries: Pick<VaultEntryStorage, 'listVaultEntries'> = {
      listVaultEntries: (filter) => {
        const key = filter?.projectId ?? '';
        let rows = entryReads.get(key);
        if (!rows) {
          rows = this.storage.listVaultEntries(filter);
          entryReads.set(key, rows);
        }
        return rows;
      },
    };
    const accepted: VaultRequest[] = [];
    for (const request of reported) {
      const refusal = { remoteId, requestId: request.requestId, projectId: request.projectId };
      if (!held.has(request.projectId)) {
        logger.warn(refusal, 'Refused a Vault request for a project the VM does not hold');
        continue;
      }
      let agentRead = agentReads.get(request.agentId);
      if (!agentRead) {
        agentRead = this.storage.getAgent(request.agentId);
        agentReads.set(request.agentId, agentRead);
      }
      const agent = await agentRead.catch(() => null);
      if (agent?.projectId !== request.projectId) {
        logger.warn(
          { ...refusal, agentId: request.agentId },
          'Refused a Vault request from an agent outside its project',
        );
        continue;
      }
      if (request.type === 'use') {
        const use = await this.acceptUse(request, agent, grantedViews);
        if (use) accepted.push(use);
        else logger.warn(refusal, 'Refused a use request for an entry the agent cannot use');
        continue;
      }
      accepted.push({
        ...request,
        agentName: agent.name,
        // The VM classified the request against only the entries pushed to it.
        ...(await classifyRequest(cachedEntries, request.projectId, request.name, request.kind)),
      });
    }
    return accepted;
  }

  /**
   * A `use` request keeps its type: the entry exists. Home checks again that the entry
   * is granted to the agent's family here and still needs approval, through the same
   * `grantedForSession` every other Vault surface authorizes with, since a `family`
   * answer stores the family this view resolves.
   */
  private async acceptUse(
    request: VaultRequestPendingEventPayload,
    agent: Agent,
    grantedViews: Map<string, Promise<VaultGrantedView | null>>,
  ): Promise<VaultRequest | null> {
    const key = `${agent.id}\u0000${request.sessionId}`;
    let read = grantedViews.get(key);
    if (!read) {
      // Home's session overlay holds nothing for a VM session, so the view is the grants.
      read = this.access.grantedForSession(agent, request.sessionId).catch(() => null);
      grantedViews.set(key, read);
    }
    const view = await read;
    const entry = view?.stored.find((candidate) => candidate.id === request.entryId);
    if (!view || !entry?.approvalRequired || entry.name !== request.name) return null;
    return { ...request, agentName: agent.name, familySlug: view.familySlug, kind: entry.kind };
  }
}
