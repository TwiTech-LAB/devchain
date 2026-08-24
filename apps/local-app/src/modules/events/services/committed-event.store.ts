import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { EventName } from '../catalog';
import {
  DurableEventRegistryService,
  type CommittedEvent,
  type PreparedEvent,
  type RegisteredDurableEventSubscriber,
} from './durable-event-registry.service';

export interface ClaimedDurableDelivery {
  deliveryId: string;
  deliveryKey: string;
  eventOrder: number;
  leaseOwner: string;
  attempts: number;
  event: CommittedEvent;
}

@Injectable()
export class CommittedEventStore {
  private readonly rawClient: Database.Database;
  private readonly transactionRunner: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly registry: DurableEventRegistryService,
  ) {
    this.rawClient = getRawSqliteClient(db);
    this.transactionRunner = new TransactionRunner(this.rawClient);
  }

  appendInCurrentTransaction(event: PreparedEvent): void {
    if (!this.rawClient.inTransaction) {
      throw new Error('Committed event append requires an active SQLite transaction.');
    }
    this.insertRows(event);
  }

  appendCommitted(event: PreparedEvent): Promise<void> {
    return this.transactionRunner.runImmediateQueued(() => this.insertRows(event));
  }

  async claimNext(
    leaseOwner: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<ClaimedDurableDelivery | null> {
    const subscribers = this.registry.getSubscribers();
    if (subscribers.length === 0) {
      return null;
    }

    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return this.transactionRunner.runImmediateQueued(() => {
      const candidate = subscribers
        .map((subscriber) => this.findCandidate(subscriber, nowIso))
        .filter((row): row is { id: string; eventOrder: number } => row !== null)
        .sort((left, right) => left.eventOrder - right.eventOrder)[0];
      if (!candidate) {
        return null;
      }

      const claimed = this.rawClient
        .prepare(
          `UPDATE event_handlers
           SET status = 'running', attempts = attempts + 1, retry_at = NULL,
               lease_owner = ?, lease_expires_at = ?, started_at = ?, ended_at = NULL
           WHERE id = ?
             AND (
               status = 'pending'
               OR (status = 'retry' AND (retry_at IS NULL OR retry_at <= ?))
               OR (status = 'running' AND lease_expires_at <= ?)
             )`,
        )
        .run(leaseOwner, leaseExpiresAt, nowIso, candidate.id, nowIso, nowIso);
      if (claimed.changes !== 1) {
        return null;
      }

      const row = this.rawClient
        .prepare(
          `SELECT eh.id AS delivery_id, eh.delivery_key, eh.lease_owner, eh.attempts,
                  e.rowid AS event_order,
                  e.id AS event_id, e.name, e.payload_json, e.request_id, e.published_at
           FROM event_handlers eh
           INNER JOIN events e ON e.id = eh.event_id
           WHERE eh.id = ?`,
        )
        .get(candidate.id) as {
        delivery_id: string;
        delivery_key: string;
        event_order: number;
        lease_owner: string;
        attempts: number;
        event_id: string;
        name: EventName;
        payload_json: string;
        request_id: string | null;
        published_at: string;
      };
      return {
        deliveryId: row.delivery_id,
        deliveryKey: row.delivery_key,
        eventOrder: row.event_order,
        leaseOwner: row.lease_owner,
        attempts: row.attempts,
        event: {
          id: row.event_id,
          name: row.name,
          payload: JSON.parse(row.payload_json) as CommittedEvent['payload'],
          requestId: row.request_id,
          publishedAt: row.published_at,
        },
      };
    });
  }

  private findCandidate(
    subscriber: RegisteredDurableEventSubscriber,
    nowIso: string,
  ): { id: string; eventOrder: number } | null {
    if (!subscriber.ordered) {
      const row = this.rawClient
        .prepare(
          `SELECT eh.id, e.rowid AS event_order
           FROM event_handlers eh
           INNER JOIN events e ON e.id = eh.event_id
           WHERE eh.delivery_key = ?
             AND (
               eh.status = 'pending'
               OR (eh.status = 'retry' AND (eh.retry_at IS NULL OR eh.retry_at <= ?))
               OR (eh.status = 'running' AND eh.lease_expires_at <= ?)
             )
           ORDER BY e.rowid
           LIMIT 1`,
        )
        .get(subscriber.deliveryKey, nowIso, nowIso) as
        | { id: string; event_order: number }
        | undefined;
      return row ? { id: row.id, eventOrder: row.event_order } : null;
    }

    const row = this.rawClient
      .prepare(
        `SELECT eh.id, e.rowid AS event_order, eh.status, eh.retry_at, eh.lease_expires_at
         FROM event_handlers eh
         INNER JOIN events e ON e.id = eh.event_id
         WHERE eh.delivery_key = ?
           AND eh.status IN ('pending', 'retry', 'running')
         ORDER BY e.rowid
         LIMIT 1`,
      )
      .get(subscriber.deliveryKey) as
      | {
          id: string;
          event_order: number;
          status: 'pending' | 'retry' | 'running';
          retry_at: string | null;
          lease_expires_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const eligible =
      row.status === 'pending' ||
      (row.status === 'retry' && (row.retry_at === null || row.retry_at <= nowIso)) ||
      (row.status === 'running' && row.lease_expires_at !== null && row.lease_expires_at <= nowIso);
    return eligible ? { id: row.id, eventOrder: row.event_order } : null;
  }

  async markDelivered(delivery: ClaimedDurableDelivery, now = new Date()): Promise<void> {
    await this.transactionRunner.runImmediateQueued(() => {
      this.rawClient
        .prepare(
          `UPDATE event_handlers
           SET status = 'delivered', lease_owner = NULL, lease_expires_at = NULL,
               retry_at = NULL, ended_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(now.toISOString(), delivery.deliveryId, delivery.leaseOwner);
    });
  }

  async markRetry(delivery: ClaimedDurableDelivery, now = new Date()): Promise<void> {
    const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, delivery.attempts - 1));
    const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
    await this.transactionRunner.runImmediateQueued(() => {
      this.rawClient
        .prepare(
          `UPDATE event_handlers
           SET status = 'retry', retry_at = ?, lease_owner = NULL, lease_expires_at = NULL,
               detail = ?, ended_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          retryAt,
          JSON.stringify({ error: 'durable_handler_failed' }),
          now.toISOString(),
          delivery.deliveryId,
          delivery.leaseOwner,
        );
    });
  }

  private insertRows(event: PreparedEvent): void {
    this.rawClient
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.name, JSON.stringify(event.payload), event.requestId, event.publishedAt);

    const insertDelivery = this.rawClient.prepare(
      `INSERT INTO event_handlers
         (id, event_id, handler, status, delivery_key, attempts, retry_at,
          lease_owner, lease_expires_at, detail, started_at, ended_at)
       VALUES (?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL, NULL, ?, NULL)`,
    );
    for (const deliveryKey of this.registry.deliveryKeysFor(event.name)) {
      insertDelivery.run(randomUUID(), event.id, deliveryKey, deliveryKey, event.publishedAt);
    }
  }
}
