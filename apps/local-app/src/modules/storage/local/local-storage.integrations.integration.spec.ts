import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
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

  it('returns safe connection projections while storing and reading credentials explicitly', async () => {
    const verify = jest.fn().mockResolvedValue(undefined);
    const credentials = {
      provider: 'jira' as const,
      siteUrl: 'https://acme.atlassian.net',
      email: 'private@example.com',
      token: 'jira-token',
    };

    const connection = await service.replaceIntegrationConnection(
      { provider: 'jira', credentials },
      verify,
    );

    expect(verify).toHaveBeenCalledWith(credentials);
    expect(connection).toEqual({
      id: expect.any(String),
      provider: 'jira',
      generation: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await service.getIntegrationConnection('jira')).toEqual(connection);
    expect(await service.listIntegrationConnections()).toEqual([connection]);
    expect(await service.getIntegrationConnectionCredentials('jira')).toEqual(credentials);

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
    const original = await service.replaceIntegrationConnection(
      { provider: 'clickup', credentials: { provider: 'clickup', token: 'original-token' } },
      async () => undefined,
    );
    const originalRaw = sqlite
      .prepare('SELECT * FROM integration_connections WHERE id = ?')
      .get(original.id);

    await expect(
      service.replaceIntegrationConnection(
        { provider: 'clickup', credentials: { provider: 'clickup', token: 'invalid-token' } },
        async () => {
          throw new ValidationError('Credential validation failed.');
        },
      ),
    ).rejects.toThrow(ValidationError);
    expect(
      sqlite.prepare('SELECT * FROM integration_connections WHERE id = ?').get(original.id),
    ).toEqual(originalRaw);
    expect(await service.getIntegrationConnectionCredentials('clickup')).toEqual({
      provider: 'clickup',
      token: 'original-token',
    });

    const replaced = await service.replaceIntegrationConnection(
      { provider: 'clickup', credentials: { provider: 'clickup', token: 'replacement-token' } },
      async () => undefined,
    );
    expect(replaced.id).toBe(original.id);
    expect(replaced.generation).toBe(2);
    expect(await service.getIntegrationConnectionCredentials('clickup')).toEqual({
      provider: 'clickup',
      token: 'replacement-token',
    });
  });

  it('preserves source links and resolves them by provider and remote scope after disconnect', async () => {
    const connection = await service.replaceIntegrationConnection(
      {
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
    const epic = await seedEpic();
    const link = await service.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: '10001',
      sourceSnapshot: { title: 'Original Jira title', key: 'ENG-1' },
    });

    expect(await service.disconnectIntegrationConnection('jira')).toBe(true);
    expect(await service.getIntegrationConnection('jira')).toBeNull();
    expect(await service.getIntegrationConnectionCredentials('jira')).toBeNull();
    expect(await service.listExternalTaskLinksByRemoteScope('jira', 'acme.atlassian.net')).toEqual([
      { ...link, connectionId: null },
    ]);
    expect(await service.findExternalTaskLink('jira', 'acme.atlassian.net', '10001')).toEqual({
      ...link,
      connectionId: null,
    });
  });

  it('enforces remote identity uniqueness and external-link foreign keys', async () => {
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

    await service.createExternalTaskLink(input);
    await expect(
      service.createExternalTaskLink({ ...input, epicId: secondEpic.id }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.createExternalTaskLink({ ...input, epicId: 'missing-epic', remoteTaskId: 'task-2' }),
    ).rejects.toThrow();
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
