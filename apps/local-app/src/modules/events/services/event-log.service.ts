import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { createLogger } from '../../../common/logging/logger';
import type {
  EventHandlerLogDto,
  EventLogDto,
  EventLogListFilters,
  EventLogListResult,
} from '../dtos/event-log.dto';
import { EventsStreamService } from './events-stream.service';

const logger = createLogger('EventLogService');
const WORKTREE_ACTIVITY_EVENT_NAME = 'orchestrator.worktree.activity';
const WORKTREE_ACTIVITY_RETENTION_DAYS = 30;
const WORKTREE_ACTIVITY_CLEANUP_INTERVAL_MS = 86_400_000;

function safeStringify(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    logger.warn({ error }, 'Failed to serialize value for event log');
    return JSON.stringify({ error: 'unserializable', message: String(error) });
  }
}

function safeParse(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn({ error, value }, 'Failed to parse stored JSON; returning raw string');
    return value;
  }
}

@Injectable()
export class EventLogService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly eventsStreamService: EventsStreamService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    await this.cleanupOldWorktreeActivityEvents().catch((error) => {
      logger.warn({ error }, 'Failed initial cleanup of worktree activity events');
    });

    this.cleanupTimer = setInterval(() => {
      this.cleanupOldWorktreeActivityEvents().catch((error) => {
        logger.warn({ error }, 'Failed scheduled cleanup of worktree activity events');
      });
    }, WORKTREE_ACTIVITY_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  async cleanupOldWorktreeActivityEvents(params?: { retentionDays?: number }): Promise<void> {
    const retentionDaysRaw = params?.retentionDays ?? WORKTREE_ACTIVITY_RETENTION_DAYS;
    const retentionDays = Number.isFinite(retentionDaysRaw)
      ? Math.max(1, Math.trunc(retentionDaysRaw))
      : WORKTREE_ACTIVITY_RETENTION_DAYS;
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

    const { events } = await import('../../storage/db/schema');
    const { and, eq, lt } = await import('drizzle-orm');

    await this.db
      .delete(events)
      .where(and(eq(events.name, WORKTREE_ACTIVITY_EVENT_NAME), lt(events.publishedAt, cutoffIso)));
  }

  async recordPublished(params: {
    name: string;
    payload: unknown;
    requestId?: string | null;
    publishedAt?: string;
    id?: string;
  }): Promise<{ id: string; publishedAt: string }> {
    const { events } = await import('../../storage/db/schema');
    const eventId = params.id ?? randomUUID();
    const publishedAt = params.publishedAt ?? new Date().toISOString();

    await this.db.insert(events).values({
      id: eventId,
      name: params.name,
      payloadJson: safeStringify(params.payload) ?? 'null',
      requestId: params.requestId ?? null,
      publishedAt,
    });

    this.eventsStreamService.broadcastEventCreated({
      id: eventId,
      name: params.name,
      publishedAt,
      requestId: params.requestId ?? null,
      payload: params.payload,
    });

    logger.debug({ eventId, name: params.name }, 'Recorded published event');
    return { id: eventId, publishedAt };
  }

  async recordHandledOk(params: {
    eventId: string;
    handler: string;
    detail?: unknown;
    startedAt?: string;
    endedAt?: string;
  }): Promise<{ id: string }> {
    return this.recordHandler({
      ...params,
      status: 'success',
    });
  }

  async recordHandledFail(params: {
    eventId: string;
    handler: string;
    detail?: unknown;
    startedAt?: string;
    endedAt?: string;
  }): Promise<{ id: string }> {
    return this.recordHandler({
      ...params,
      status: 'failure',
    });
  }

  private async recordHandler(params: {
    eventId: string;
    handler: string;
    status: 'success' | 'failure';
    detail?: unknown;
    startedAt?: string;
    endedAt?: string;
  }): Promise<{ id: string }> {
    const { eventHandlers } = await import('../../storage/db/schema');
    const handlerId = randomUUID();
    const nowIso = new Date().toISOString();
    const startedAt = params.startedAt ?? nowIso;
    const endedAt = params.endedAt ?? nowIso;

    await this.db.insert(eventHandlers).values({
      id: handlerId,
      eventId: params.eventId,
      handler: params.handler,
      status: params.status,
      detail: safeStringify(params.detail),
      startedAt,
      endedAt,
    });

    logger.debug(
      { handlerId, eventId: params.eventId, handler: params.handler, status: params.status },
      'Recorded event handler entry',
    );

    this.eventsStreamService.broadcastHandlerResult({
      id: handlerId,
      eventId: params.eventId,
      handler: params.handler,
      status: params.status,
      detail: params.detail ?? null,
      startedAt,
      endedAt,
    });
    return { id: handlerId };
  }

  async listEvents(filters: EventLogListFilters): Promise<EventLogListResult> {
    const { events, eventHandlers } = await import('../../storage/db/schema');
    const { and, eq, gte, lte, inArray, sql, desc } = await import('drizzle-orm');
    const { safeJsonFieldEquals } = await import('../../storage/db/sqlite-json');

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const eventConditions: SQL<unknown>[] = [];
    if (filters.name) {
      eventConditions.push(eq(events.name, filters.name));
    }
    if (filters.ownerProjectId) {
      eventConditions.push(
        safeJsonFieldEquals(events.payloadJson, '$.ownerProjectId', filters.ownerProjectId),
      );
    }
    if (filters.from) {
      eventConditions.push(gte(events.publishedAt, filters.from));
    }
    if (filters.to) {
      eventConditions.push(lte(events.publishedAt, filters.to));
    }

    let handlerEventIds: string[] | undefined;
    if (filters.handler || filters.status) {
      const handlerConditions: SQL<unknown>[] = [];
      if (filters.handler) {
        handlerConditions.push(eq(eventHandlers.handler, filters.handler));
      }
      if (filters.status) {
        handlerConditions.push(eq(eventHandlers.status, filters.status));
      }
      const handlerWhere =
        handlerConditions.length > 1
          ? and(...handlerConditions)
          : (handlerConditions[0] ?? undefined);

      const handlerQuery = this.db
        .select({ eventId: eventHandlers.eventId })
        .from(eventHandlers)
        .groupBy(eventHandlers.eventId);
      if (handlerWhere) {
        handlerQuery.where(handlerWhere);
      }
      const handlerRows = await handlerQuery;

      handlerEventIds = handlerRows.map((row) => row.eventId);
      if (!handlerEventIds.length) {
        return {
          items: [],
          total: 0,
          limit,
          offset,
        };
      }
    }

    let whereClause =
      eventConditions.length > 1 ? and(...eventConditions) : (eventConditions[0] ?? undefined);

    if (handlerEventIds) {
      whereClause = whereClause
        ? and(whereClause, inArray(events.id, handlerEventIds))
        : inArray(events.id, handlerEventIds);
    }

    const totalQuery = this.db.select({ count: sql<number>`count(*)` }).from(events);
    if (whereClause) {
      totalQuery.where(whereClause);
    }
    const totalResult = await totalQuery;
    const total = Number(totalResult[0]?.count ?? 0);

    const eventsQuery = this.db
      .select({
        id: events.id,
        name: events.name,
        payloadJson: events.payloadJson,
        requestId: events.requestId,
        publishedAt: events.publishedAt,
      })
      .from(events);
    if (whereClause) {
      eventsQuery.where(whereClause);
    }
    const eventRows = await eventsQuery
      .orderBy(desc(events.publishedAt))
      .limit(limit)
      .offset(offset);

    const eventIds = eventRows.map((row) => row.id);
    const handlerRows: {
      id: string;
      eventId: string;
      handler: string;
      status: string;
      detail: string | null;
      startedAt: string;
      endedAt: string | null;
    }[] =
      eventIds.length > 0
        ? await this.db
            .select({
              id: eventHandlers.id,
              eventId: eventHandlers.eventId,
              handler: eventHandlers.handler,
              status: eventHandlers.status,
              detail: eventHandlers.detail,
              startedAt: eventHandlers.startedAt,
              endedAt: eventHandlers.endedAt,
            })
            .from(eventHandlers)
            .where(inArray(eventHandlers.eventId, eventIds))
            .orderBy(eventHandlers.startedAt)
        : [];

    const handlersByEvent = handlerRows.reduce<Record<string, EventHandlerLogDto[]>>((acc, row) => {
      const existing = acc[row.eventId] ?? [];
      existing.push({
        id: row.id,
        eventId: row.eventId,
        handler: row.handler,
        status: row.status as 'success' | 'failure',
        detail: safeParse(row.detail),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      });
      acc[row.eventId] = existing;
      return acc;
    }, {});

    const items: EventLogDto[] = eventRows.map((row) => ({
      id: row.id,
      name: row.name,
      payload: safeParse(row.payloadJson),
      requestId: row.requestId ?? null,
      publishedAt: row.publishedAt,
      handlers: handlersByEvent[row.id] ?? [],
    }));

    return {
      items,
      total,
      limit,
      offset,
    };
  }
}
