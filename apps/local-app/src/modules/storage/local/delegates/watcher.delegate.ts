import type { CreateWatcher, UpdateWatcher, Watcher } from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('WatcherStorageDelegate');

export class WatcherStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listWatchers(projectId: string): Promise<Watcher[]> {
    const { terminalWatchers } = await import('../../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.projectId, projectId))
      .orderBy(desc(terminalWatchers.createdAt));

    const mappedWatchers = rows.map(
      (row) =>
        ({
          ...row,
          condition: row.condition as Watcher['condition'],
        }) as Watcher,
    );
    return Promise.all(mappedWatchers.map((watcher) => this.convertLegacyIdleWatcher(watcher)));
  }

  async getWatcher(id: string): Promise<Watcher | null> {
    const { terminalWatchers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.id, id))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    const watcher = {
      ...result[0],
      condition: result[0].condition as Watcher['condition'],
    } as Watcher;
    return this.convertLegacyIdleWatcher(watcher);
  }

  async createWatcher(data: CreateWatcher): Promise<Watcher> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { terminalWatchers } = await import('../../db/schema');

    const watcher: Watcher = {
      id: randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(terminalWatchers).values({
      id: watcher.id,
      projectId: watcher.projectId,
      name: watcher.name,
      description: watcher.description,
      enabled: watcher.enabled,
      scope: watcher.scope,
      scopeFilterId: watcher.scopeFilterId,
      pollIntervalMs: watcher.pollIntervalMs,
      viewportLines: watcher.viewportLines,
      idleAfterSeconds: watcher.idleAfterSeconds,
      condition: watcher.condition,
      cooldownMs: watcher.cooldownMs,
      cooldownMode: watcher.cooldownMode,
      eventName: watcher.eventName,
      createdAt: watcher.createdAt,
      updatedAt: watcher.updatedAt,
    });

    return watcher;
  }

  async updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher> {
    const { terminalWatchers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const existing = await this.getWatcher(id);
    if (!existing) {
      throw new NotFoundError('Watcher', id);
    }

    await this.db
      .update(terminalWatchers)
      .set({ ...data, updatedAt: now })
      .where(eq(terminalWatchers.id, id));

    const updated = await this.getWatcher(id);
    if (!updated) {
      throw new NotFoundError('Watcher', id);
    }
    return updated;
  }

  async deleteWatcher(id: string): Promise<void> {
    const { terminalWatchers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(terminalWatchers).where(eq(terminalWatchers.id, id));
  }

  async listEnabledWatchers(): Promise<Watcher[]> {
    const { terminalWatchers } = await import('../../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(terminalWatchers)
      .where(eq(terminalWatchers.enabled, true))
      .orderBy(desc(terminalWatchers.createdAt));

    const mappedWatchers = rows.map(
      (row) =>
        ({
          ...row,
          condition: row.condition as Watcher['condition'],
        }) as Watcher,
    );
    return Promise.all(mappedWatchers.map((watcher) => this.convertLegacyIdleWatcher(watcher)));
  }

  private async convertLegacyIdleWatcher(watcher: Watcher): Promise<Watcher> {
    const rawCondition = watcher.condition as unknown as {
      type?: string;
      pattern?: string;
      flags?: string;
    };
    if (rawCondition?.type !== 'idle') {
      return watcher;
    }

    const parsedIdleAfterSeconds = Number.parseInt(rawCondition.pattern ?? '', 10);
    const idleAfterSeconds =
      Number.isFinite(parsedIdleAfterSeconds) && parsedIdleAfterSeconds > 0
        ? parsedIdleAfterSeconds
        : 0;
    const convertedCondition: Watcher['condition'] = { type: 'regex', pattern: '.*' };
    const convertedWatcher: Watcher = {
      ...watcher,
      idleAfterSeconds,
      condition: convertedCondition,
    };

    logger.warn(
      {
        watcherId: watcher.id,
        projectId: watcher.projectId,
        legacyCondition: rawCondition,
        idleAfterSeconds,
      },
      'Converted legacy idle watcher condition to idleAfterSeconds',
    );

    try {
      const { terminalWatchers } = await import('../../db/schema');
      const { eq } = await import('drizzle-orm');
      await this.db
        .update(terminalWatchers)
        .set({
          idleAfterSeconds,
          condition: convertedCondition,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(terminalWatchers.id, watcher.id));
    } catch (error) {
      logger.warn(
        { watcherId: watcher.id, error: String(error) },
        'Failed to persist converted legacy idle watcher',
      );
    }

    return convertedWatcher;
  }
}
