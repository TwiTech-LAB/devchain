import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConflictError } from '../../common/errors/error-types';
import { createLogger } from '../../common/logging/logger';
import type { EventPayload } from '../events/catalog';
import { OnCatalogEvent } from '../events/catalog/on-catalog-event';
import { EventsService } from '../events/services/events.service';
import type { VaultRequestPendingEventPayload } from '../events/catalog/vault.request.pending';
import type { VaultRequestResolvedEventPayload } from '../events/catalog/vault.request.resolved';

/** The refusal of an answer to a request that is not pending, or not the caller's to see. */
export function vaultRequestNotPending(): ConflictError {
  return new ConflictError('This Vault request is no longer pending.', {
    code: 'VAULT_REQUEST_NOT_PENDING',
  });
}

const logger = createLogger('VaultRequestStore');

export const VAULT_REQUEST_TTL_MS = 30 * 60 * 1000;

/**
 * One agent's ask for a Vault entry; the `vault.request.pending` event schema is the
 * one owner of its shape (the store publishes a request as that payload verbatim).
 * It never holds a value. `familySlug` is the requester profile's normalized family;
 * `entryId` is the existing entry a `grant` request asks for, null for `create`.
 */
export type VaultRequest = Readonly<VaultRequestPendingEventPayload>;
export type VaultRequestType = VaultRequest['type'];
export type VaultRequestOutcome = VaultRequestResolvedEventPayload['status'];

export type NewVaultRequest = Omit<VaultRequest, 'requestId' | 'createdAt' | 'expiresAt'>;

/**
 * Pending Vault requests, in memory only: a restart loses them and the agent asks
 * again. At most one pending request per (session, name). Each request ends exactly
 * once — fulfilled, denied or expired. An answer claims the request before its work
 * with no await in between, so a racing answer gets 409 `VAULT_REQUEST_NOT_PENDING`,
 * and a timer or session stop that lands meanwhile waits for the answer's outcome.
 */
@Injectable()
export class VaultRequestStore implements OnModuleDestroy {
  private readonly pending = new Map<string, VaultRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly claimed = new Set<string>();
  /** Claimed requests whose expiry came while their answer ran. */
  private readonly expireOnRelease = new Set<string>();
  /**
   * The VM each mirrored request came from. After `fulfilled` or `denied` the entry
   * outlives the request here until the VM stops reporting it, so a late report cannot
   * bring an answered request back. An `expired` end deletes it at once: home's own
   * timer can fire before the VM's (the VM set `expiresAt` from its own clock), and the
   * next poll must adopt the request again while the VM still reports it as pending.
   */
  private readonly origins = new Map<string, string>();

  constructor(private readonly events: EventsService) {}

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** The pending request of this session for `name`, if any. */
  findPending(sessionId: string, name: string): VaultRequest | null {
    for (const request of this.pending.values()) {
      if (request.sessionId === sessionId && request.name === name) return request;
    }
    return null;
  }

  /** Adds a request, or returns the one already pending for (session, name). */
  async add(input: NewVaultRequest): Promise<{ request: VaultRequest; created: boolean }> {
    const existing = this.findPending(input.sessionId, input.name);
    if (existing) return { request: existing, created: false };
    const createdAt = Date.now();
    const request: VaultRequest = Object.freeze({
      ...input,
      requestId: randomUUID(),
      createdAt,
      expiresAt: createdAt + VAULT_REQUEST_TTL_MS,
    });
    await this.track(request, VAULT_REQUEST_TTL_MS);
    return { request, created: true };
  }

  /** Arms a pending request: stores it, starts its expiry timer and announces it. */
  private async track(request: VaultRequest, delayMs: number): Promise<void> {
    this.pending.set(request.requestId, request);
    const timer = setTimeout(() => void this.expire(request.requestId), delayMs);
    timer.unref?.();
    this.timers.set(request.requestId, timer);
    await this.events.publish('vault.request.pending', { ...request });
  }

  /** The remote a mirrored request came from; null for a request raised on this instance. */
  remoteOrigin(requestId: string): string | null {
    return this.origins.get(requestId) ?? null;
  }

