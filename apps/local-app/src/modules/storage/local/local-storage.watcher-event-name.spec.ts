import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from './local-storage.service';

describe('LocalStorageService - Watcher Shared Event Name', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;

  beforeAll(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    const migrationsFolder = join(__dirname, '../../../../drizzle');
    migrate(db, { migrationsFolder });
    service = new LocalStorageService(db);
  });

  afterAll(() => {
    sqlite.close();
  });

  it('allows creating multiple watchers with the same eventName in one project', async () => {
    const project = await service.createProject({
      name: 'Shared Event Watcher Project',
      rootPath: '/tmp/shared-event-watchers',
      isTemplate: false,
    });

    const first = await service.createWatcher({
      projectId: project.id,
      name: 'Watcher One',
      description: null,
      enabled: false,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 5000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'first' },
      cooldownMs: 60000,
      cooldownMode: 'time',
      eventName: 'watcher.conversation.compact_request',
    });

    const second = await service.createWatcher({
      projectId: project.id,
      name: 'Watcher Two',
      description: null,
      enabled: false,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 5000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'second' },
      cooldownMs: 60000,
      cooldownMode: 'time',
      eventName: 'watcher.conversation.compact_request',
    });

    const watchers = await service.listWatchers(project.id);
    const sameEvent = watchers.filter(
      (watcher) => watcher.eventName === 'watcher.conversation.compact_request',
    );

    expect(first.id).not.toBe(second.id);
    expect(sameEvent).toHaveLength(2);
  });
});
