import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictError } from '../../../common/errors/error-types';
import type {
  CreateExternalManagedSubtaskLink,
  Epic,
  ExternalManagedSubtaskLink,
  ExternalTaskLink,
  IntegrationConnection,
} from '../models/domain.models';
import { CommittedEventStore } from '../../events/services/committed-event.store';
import { DurableEventRegistryService } from '../../events/services/durable-event-registry.service';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

// Layer: backend integration. The ownership snapshots, cascade behavior,
// recognition join, and atomic multi-table transitions require real SQLite.
describe('LocalStorageService managed subtasks', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let storage: LocalStorageService;
  let secretDirectory: string;
  let connection: IntegrationConnection;
  let parent: Epic;
  let child: Epic;
  let parentSource: ExternalTaskLink;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    const registry = new DurableEventRegistryService();
    registry.register({
      deliveryKey: 'managed-subtask-sync',
      eventNames: ['integration.connection.updated'],
      handle: async () => undefined,
    });
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-managed-subtask-'));
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'managed-subtask-test:test-user',
      }),
      new CommittedEventStore(db, registry),
    );
    const project = await storage.createProject({
      name: 'Managed subtasks',
      rootPath: '/tmp/managed-subtasks',
      description: null,
    });
    const statusId = (await storage.listStatuses(project.id)).items[0]!.id;
    parent = await storage.createEpic({ projectId: project.id, statusId, title: 'Parent' });
    child = await storage.createEpic({
      projectId: project.id,
      statusId,
      title: 'Child',
      parentId: parent.id,
    });
    connection = await storage.replaceIntegrationConnection(
      {
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'test-token' },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    parentSource = await storage.createExternalTaskLink({
      epicId: parent.id,
      connectionId: connection.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'parent-task',
      sourceSnapshot: {
        remoteKey: 'PARENT-1',
        workAreaId: 'list-1',
      },
    });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  function projectionInput(
    overrides: Partial<CreateExternalManagedSubtaskLink> = {},
  ): CreateExternalManagedSubtaskLink {
    return {
      epicId: child.id,
      epicIdSnapshot: child.id,
      parentEpicIdSnapshot: parent.id,
      parentSourceLinkIdSnapshot: parentSource.id,
      connectionIdSnapshot: connection.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      workAreaRemoteId: 'list-1',
      parentRemoteTaskId: 'parent-task',
      connectionGeneration: connection.generation,
      syncSettingRevision: connection.syncSettingRevision,
      ownershipToken: 'ownership-token-1',
      desiredVersion: child.version,
      desiredFingerprint: 'desired-fingerprint-1',
      ...overrides,
    };
  }

  async function createProjection(
    overrides: Partial<CreateExternalManagedSubtaskLink> = {},
  ): Promise<ExternalManagedSubtaskLink> {
    return storage.createExternalManagedSubtaskLink(projectionInput(overrides));
  }

  it('defaults settings off, preserves omission, and increments revision only on transitions', async () => {
    const jira = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'first-token',
        },
      },
      async () => undefined,
    );
    expect(jira).toMatchObject({ subtaskSyncEnabled: false, syncSettingRevision: 1 });

    const preserved = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'second-token',
        },
      },
      async () => undefined,
    );
    expect(preserved).toMatchObject({
      generation: 2,
      subtaskSyncEnabled: false,
      syncSettingRevision: 1,
    });

    const enabled = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'third-token',
        },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    expect(enabled).toMatchObject({
      generation: 3,
      subtaskSyncEnabled: true,
      syncSettingRevision: 2,
    });
  });

  it('atomically persists a credential-free settings fact and pending delivery', async () => {
    const rawCredentialBefore = sqlite
      .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
      .get(connection.id);
    const eventId = randomUUID();

    const updated = await storage.updateIntegrationConnectionSyncSetting(
      'clickup',
      false,
      (current, previous) => ({
        id: eventId,
        name: 'integration.connection.updated',
        payload: {
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
        },
        requestId: null,
        publishedAt: new Date().toISOString(),
      }),
    );

    expect(updated).toMatchObject({
      generation: connection.generation,
      subtaskSyncEnabled: false,
      syncSettingRevision: connection.syncSettingRevision + 1,
    });
    expect(
      sqlite
        .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
        .get(connection.id),
    ).toEqual(rawCredentialBefore);
    expect(
      sqlite
        .prepare('SELECT status, delivery_key FROM event_handlers WHERE event_id = ?')
        .get(eventId),
    ).toEqual({ status: 'pending', delivery_key: 'managed-subtask-sync' });
  });

  it('rolls back credential and setting replacement when factual append fails after verification', async () => {
    const before = await storage.getIntegrationConnection('clickup');
    const credentialsBefore = await storage.getIntegrationConnectionCredentials('clickup');
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('duplicate-connection-event', 'integration.connection.updated', '{}', NULL, ?)`,
      )
      .run(new Date().toISOString());
    let verified = false;

    await expect(
      storage.replaceIntegrationConnection(
        {
          provider: 'clickup',
          credentials: { provider: 'clickup', token: 'must-roll-back' },
          subtaskSyncEnabled: false,
        },
        async () => {
          verified = true;
        },
        (current, previous) => {
          expect(verified).toBe(true);
          return {
            id: 'duplicate-connection-event',
            name: 'integration.connection.updated',
            payload: {
              connectionId: current.id,
              provider: current.provider,
              previousGeneration: previous!.generation,
              generation: current.generation,
              previousSubtaskSyncEnabled: previous!.subtaskSyncEnabled,
              subtaskSyncEnabled: current.subtaskSyncEnabled,
              previousSyncSettingRevision: previous!.syncSettingRevision,
              syncSettingRevision: current.syncSettingRevision,
              createdAt: current.createdAt,
              updatedAt: current.updatedAt,
            },
            requestId: null,
            publishedAt: new Date().toISOString(),
          };
        },
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    expect(verified).toBe(true);
    expect(await storage.getIntegrationConnection('clickup')).toEqual(before);
    expect(await storage.getIntegrationConnectionCredentials('clickup')).toEqual(credentialsBefore);
  });

  it('keeps immutable ownership and parent proof after root cascade deletion', async () => {
    const managed = await createProjection();

    await storage.deleteEpic(parent.id);

    expect(await storage.getExternalManagedSubtaskLink(managed.id)).toMatchObject({
      epicId: null,
      epicIdSnapshot: child.id,
      parentEpicIdSnapshot: parent.id,
      parentSourceLinkIdSnapshot: parentSource.id,
      connectionIdSnapshot: connection.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      workAreaRemoteId: 'list-1',
      parentRemoteTaskId: 'parent-task',
      ownershipToken: 'ownership-token-1',
    });
  });

  it('enforces one projection per Epic and parent source snapshot', async () => {
    await createProjection();

    await expect(
      createProjection({ ownershipToken: 'other-token' }),
    ).rejects.toMatchObject<ConflictError>({
      code: 'conflict',
      details: { epicIdSnapshot: child.id, parentSourceLinkIdSnapshot: parentSource.id },
    });
  });

  it('accepts only bounded error codes in managed state', async () => {
    const managed = await createProjection();

    await expect(
      storage.updateExternalManagedSubtaskLink(managed.id, {
        safeErrorCode: 'token=plaintext-secret',
      }),
    ).rejects.toThrow('bounded error code');
    await expect(
      storage.updateExternalManagedSubtaskLink(managed.id, {
        safeErrorCode: 'provider_timeout',
      }),
    ).resolves.toMatchObject({ safeErrorCode: 'provider_timeout' });
  });

  it('recognizes only an exact confirmed managed tuple and leaves imports unmanaged', async () => {
    const managed = await createProjection();
    await storage.createExternalTaskLink({
      epicId: child.id,
      connectionId: connection.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'imported-task',
      sourceSnapshot: { remoteKey: 'IMPORTED-1', workAreaId: 'list-1' },
    });
    await expect(
      storage.findRecognizedManagedSubtask(child.id, 'clickup', 'workspace-1', 'imported-task'),
    ).resolves.toBeNull();

    await expect(
      storage.confirmExternalManagedSubtaskLink({
        managedLinkId: managed.id,
        remoteTaskId: 'managed-task',
        remoteKey: 'MANAGED-1',
        confirmedVersion: child.version,
        confirmedFingerprint: 'confirmed-fingerprint-1',
        sourceSnapshot: {
          ownershipToken: 'wrong-token',
          parentRemoteTaskId: 'parent-task',
          workAreaRemoteId: 'list-1',
        },
      }),
    ).rejects.toMatchObject<ConflictError>({ details: { reason: 'ownership_mismatch' } });

    const confirmed = await storage.confirmExternalManagedSubtaskLink({
      managedLinkId: managed.id,
      remoteTaskId: 'managed-task',
      remoteKey: 'MANAGED-1',
      confirmedVersion: child.version,
      confirmedFingerprint: 'confirmed-fingerprint-1',
      sourceSnapshot: {
        ownershipToken: 'ownership-token-1',
        parentRemoteTaskId: 'parent-task',
        workAreaRemoteId: 'list-1',
        remoteKey: 'MANAGED-1',
      },
    });
    expect(confirmed.managedLink).toMatchObject({
      operationPhase: 'confirmed',
      remoteTaskId: 'managed-task',
    });
    await expect(
      storage.findRecognizedManagedSubtask(child.id, 'clickup', 'workspace-1', 'managed-task'),
    ).resolves.toMatchObject({ id: managed.id });
  });

  it('rolls back managed confirmation when ordinary recognition insertion fails', async () => {
    const managed = await createProjection();
    sqlite.exec(`
      CREATE TRIGGER fail_managed_recognition_insert
      BEFORE INSERT ON external_task_links
      WHEN NEW.remote_task_id = 'managed-task'
      BEGIN SELECT RAISE(ABORT, 'recognition insert failed'); END;
    `);

    await expect(
      storage.confirmExternalManagedSubtaskLink({
        managedLinkId: managed.id,
        remoteTaskId: 'managed-task',
        remoteKey: 'MANAGED-1',
        confirmedVersion: child.version,
        confirmedFingerprint: 'confirmed-fingerprint-1',
        sourceSnapshot: {
          ownershipToken: 'ownership-token-1',
          parentRemoteTaskId: 'parent-task',
          workAreaRemoteId: 'list-1',
        },
      }),
    ).rejects.toThrow('recognition insert failed');
    expect(await storage.getExternalManagedSubtaskLink(managed.id)).toMatchObject({
      operationPhase: 'pre_dispatch',
      remoteTaskId: null,
      confirmedVersion: null,
    });
  });

  it('atomically preserves an actual confirmed fingerprint distinct from desired state', async () => {
    const managed = await createProjection();
    const confirmed = await storage.confirmExternalManagedSubtaskLink({
      managedLinkId: managed.id,
      remoteTaskId: 'adopted-task',
      remoteKey: 'ADOPTED-1',
      confirmedVersion: child.version,
      confirmedFingerprint: 'actual-remote-fingerprint',
      sourceSnapshot: {
        ownershipToken: 'ownership-token-1',
        parentRemoteTaskId: 'parent-task',
        workAreaRemoteId: 'list-1',
        title: 'Remote title',
        description: 'Remote description',
      },
    });

    expect(confirmed.managedLink).toMatchObject({
      desiredFingerprint: 'desired-fingerprint-1',
      confirmedFingerprint: 'actual-remote-fingerprint',
      operationPhase: 'confirmed',
      remoteTaskId: 'adopted-task',
    });
    expect(confirmed.externalTaskLink.sourceSnapshot).toMatchObject({
      title: 'Remote title',
      description: 'Remote description',
      managedProjectionId: managed.id,
      ownershipToken: 'ownership-token-1',
    });
  });

  it('removes exact recognition and managed state atomically, accepting a cascaded link', async () => {
    const managed = await createProjection();
    await storage.confirmExternalManagedSubtaskLink({
      managedLinkId: managed.id,
      remoteTaskId: 'managed-task',
      remoteKey: 'MANAGED-1',
      confirmedVersion: child.version,
      confirmedFingerprint: 'confirmed-fingerprint-1',
      sourceSnapshot: {
        ownershipToken: 'ownership-token-1',
        parentRemoteTaskId: 'parent-task',
        workAreaRemoteId: 'list-1',
      },
    });
    await storage.deleteEpic(child.id);

    await expect(storage.removeExternalManagedSubtaskLink(managed.id)).resolves.toBe(true);
    await expect(storage.removeExternalManagedSubtaskLink(managed.id)).resolves.toBe(false);
  });

  it('requires orphan-risk acknowledgement for replacement and disconnect', async () => {
    const managed = await createProjection({ operationPhase: 'dispatch_admitted' });

    await expect(
      storage.replaceIntegrationConnection(
        {
          provider: 'clickup',
          credentials: { provider: 'clickup', token: 'replacement-token' },
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject<ConflictError>({
      details: { reason: 'orphan_risk_ack_required', affectedCount: 1 },
    });
    expect((await storage.getIntegrationConnection('clickup'))?.generation).toBe(
      connection.generation,
    );

    connection = await storage.replaceIntegrationConnection(
      {
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'replacement-token' },
        acknowledgeOrphanRisk: true,
      },
      async () => undefined,
    );
    expect(await storage.getExternalManagedSubtaskLink(managed.id)).toMatchObject({
      tombstoneState: 'orphan_risk',
      safeErrorCode: 'connection_changed_with_unresolved_outcome',
    });

    await storage.updateExternalManagedSubtaskLink(managed.id, {
      operationPhase: 'outcome_unknown',
    });
    await expect(
      storage.disconnectIntegrationConnection('clickup'),
    ).rejects.toMatchObject<ConflictError>({ details: { reason: 'orphan_risk_ack_required' } });
    await expect(
      storage.disconnectIntegrationConnection('clickup', undefined, {
        acknowledgeOrphanRisk: true,
      }),
    ).resolves.toBe(true);
  });
});
