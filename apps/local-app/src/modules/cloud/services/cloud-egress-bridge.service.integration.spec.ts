// Backend integration: real SQLite is the cheapest reliable proof of this persisted contract.
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { CloudEgressBridgeService } from './cloud-egress-bridge.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { EgressQueueService } from './egress-queue.service';
import { EventMapperService } from './event-mapper.service';
import { ProjectEgressConfigService } from './project-egress-config.service';
import { GUEST_SANDBOX_ROOT_PATH } from '../../guests/constants';

const mockEventMetadata = new Map<unknown, { id: string }>();

jest.mock('../../events/services/events.service', () => ({
  getEventMetadata: (payload: unknown) => mockEventMetadata.get(payload) ?? null,
}));

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';
const TS = '2026-07-31T00:00:00.000Z';

describe('CloudEgressBridgeService', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let bridge: CloudEgressBridgeService;
  let cloudSession: jest.Mocked<CloudSessionManagerService>;
  let egressQueue: jest.Mocked<EgressQueueService>;
  let projectConfig: ProjectEgressConfigService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    upsertSetting(DEFAULT_ENABLED_KEY, true);
    insertProject('p1');

    cloudSession = {
      getStatus: jest.fn().mockReturnValue({
        connected: true,
        userId: 'user-1',
        identityServiceUrl: 'http://localhost:3002',
      }),
    } as unknown as jest.Mocked<CloudSessionManagerService>;

    egressQueue = {
      enqueue: jest.fn(),
    } as unknown as jest.Mocked<EgressQueueService>;

    projectConfig = new ProjectEgressConfigService(db);

    bridge = new CloudEgressBridgeService(
      cloudSession,
      egressQueue,
      new EventMapperService(),
      projectConfig,
    );

    mockEventMetadata.clear();
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertProject(id: string, rootPath = `/tmp/${id}`): void {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, id, rootPath, TS, TS);
  }

  function upsertSetting(key: string, value: unknown): void {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), key, JSON.stringify(value), TS, TS);
  }

  function withMetadata<T extends object>(payload: T, eventId: string): T {
    mockEventMetadata.set(payload, { id: eventId });
    return payload;
  }

  it('should enqueue project events for a live project using the implicit enabled default', async () => {
    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.created');
    expect(enqueued.sourceEventId).toBe('evt-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should skip events when not connected', async () => {
    cloudSession.getStatus.mockReturnValue({
      connected: false,
      identityServiceUrl: 'http://localhost:3002',
    });

    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should skip events without metadata', async () => {
    const payload = { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null };

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should skip events for disabled projects', async () => {
    projectConfig.setEnabled('p1', false);

    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
      'evt-1',
    );

    await bridge.onEpicCreated(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should forward session.crashed (no projectId) when any project is enabled', async () => {
    const payload = withMetadata({ sessionId: 's1', sessionName: 'test' }, 'evt-2');

    await bridge.onSessionCrashed(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('session.crashed');
    expect(enqueued.projectId).toBeNull();
  });

  it('should forward a projectless event when an explicitly enabled Guest Sandbox is the only live row', async () => {
    sqlite.prepare('DELETE FROM projects').run();
    insertProject('guest-sandbox', GUEST_SANDBOX_ROOT_PATH);
    projectConfig.setEnabled('guest-sandbox', true);
    const payload = withMetadata({ sessionId: 's1', sessionName: 'test' }, 'evt-guest');

    await bridge.onSessionCrashed(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(egressQueue.enqueue.mock.calls[0][0].projectId).toBeNull();
  });

  it('should enqueue epic.deleted events with projectId', async () => {
    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Deleted Epic', parentId: null, actor: null },
      'evt-del-1',
    );

    await bridge.onEpicDeleted(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.deleted');
    expect(enqueued.sourceEventId).toBe('evt-del-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should enqueue epic.comment.created events with projectId', async () => {
    const payload = withMetadata(
      {
        commentId: 'c1',
        epicId: 'e1',
        projectId: 'p1',
        parentId: null,
        authorName: 'Coder',
        content: 'Looks good',
        actor: null,
      },
      'evt-comment-1',
    );

    await bridge.onEpicCommentCreated(payload);

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = egressQueue.enqueue.mock.calls[0][0];
    expect(enqueued.sourceEventType).toBe('epic.comment.created');
    expect(enqueued.sourceEventId).toBe('evt-comment-1');
    expect(enqueued.projectId).toBe('p1');
  });

  it('should skip session events when no project has notifications enabled', async () => {
    projectConfig.setEnabled('p1', false);

    const payload = withMetadata({ sessionId: 's1', sessionName: 'test' }, 'evt-2');

    await bridge.onSessionCrashed(payload);

    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should ignore an explicit stale override after its project row is deleted', async () => {
    projectConfig.setEnabled('p1', true);
    sqlite.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    const payload = withMetadata(
      { epicId: 'e1', projectId: 'p1', title: 'Deleted project event', statusId: null },
      'evt-stale',
    );

    await bridge.onEpicCreated(payload);

    expect(projectConfig.getAll()).toEqual({ p1: true });
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('should forward all 6 allowlisted event types', async () => {
    const events = [
      {
        method: 'onEpicCreated' as const,
        payload: { epicId: 'e1', projectId: 'p1', title: 'T', statusId: null },
      },
      {
        method: 'onEpicUpdated' as const,
        payload: {
          epicId: 'e1',
          projectId: 'p1',
          parentId: null,
          version: 1,
          epicTitle: 'T',
          changes: {},
        },
      },
      {
        method: 'onEpicDeleted' as const,
        payload: {
          epicId: 'e1',
          projectId: 'p1',
          title: 'Deleted',
          parentId: null,
          actor: null,
        },
      },
      {
        method: 'onEpicCommentCreated' as const,
        payload: {
          commentId: 'c1',
          epicId: 'e1',
          projectId: 'p1',
          parentId: null,
          authorName: 'Coder',
          content: 'hello',
          actor: null,
        },
      },
      { method: 'onSessionCrashed' as const, payload: { sessionId: 's1', sessionName: 'n' } },
      { method: 'onSessionStopped' as const, payload: { sessionId: 's1' } },
    ];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const payload = withMetadata(e.payload, `evt-${i}`);
      await (bridge[e.method] as (p: unknown) => Promise<void>)(payload);
    }

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(6);
  });
});
