import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { EventName, EventPayload } from '../catalog';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { CommittedEventStore } from './committed-event.store';
import { DurableEventRegistryService, type PreparedEvent } from './durable-event-registry.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

// Layer: backend integration. These assertions need the real SQLite transaction,
// foreign-key, partial-index, and rollback behavior that mocks cannot reproduce.
describe('durable factual mutation events', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let storage: LocalStorageService;
  let registry: DurableEventRegistryService;
  let secretDirectory: string;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    registry = new DurableEventRegistryService();
    registry.register({
      deliveryKey: 'managed-subtask-sync',
      eventNames: [
        'epic.created',
        'epic.updated',
        'epic.deleted',
        'integration.connection.created',
        'integration.connection.updated',
        'integration.connection.deleted',
      ],
      handle: async () => undefined,
    });
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-durable-events-'));
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'durable-event-test:test-user',
      }),
      new CommittedEventStore(db, registry),
    );
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  function prepared<TName extends EventName>(
    name: TName,
    payload: EventPayload<TName>,
    id = randomUUID(),
  ): PreparedEvent<TName> {
    return {
      id,
      name,
      payload,
      requestId: null,
      publishedAt: new Date().toISOString(),
    };
  }

  function deliveryRows(): Array<{
    name: string;
    status: string;
    delivery_key: string | null;
    attempts: number;
  }> {
    return sqlite
      .prepare(
        `SELECT e.name, eh.status, eh.delivery_key, eh.attempts
         FROM event_handlers eh
         INNER JOIN events e ON e.id = eh.event_id
         ORDER BY e.published_at, e.id`,
      )
      .all() as Array<{
      name: string;
      status: string;
      delivery_key: string | null;
      attempts: number;
    }>;
  }

  it('commits create and description-only update facts with pending delivery', async () => {
    const project = await storage.createProject({
      name: 'Facts',
      rootPath: '/tmp/durable-facts',
      description: null,
    });
    const statusId = (await storage.listStatuses(project.id)).items[0]!.id;
    const epic = await storage.createEpic(
      {
        projectId: project.id,
        statusId,
        title: 'Parent',
        description: null,
      },
      (created) =>
        prepared('epic.created', {
          epicId: created.id,
          projectId: created.projectId,
          title: created.title,
          statusId: created.statusId,
          parentId: null,
          actor: null,
        }),
    );

    const updated = await storage.updateEpic(
      epic.id,
      { description: 'Durable description' },
      epic.version,
      (current, previous) =>
        prepared('epic.updated', {
          epicId: current.id,
          projectId: current.projectId,
          parentId: current.parentId,
          version: current.version,
          epicTitle: current.title,
          actor: null,
          changes: {
            description: {
              previous: previous.description,
              current: current.description,
            },
          },
        }),
    );

    expect(updated.description).toBe('Durable description');
    expect(deliveryRows()).toEqual([
      expect.objectContaining({
        name: 'epic.created',
        status: 'pending',
        delivery_key: 'managed-subtask-sync',
        attempts: 0,
      }),
      expect.objectContaining({
        name: 'epic.updated',
        status: 'pending',
        delivery_key: 'managed-subtask-sync',
        attempts: 0,
      }),
    ]);
    const updatePayload = JSON.parse(
      (
        sqlite.prepare("SELECT payload_json FROM events WHERE name = 'epic.updated'").get() as {
          payload_json: string;
        }
      ).payload_json,
    ) as Record<string, unknown>;
    expect(updatePayload).toMatchObject({
      changes: { description: { previous: null, current: 'Durable description' } },
    });
  });

  it('rolls back a versioned mutation when its factual append fails', async () => {
    const project = await storage.createProject({
      name: 'Rollback',
      rootPath: '/tmp/durable-rollback',
      description: null,
    });
    const statusId = (await storage.listStatuses(project.id)).items[0]!.id;
    const epic = await storage.createEpic({
      projectId: project.id,
      statusId,
      title: 'Unchanged',
      description: null,
    });
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('duplicate-event', 'epic.updated', '{}', NULL, ?)`,
      )
      .run(new Date().toISOString());

    await expect(
      storage.updateEpic(epic.id, { description: 'must roll back' }, epic.version, (current) =>
        prepared(
          'epic.updated',
          {
            epicId: current.id,
            projectId: current.projectId,
            parentId: current.parentId,
            version: current.version,
            epicTitle: current.title,
            changes: { description: { previous: null, current: current.description } },
          },
          'duplicate-event',
        ),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    expect(await storage.getEpic(epic.id)).toMatchObject({
      description: null,
      version: epic.version,
    });
  });

  it('records every recursive delete before removing the Epic rows', async () => {
    const project = await storage.createProject({
      name: 'Recursive delete',
      rootPath: '/tmp/durable-delete',
      description: null,
    });
    const statusId = (await storage.listStatuses(project.id)).items[0]!.id;
    const parent = await storage.createEpic({ projectId: project.id, statusId, title: 'Parent' });
    const child = await storage.createEpic({
      projectId: project.id,
      statusId,
      title: 'Child',
      parentId: parent.id,
    });

    await storage.deleteEpic(parent.id, (deleted) =>
      prepared('epic.deleted', {
        epicId: deleted.id,
        projectId: deleted.projectId,
        title: deleted.title,
        parentId: deleted.parentId,
        actor: null,
      }),
    );

    expect(
      sqlite.prepare('SELECT id FROM epics WHERE id IN (?, ?)').all(parent.id, child.id),
    ).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT payload_json FROM events WHERE name = 'epic.deleted'")
        .all()
        .map((row) => JSON.parse((row as { payload_json: string }).payload_json).epicId)
        .sort(),
    ).toEqual([child.id, parent.id].sort());
    expect(deliveryRows().filter((row) => row.name === 'epic.deleted')).toHaveLength(2);
  });

  it('commits factual connection create, update, and delete events with their writes', async () => {
    const eventFactory = (
      current: Awaited<ReturnType<LocalStorageService['replaceIntegrationConnection']>>,
      previous: Awaited<ReturnType<LocalStorageService['getIntegrationConnection']>>,
    ) =>
      previous
        ? prepared('integration.connection.updated', {
            connectionId: current.id,
            provider: current.provider,
            previousGeneration: previous.generation,
            generation: current.generation,
            previousSubtaskSyncEnabled: previous.subtaskSyncEnabled,
            subtaskSyncEnabled: current.subtaskSyncEnabled,
            previousSyncSettingRevision: previous.syncSettingRevision,
            syncSettingRevision: current.syncSettingRevision,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
          })
        : prepared('integration.connection.created', {
            connectionId: current.id,
            provider: current.provider,
            generation: current.generation,
            subtaskSyncEnabled: current.subtaskSyncEnabled,
            syncSettingRevision: current.syncSettingRevision,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
          });

    await storage.replaceIntegrationConnection(
      { provider: 'clickup', credentials: { provider: 'clickup', token: 'first-token' } },
      async () => undefined,
      eventFactory,
    );
    const updated = await storage.replaceIntegrationConnection(
      { provider: 'clickup', credentials: { provider: 'clickup', token: 'second-token' } },
      async () => undefined,
      eventFactory,
    );
    await storage.disconnectIntegrationConnection('clickup', (deleted) =>
      prepared('integration.connection.deleted', {
        connectionId: deleted.id,
        provider: deleted.provider,
        generation: deleted.generation,
        subtaskSyncEnabled: deleted.subtaskSyncEnabled,
        syncSettingRevision: deleted.syncSettingRevision,
        deletedAt: new Date().toISOString(),
      }),
    );

    expect(updated.generation).toBe(2);
    expect(await storage.getIntegrationConnection('clickup')).toBeNull();
    expect(
      deliveryRows()
        .map((row) => row.name)
        .sort(),
    ).toEqual(
      [
        'integration.connection.created',
        'integration.connection.updated',
        'integration.connection.deleted',
      ].sort(),
    );
  });
});
