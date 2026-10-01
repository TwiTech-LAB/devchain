import { RemoteFileSyncService } from './remote-file-sync.service';
import { createHash } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ProjectReplicaChanges, ProjectReplicaIdSets } from '@devchain/shared';
import { getEnvConfig } from '../../../common/config/env.config';
import { ReplicaApplyError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { RemoteProjectBinding } from '../../storage/models/domain.models';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import type { RemoteMirrorSyncPort } from '../ports/remote-mirror-sync.port';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { RemoteBindingsService } from '../services/remote-bindings.service';

const logger = createLogger('RemoteLiveSyncService');

/** A `changedSince` no row can match: the build then carries small tables and ID sets only. */
const NO_ROWS_SINCE = '9999-12-31T00:00:00.000Z';

/** Live tables the changes feed sends partially; every other live table arrives whole. */
const PARTIAL_TABLES = ['epics', 'epic_tags', 'epic_comments', 'epic_time_segments'] as const;

const ID_SET_TABLES = ['epics', 'epic_comments', 'epic_time_segments'] as const;

interface SyncTarget {
  readonly projectId: string;
  readonly remoteId: string;
  /** The next pull asks for complete ID sets. */
  fullDue: boolean;
  lastFullAt: number;
  offline: boolean;
  /** An apply failed and the re-snapshot has not succeeded yet; no earlier than `resnapshotAt`. */
  resnapshotDue: boolean;
  resnapshotAt: number;
  /** Hash of the whole-arriving tables as last applied, to skip pulls that change nothing. */
  appliedHash: string | null;
  inFlight: Promise<void> | null;
}

/**
 * Mirrors each connected project from its host by polling the host's changes
 * feed; there is no socket client, so this loop is the only path by which host
 * database writes reach home. Every tick pulls rows changed since the binding's
 * `hostCursor`; a periodic full pull adds the host's complete ID sets so host
 * deletes reach home. The cursor is a host timestamp and advances only after a
 * successful apply. A failed apply records `syncError` on the binding (its
 * state stays `remote`) and heals with a full re-snapshot.
 */
@Injectable()
export class RemoteLiveSyncService
  implements OnApplicationBootstrap, OnApplicationShutdown, RemoteMirrorSyncPort
{
  private readonly targets = new Map<string, SyncTarget>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly syncIntervalMs: number;
  private readonly reconcileIntervalMs: number;

  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly applier: ProjectReplicaApplier,
    private readonly builder: ProjectReplicaBuilder,
    private readonly files: RemoteFileSyncService,
  ) {
    const config = getEnvConfig();
    this.syncIntervalMs = config.REMOTES_SYNC_INTERVAL_MS;
    this.reconcileIntervalMs = config.REMOTES_RECONCILE_INTERVAL_MS;
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const binding of await this.bindings.list()) {
      // Home may have been off for a while: begin with a full reconcile.
      if (binding.state === 'remote')
        this.start(binding.projectId, binding.remoteId, { full: true });
    }
    this.timer = setInterval(() => this.tick(), this.syncIntervalMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(targets.map((target) => target.inFlight));
    for (const target of targets) this.files.forget(target.projectId);
  }

  /** Idempotent; restarting a running project keeps its state. */
  start(projectId: string, remoteId: string, options: { full?: boolean } = {}): void {
    const existing = this.targets.get(projectId);
    if (existing?.remoteId === remoteId) {
      if (options.full) existing.fullDue = true;
      return;
    }
    this.targets.set(projectId, {
      projectId,
      remoteId,
      fullDue: options.full === true,
      lastFullAt: Date.now(),
      offline: false,
      resnapshotDue: false,
      resnapshotAt: 0,
      appliedHash: null,
      inFlight: null,
    });
    logger.info({ projectId, remoteId }, 'Live sync started');
  }

  /** Resolves once a pull in flight has finished; nothing it does after that is written. */
  async stop(projectId: string): Promise<void> {
    const target = this.targets.get(projectId);
    if (!target) return;
    this.targets.delete(projectId);
    logger.info({ projectId }, 'Live sync stopped');
    await target.inFlight;
    this.files.forget(projectId);
  }

  isRunning(projectId: string): boolean {
    return this.targets.has(projectId);
  }

  /** Runs one pull for the project now, unless one is in flight (then waits for it). */
  async syncNow(projectId: string): Promise<void> {
    const target = this.targets.get(projectId);
    if (!target) return;
    await (target.inFlight ?? this.launch(target));
  }

  /** Unlike `syncNow`, never settles for a pull that began before this call. */
  async pullNow(projectId: string): Promise<void> {
    const target = this.targets.get(projectId);
    if (!target) return;
    await target.inFlight;
    if (!this.isCurrent(target)) return;
    await (target.inFlight ?? this.launch(target));
  }

  private tick(): void {
    for (const target of this.targets.values()) {
      if (!target.inFlight) void this.launch(target);
    }
  }

  private launch(target: SyncTarget): Promise<void> {
    const run = this.pullWithFiles(target)
      .catch((error: unknown) => {
        if (!this.stopped) {
          logger.warn({ error, projectId: target.projectId }, 'Live sync pull failed');
        }
      })
      .finally(() => {
        target.inFlight = null;
      });
    target.inFlight = run;
    return run;
  }

  private async pullWithFiles(target: SyncTarget): Promise<void> {
    await this.files.tick(target.projectId, target.remoteId, () => this.isCurrent(target));
    if (this.isCurrent(target)) await this.pull(target);
  }

  private async pull(target: SyncTarget): Promise<void> {
    const { projectId, remoteId } = target;
    const health = this.health.getState(remoteId);
    // A rejected API key blocks every pull, so it counts as offline until the key is fixed.
    if (!health.online || health.apiKeyRejected) {
      target.offline = true;
      return;
    }
    if (target.offline) {
      target.offline = false;
      target.fullDue = true;
    }

    const binding = await this.bindings.get(projectId);
    if (!binding || binding.state !== 'remote' || binding.remoteId !== remoteId) return;

    // A persisted failure outlives this target (restart, detach cancel): the
    // mirror is only known good again after a re-snapshot, so an incremental
    // pull must not clear or silently carry it.
    if (binding.syncError !== null && !target.resnapshotDue) {
      target.resnapshotDue = true;
      target.resnapshotAt = 0;
    }

    const now = Date.now();
    if (target.resnapshotDue) {
      if (now >= target.resnapshotAt) await this.resnapshot(target, binding);
      return;
    }

    const full = target.fullDue || now - target.lastFullAt >= this.reconcileIntervalMs;
    let changes: ProjectReplicaChanges;
    try {
      changes = await this.host.changes(remoteId, projectId, { since: binding.hostCursor, full });
    } catch (error) {
      if (error instanceof RemoteHostRequestError && error.status === null) return;
      throw error;
    }
    if (!this.isCurrent(target)) return;

    const hash = wholeTablesHash(changes);
    if (await this.needsApply(target, changes, hash)) {
      try {
        await this.applier.apply(changes.replica, {
          mode: 'live',
          remoteId,
          cursor: changes.cursor,
          idSets: changes.idSets,
        });
      } catch (error) {
        if (!(error instanceof ReplicaApplyError)) throw error;
        if (!this.isCurrent(target)) return;
        logger.warn({ projectId, table: error.table }, 'Live sync apply failed');
        await this.bindings.update(projectId, { syncError: error.message });
        await this.resnapshot(target, binding);
        return;
      }
      if (!this.isCurrent(target)) return;
      await this.advanceCursor(binding, changes.cursor);
    }
    target.appliedHash = hash;
    if (full) {
      target.fullDue = false;
      target.lastFullAt = now;
    }
  }

  /**
   * A pull whose partial tables are empty, whose whole tables match the last
   * apply and whose ID sets match home's changes nothing; skipping it keeps the
   * event log and the clients quiet between host writes.
   */
  private async needsApply(
    target: SyncTarget,
    changes: ProjectReplicaChanges,
    hash: string,
  ): Promise<boolean> {
    const tables = changes.replica.tables;
    if (PARTIAL_TABLES.some((table) => tables[table].length > 0)) return true;
    if (hash !== target.appliedHash) return true;
    if (!changes.idSets) return false;
    return !(await this.homeIdSetsMatch(target.projectId, changes.idSets));
  }

  private async homeIdSetsMatch(
    projectId: string,
    hostIdSets: ProjectReplicaIdSets,
  ): Promise<boolean> {
    const home = await this.builder.build({
      projectIds: [projectId],
      scope: 'live',
      changedSince: NO_ROWS_SINCE,
      includeIdSets: true,
    });
    if (!home.ok || !home.idSets) return false;
    const homeIdSets = home.idSets;
    return ID_SET_TABLES.every((table) => sameIds(homeIdSets[table], hostIdSets[table]));
  }

  /**
   * Replaces the mirror with a full attach-scope copy. Home-only tables,
   * home's provider env values and home's instance-level provider config
   * stay as they are.
   */
  private async resnapshot(target: SyncTarget, binding: RemoteProjectBinding): Promise<void> {
    const { projectId, remoteId } = target;
    try {
      const snapshot = await this.host.exportReplica(remoteId, projectId, 'attach');
      if (!this.isCurrent(target)) return;
      await this.applier.apply(snapshot, {
        mode: 'full',
        remoteId,
        cursor: snapshot.generatedAt,
        keepInstanceConfig: true,
      });
      if (!this.isCurrent(target)) return;
      target.resnapshotDue = false;
      target.appliedHash = null;
      target.fullDue = false;
      target.lastFullAt = Date.now();
      await this.bindings.update(projectId, {
        syncError: null,
        ...(isLater(snapshot.generatedAt, binding.hostCursor) && {
          hostCursor: snapshot.generatedAt,
        }),
      });
      logger.info({ projectId }, 'Live sync re-snapshot applied');
    } catch (error) {
      if (!this.isCurrent(target)) return;
      target.resnapshotDue = true;
      target.resnapshotAt = Date.now() + this.reconcileIntervalMs;
      logger.warn({ error, projectId }, 'Live sync re-snapshot failed; retrying later');
      if (error instanceof ReplicaApplyError) {
        await this.bindings.update(projectId, { syncError: error.message });
      }
    }
  }

  private async advanceCursor(binding: RemoteProjectBinding, cursor: string): Promise<void> {
    if (!isLater(cursor, binding.hostCursor)) return;
    await this.bindings.update(binding.projectId, { hostCursor: cursor });
  }

  private isCurrent(target: SyncTarget): boolean {
    return !this.stopped && this.targets.get(target.projectId) === target;
  }
}

function wholeTablesHash(changes: ProjectReplicaChanges): string {
  const tables: Record<string, unknown> = { ...changes.replica.tables };
  for (const table of PARTIAL_TABLES) delete tables[table];
  return createHash('sha256')
    .update(JSON.stringify({ workspace: changes.replica.workspace, tables }))
    .digest('hex');
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === sortedRight[index]);
}

/** The cursor never moves backwards. */
function isLater(candidate: string, current: string | null): boolean {
  return current === null || Date.parse(candidate) > Date.parse(current);
}