  /**
   * Makes home's mirror of one remote's pending requests match `reported`, which the
   * caller has already checked. A mirrored request the remote no longer reports ends as
   * `expired`. A new one keeps the remote's requestId, createdAt and expiresAt; its
   * timer here fires no sooner than `minTtlMs`, because the remote set `expiresAt` from
   * its own clock. A request that already ended here is not adopted again.
   */
  async syncRemote(
    remoteId: string,
    reported: readonly VaultRequest[],
    minTtlMs: number,
  ): Promise<void> {
    const reportedIds = new Set(reported.map((request) => request.requestId));
    for (const [requestId, origin] of [...this.origins]) {
      if (origin === remoteId && !reportedIds.has(requestId)) await this.dropMirrored(requestId);
    }
    for (const request of reported) await this.adopt(remoteId, request, minTtlMs);
  }

  /**
   * The remote can no longer be reached or was deleted: its mirrored requests end as
   * `expired`, and answered requests lose their origin entries too.
   */
  async dropRemote(remoteId: string): Promise<void> {
    for (const [requestId, origin] of [...this.origins]) {
      if (origin === remoteId) await this.dropMirrored(requestId);
    }
  }

  private async adopt(remoteId: string, input: VaultRequest, minTtlMs: number): Promise<void> {
    const { requestId } = input;
    if (this.pending.has(requestId) || this.origins.has(requestId)) return;
    this.origins.set(requestId, remoteId);
    // The remote set `expiresAt` from its own clock, so the timer here has a floor.
    await this.track(Object.freeze({ ...input }), Math.max(input.expiresAt - Date.now(), minTtlMs));
  }

  /** Ends a mirrored request as `expired` and forgets its origin, unless an answer holds it. */
  private async dropMirrored(requestId: string): Promise<void> {
    await this.expire(requestId);
    if (!this.pending.has(requestId)) this.origins.delete(requestId);
  }

  get(requestId: string): VaultRequest | null {
    return this.pending.get(requestId) ?? null;
  }

  listPending(): VaultRequest[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  listBySession(sessionId: string): VaultRequest[] {
    return this.listPending().filter((request) => request.sessionId === sessionId);
  }

  /**
   * Ends a pending request as fulfilled or denied and returns it. `work` (the fulfill
   * itself) runs while the request is claimed; when it throws, the request stays
   * pending and the error goes to the caller. `reason` goes to the agent with a denial.
   */
  async resolve(
    requestId: string,
    outcome: 'fulfilled' | 'denied',
    options: { work?: (request: VaultRequest) => Promise<void>; reason?: string | null } = {},
  ): Promise<VaultRequest> {
    const request = this.pending.get(requestId);
    if (!request || this.claimed.has(requestId)) throw vaultRequestNotPending();
    this.claimed.add(requestId);
    try {
      await options.work?.(request);
    } catch (error) {
      this.release(requestId);
      throw error;
    }
    this.claimed.delete(requestId);
    this.expireOnRelease.delete(requestId);
    await this.end(request, outcome, options.reason ?? null);
    return request;
  }

  private release(requestId: string): void {
    this.claimed.delete(requestId);
    if (this.expireOnRelease.delete(requestId)) void this.expire(requestId);
  }

  private async expire(requestId: string): Promise<void> {
    const request = this.pending.get(requestId);
    if (!request) return;
    if (this.claimed.has(requestId)) {
      this.expireOnRelease.add(requestId);
      return;
    }
    await this.end(request, 'expired', null);
  }

  private async end(
    request: VaultRequest,
    outcome: VaultRequestOutcome,
    reason: string | null,
  ): Promise<void> {
    const { requestId } = request;
    this.pending.delete(requestId);
    clearTimeout(this.timers.get(requestId));
    this.timers.delete(requestId);
    if (outcome === 'expired') this.origins.delete(requestId);
    logger.info({ requestId, outcome }, 'Vault request ended');
    await this.events.publish('vault.request.resolved', {
      requestId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      name: request.name,
      status: outcome,
      reason,
    });
  }

  private async expireSession(sessionId: string): Promise<void> {
    for (const request of this.listBySession(sessionId)) {
      await this.expire(request.requestId);
    }
  }

  @OnCatalogEvent('session.stopped', { async: true })
  onSessionStopped(payload: EventPayload<'session.stopped'>): Promise<void> {
    return this.expireSession(payload.sessionId);
  }

  @OnCatalogEvent('session.crashed', { async: true })
  onSessionCrashed(payload: EventPayload<'session.crashed'>): Promise<void> {
    return this.expireSession(payload.sessionId);
  }
}
