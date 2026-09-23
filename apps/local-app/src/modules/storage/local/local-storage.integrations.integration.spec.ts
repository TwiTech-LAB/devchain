import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { Epic } from '../models/domain.models';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('LocalStorageService integrations', () => {
  let sqlite: Database.Database;
  let service: LocalStorageService;
  let secretDirectory: string;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-integration-storage-'));
    service = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'test-host:test-user',
      }),
    );
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  async function seedEpic(): Promise<Epic> {
    const project = await service.createProject({
      name: 'Integration project',
      description: null,
      rootPath: '/tmp/integration-project',
    });
    const statuses = await service.listStatuses(project.id);
    return service.createEpic({
      projectId: project.id,
      title: 'Imported source',
      statusId: statuses.items[0].id,
    });
  }

  async function seedProject(name: string, rootPath: string): Promise<string> {
    return (
      await service.createProject({
        name,
        description: null,
        rootPath,
      })
    ).id;
  }

  it('returns safe connection projections while storing and reading credentials explicitly', async () => {
    const verify = jest.fn().mockResolvedValue(undefined);
    const credentials = {
      provider: 'jira' as const,
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'jira-token',
    };
    const projectId = await seedProject('Jira project', '/tmp/jira-project');

    const connection = await service.replaceIntegrationConnection(
      { projectId, provider: 'jira', credentials },
      verify,
    );

    expect(verify).toHaveBeenCalledWith(credentials);
    expect(connection).toEqual({
      id: expect.any(String),
      projectId,
      provider: 'jira',
      legacySourceConnectionId: null,
      generation: 1,
      subtaskSyncEnabled: false,
      syncSettingRevision: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await service.getIntegrationConnection({ projectId, provider: 'jira' })).toEqual(
      connection,
    );
    expect(await service.getIntegrationConnectionById(connection.id)).toEqual(connection);
    expect(await service.listIntegrationConnections()).toEqual([connection]);
    expect(await service.listIntegrationConnections(projectId)).toEqual([connection]);
    expect(
      await service.getIntegrationConnectionCredentials({ projectId, provider: 'jira' }),
    ).toEqual(credentials);
    expect(await service.getIntegrationConnectionCredentialsById(connection.id)).toEqual(
      credentials,
    );

    const raw = sqlite
      .prepare(
        `SELECT credential_ciphertext
         FROM integration_connections WHERE provider = 'jira'`,
      )
      .get() as { credential_ciphertext: string };
    expect(raw.credential_ciphertext).not.toContain(credentials.email);
    expect(raw.credential_ciphertext).not.toContain(credentials.token);
    expect(JSON.stringify(connection)).not.toContain(credentials.email);
    expect(JSON.stringify(connection)).not.toContain(credentials.token);
  });

  it('validates before mutation and updates the same row with a monotonic generation', async () => {
    const projectId = await seedProject('ClickUp project', '/tmp/clickup-project');
    const original = await service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'original-token' },
      },
      async () => undefined,
    );
    const originalRaw = sqlite
      .prepare('SELECT * FROM integration_connections WHERE id = ?')
      .get(original.id);

    await expect(
      service.replaceIntegrationConnection(
        {
          projectId,
          provider: 'clickup',
          credentials: { provider: 'clickup', token: 'invalid-token' },
        },
        async () => {
          throw new ValidationError('Credential validation failed.');
        },
      ),
    ).rejects.toThrow(ValidationError);
    expect(
      sqlite.prepare('SELECT * FROM integration_connections WHERE id = ?').get(original.id),
    ).toEqual(originalRaw);
    expect(
      await service.getIntegrationConnectionCredentials({ projectId, provider: 'clickup' }),
    ).toEqual({
      provider: 'clickup',
      token: 'original-token',
    });

    const replaced = await service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'replacement-token' },
      },
      async () => undefined,
    );
    expect(replaced.id).toBe(original.id);
    expect(replaced.generation).toBe(2);
    expect(
      await service.getIntegrationConnectionCredentials({ connectionId: original.id }),
    ).toEqual({
      provider: 'clickup',
      token: 'replacement-token',
    });
  });

  it('isolates same-provider rows by project and exact connection identity', async () => {
    const projectA = await seedProject('Project A', '/tmp/project-a');
    const projectB = await seedProject('Project B', '/tmp/project-b');
    const connectionA = await service.replaceIntegrationConnection(
      {
        projectId: projectA,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'token-a' },
      },
      async () => undefined,
    );
    const connectionB = await service.replaceIntegrationConnection(
      {
        projectId: projectB,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'token-b' },
      },
      async () => undefined,
    );

    expect(connectionA.id).not.toBe(connectionB.id);
    expect(await service.listIntegrationConnections(projectA)).toEqual([connectionA]);
    expect(await service.listIntegrationConnections(projectB)).toEqual([connectionB]);
    expect(await service.getIntegrationConnectionCredentialsById(connectionA.id)).toEqual({
      provider: 'clickup',
      token: 'token-a',
    });
    expect(
      await service.getIntegrationConnectionCredentials({
        projectId: projectB,
        provider: 'clickup',
      }),
    ).toEqual({ provider: 'clickup', token: 'token-b' });

    const storedB = sqlite
      .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
      .get(connectionB.id) as { credential_ciphertext: string };
    const now = new Date().toISOString();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO integration_connections (
            id, project_id, provider, legacy_source_connection_id, credential_ciphertext,
            generation, subtask_sync_enabled, sync_setting_revision, created_at, updated_at
          ) VALUES ('duplicate-project-provider', ?, 'clickup', NULL, ?, 1, 0, 1, ?, ?)`,
        )
        .run(projectB, storedB.credential_ciphertext, now, now),
    ).toThrow();

    const updatedB = await service.updateIntegrationConnectionSyncSettingById(connectionB.id, true);
    expect(updatedB.subtaskSyncEnabled).toBe(true);
    expect(
      (await service.getIntegrationConnection({ projectId: projectA, provider: 'clickup' }))
        ?.subtaskSyncEnabled,
    ).toBe(false);

    expect(
      await service.disconnectIntegrationConnection({
        projectId: projectA,
        provider: 'clickup',
      }),
    ).toBe(true);
    expect(await service.getIntegrationConnectionById(connectionA.id)).toBeNull();
    expect(await service.getIntegrationConnectionById(connectionB.id)).toEqual(updatedB);
  });

  it('allows at most one unassigned legacy row per provider', async () => {
    const projectId = await seedProject('Cipher source', '/tmp/cipher-source');
    const source = await service.replaceIntegrationConnection(
      {
        projectId,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://legacy.atlassian.net',
          email: 'legacy@example.com',
          token: 'legacy-token',
        },
      },
      async () => undefined,
    );
    const raw = sqlite
      .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
      .get(source.id) as { credential_ciphertext: string };
    const insertLegacy = sqlite.prepare(
      `INSERT INTO integration_connections (
        id, project_id, provider, legacy_source_connection_id, credential_ciphertext,
        generation, subtask_sync_enabled, sync_setting_revision, created_at, updated_at
      ) VALUES (?, NULL, 'jira', NULL, ?, 1, 0, 1, ?, ?)`,
    );
    const now = new Date().toISOString();

    insertLegacy.run('legacy-jira-1', raw.credential_ciphertext, now, now);
    expect(await service.getIntegrationConnectionById('legacy-jira-1')).toMatchObject({
      projectId: null,
      provider: 'jira',
      legacySourceConnectionId: null,
    });
    expect(() => insertLegacy.run('legacy-jira-2', raw.credential_ciphertext, now, now)).toThrow();
  });

  it('assigns and disconnects only exact unassigned rows without changing credentials', async () => {
    const occupiedProjectId = await seedProject('Occupied target', '/tmp/occupied-target');
    const vacantProjectId = await seedProject('Vacant target', '/tmp/vacant-target');
    const source = await service.replaceIntegrationConnection(
      {
        projectId: occupiedProjectId,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://legacy.atlassian.net',
          email: 'legacy@example.com',
          token: 'legacy-token',
        },
      },
      async () => undefined,
    );
    const raw = sqlite
      .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
      .get(source.id) as { credential_ciphertext: string };
    const now = new Date().toISOString();
    const insertLegacy = sqlite.prepare(
      `INSERT INTO integration_connections (
        id, project_id, provider, legacy_source_connection_id, credential_ciphertext,
        generation, subtask_sync_enabled, sync_setting_revision, created_at, updated_at
      ) VALUES (?, NULL, 'jira', NULL, ?, 3, 1, 2, ?, ?)`,
    );
    const legacyId = '11111111-1111-4111-8111-111111111111';
    insertLegacy.run(legacyId, raw.credential_ciphertext, now, now);

    await expect(
      service.assignUnassignedIntegrationConnection(legacyId, 'missing-project'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.assignUnassignedIntegrationConnection(legacyId, occupiedProjectId),
    ).rejects.toMatchObject<ConflictError>({
      details: { projectId: occupiedProjectId, provider: 'jira' },
    });

    const assigned = await service.assignUnassignedIntegrationConnection(legacyId, vacantProjectId);

    expect(assigned).toMatchObject({
      id: legacyId,
      projectId: vacantProjectId,
      provider: 'jira',
      legacySourceConnectionId: legacyId,
      generation: 3,
      subtaskSyncEnabled: true,
      syncSettingRevision: 2,
    });
    expect(
      sqlite
        .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
        .get(legacyId),
    ).toEqual(raw);
    await expect(service.getIntegrationConnectionCredentialsById(legacyId)).resolves.toEqual({
      provider: 'jira',
      siteUrl: 'https://legacy.atlassian.net',
      email: 'legacy@example.com',
      token: 'legacy-token',
    });
    await expect(
      service.assignUnassignedIntegrationConnection(legacyId, vacantProjectId),
    ).rejects.toThrow('not an unassigned legacy connection');
    await expect(service.disconnectUnassignedIntegrationConnection(legacyId)).rejects.toThrow(
      'not an unassigned legacy connection',
    );

    const secondLegacyId = '22222222-2222-4222-8222-222222222222';
    insertLegacy.run(secondLegacyId, raw.credential_ciphertext, now, now);
    await expect(service.disconnectUnassignedIntegrationConnection(secondLegacyId)).resolves.toBe(
      true,
    );
    expect(
      sqlite
        .prepare('SELECT credential_ciphertext FROM integration_connections WHERE id = ?')
        .get(secondLegacyId),
    ).toBeUndefined();
  });

  it('preserves source links and resolves them by provider and remote scope after disconnect', async () => {
    const connectionProjectId = await seedProject('Connection project', '/tmp/connection-project');
    const connection = await service.replaceIntegrationConnection(
      {
        projectId: connectionProjectId,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'private@example.com',
          token: 'jira-token',
        },
      },
      async () => undefined,
    );
    const statuses = await service.listStatuses(connectionProjectId);
    const epic = await service.createEpic({
      projectId: connectionProjectId,
      title: 'Imported source',
      statusId: statuses.items[0].id,
    });
    const link = await service.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: '10001',
      sourceSnapshot: { title: 'Original Jira title', key: 'ENG-1' },
    });

    const identity = { projectId: connectionProjectId, provider: 'jira' as const };
    expect(await service.disconnectIntegrationConnection(identity)).toBe(true);
    expect(await service.getIntegrationConnection(identity)).toBeNull();
    expect(await service.getIntegrationConnectionCredentials(identity)).toBeNull();
    expect(await service.listExternalTaskLinksByRemoteScope('jira', 'acme.atlassian.net')).toEqual([
      { ...link, connectionId: null },
    ]);
    expect(
      await service.findExternalTaskLink(
        connectionProjectId,
        'jira',
        'acme.atlassian.net',
        '10001',
      ),
    ).toEqual({
      ...link,
      connectionId: null,
    });
  });

  it('rejects a direct external link across project connection ownership', async () => {
    const connectionProjectId = await seedProject('Connection project', '/tmp/connection-owner');
    const epic = await seedEpic();
    const connection = await service.replaceIntegrationConnection(
      {
        projectId: connectionProjectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'project-a-token' },
      },
      async () => undefined,
    );

    await expect(
      service.createExternalTaskLink({
        epicId: epic.id,
        connectionId: connection.id,
        provider: 'clickup',
        remoteScopeKey: 'workspace-ownership',
        remoteTaskId: 'task-cross-project',
        sourceSnapshot: { title: 'Cross-project task' },
      }),
    ).rejects.toMatchObject<ValidationError>({
      message: 'External task link project must match its connection.',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM external_task_links').get()).toEqual({
      count: 0,
    });
  });

  it('enforces remote identity uniqueness per project and external-link foreign keys', async () => {
    const firstEpic = await seedEpic();
    const projectId = firstEpic.projectId;
    const statuses = await service.listStatuses(projectId);
    const secondEpic = await service.createEpic({
      projectId,
      title: 'Duplicate import',
      statusId: statuses.items[0].id,
    });
    const input = {
      epicId: firstEpic.id,
      connectionId: null,
      provider: 'clickup' as const,
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-1',
      sourceSnapshot: { title: 'Remote task' },
    };

    const created = await service.createExternalTaskLink(input);
    expect(created.projectId).toBe(projectId);
    await expect(
      service.createExternalTaskLink({ ...input, epicId: secondEpic.id }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.createExternalTaskLink({ ...input, epicId: 'missing-epic', remoteTaskId: 'task-2' }),
    ).rejects.toThrow();
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The same remote identity links independently in another project, and
    // each project-scoped lookup resolves only its own link.
    const otherProjectId = await seedProject('Other project', '/tmp/other-project');
    const otherStatuses = await service.listStatuses(otherProjectId);
    const otherEpic = await service.createEpic({
      projectId: otherProjectId,
      title: 'Other project import',
      statusId: otherStatuses.items[0].id,
    });
    const otherLink = await service.createExternalTaskLink({
      ...input,
      epicId: otherEpic.id,
    });
    expect(otherLink.projectId).toBe(otherProjectId);
    expect(otherLink.id).not.toBe(created.id);
    await expect(
      service.findExternalTaskLink(projectId, 'clickup', 'workspace-1', 'task-1'),
    ).resolves.toMatchObject({ id: created.id, projectId });
    await expect(
      service.findExternalTaskLink(otherProjectId, 'clickup', 'workspace-1', 'task-1'),
    ).resolves.toMatchObject({ id: otherLink.id, projectId: otherProjectId });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('returns only requested links in stable Epic-ID and creation-time order', async () => {
    const project = await service.createProject({
      name: 'Batch project',
      description: null,
      rootPath: '/tmp/batch-project',
    });
    const statuses = await service.listStatuses(project.id);
    const epicA = await service.createEpic({
      projectId: project.id,
      title: 'Epic A',
      statusId: statuses.items[0].id,
    });
    const epicB = await service.createEpic({
      projectId: project.id,
      title: 'Epic B',
      statusId: statuses.items[0].id,
    });
    await service.createExternalTaskLink({
      epicId: epicB.id,
      connectionId: null,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-b',
      sourceSnapshot: { title: 'B' },
    });
    await service.createExternalTaskLink({
      epicId: epicA.id,
      connectionId: null,
      provider: 'clickup',
      remoteScopeKey: 'workspace-1',
      remoteTaskId: 'task-a',
      sourceSnapshot: { title: 'A' },
    });
    await service.createExternalTaskLink({
      epicId: epicA.id,
      connectionId: null,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-A2',
      sourceSnapshot: { title: 'A second' },
    });

    const links = await service.listExternalTaskLinksForEpics([epicA.id, epicB.id, 'missing-id']);

    // Epic IDs are random UUIDs: stable order means ascending Epic ID, then
    // creation time within one Epic — not creation order across Epics.
    const expectedOrder = [epicA, epicB].sort((left, right) => left.id.localeCompare(right.id));
    expect(links.map((link) => [link.epicId, link.remoteTaskId])).toEqual([
      [expectedOrder[0].id, expectedOrder[0].id === epicA.id ? 'task-a' : 'task-b'],
      ...(expectedOrder[0].id === epicA.id ? [[epicA.id, 'ENG-A2']] : []),
      [expectedOrder[1].id, expectedOrder[1].id === epicA.id ? 'task-a' : 'task-b'],
      ...(expectedOrder[1].id === epicA.id ? [[epicA.id, 'ENG-A2']] : []),
    ]);
  });

  it('resolves exactly 1,000 requested Epic IDs through one query', async () => {
    const epicIds = Array.from({ length: 1_000 }, (_, index) => {
      const hex = index.toString(16).padStart(4, '0');
      return [
        `${hex}00000`,
        `${hex}0`,
        `4${hex.slice(1)}0`,
        `8${hex.slice(1)}0`,
        `${hex}00000000`,
      ].join('-');
    });
    // Packaging regression: the API limit must stay a single IN query below
    // the bundled SQLite bind-variable ceiling.
    await expect(service.listExternalTaskLinksForEpics(epicIds)).resolves.toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM external_task_links').get()).toEqual({
      count: 0,
    });
  });
});
