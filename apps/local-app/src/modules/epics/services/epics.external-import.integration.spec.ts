import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { NotFoundError } from '../../../common/errors/error-types';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { CreateEpicWithExternalTaskLink } from '../../storage/models/domain.models';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { EpicsService } from './epics.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('EpicsService external task import', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let service: EpicsService;
  let eventsService: { publish: jest.Mock };
  let secretDirectory: string;
  let projectId: string;
  let statusId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-external-import-'));
    storage = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'test-host:test-user',
      }),
    );
    eventsService = { publish: jest.fn().mockResolvedValue('event-id') };
    service = new EpicsService(
      storage,
      eventsService as unknown as EventsService,
      { getAutoCleanStatusIds: jest.fn().mockReturnValue([]) } as unknown as SettingsService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );

    const project = await storage.createProject({
      name: 'External import project',
      description: null,
      rootPath: '/tmp/external-import-project',
    });
    projectId = project.id;
    statusId = (await storage.listStatuses(projectId)).items[0].id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  function importInput(
    overrides: Partial<CreateEpicWithExternalTaskLink> = {},
  ): CreateEpicWithExternalTaskLink {
    return {
      epic: {
        projectId,
        title: 'Imported task',
        description: 'Remote task snapshot',
        statusId,
        data: { source: 'external' },
        tags: ['Imported'],
        skillsRequired: ['openai/review'],
      },
      externalTaskLink: {
        connectionId: null,
        provider: 'clickup',
        remoteScopeKey: 'workspace-1',
        remoteTaskId: 'task-1',
        sourceSnapshot: { title: 'Imported task', listId: 'list-a' },
      },
      ...overrides,
    };
  }

  it('commits the Epic and link in one outer transaction before publishing epic.created', async () => {
    const runImmediateAsync = jest.spyOn(TransactionRunner.prototype, 'runImmediateAsync');
    eventsService.publish.mockImplementation(async (name: string, payload: { epicId: string }) => {
      expect(name).toBe('epic.created');
      expect(sqlite.inTransaction).toBe(false);
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS count FROM external_task_links WHERE epic_id = ?')
          .get(payload.epicId),
      ).toEqual({ count: 1 });
      return 'event-id';
    });

    const result = await service.createEpicWithExternalTaskLink(importInput());

    expect(result.created).toBe(true);
    expect(result.externalTaskLink.epicId).toBe(result.epic.id);
    expect(result.epic).toMatchObject({
      title: 'Imported task',
      data: { source: 'external' },
      tags: ['Imported'],
      skillsRequired: ['openai/review'],
    });
    expect(await storage.getEpic(result.epic.id)).toMatchObject({
      data: { source: 'external' },
      tags: ['Imported'],
      skillsRequired: ['openai/review'],
    });
    expect(runImmediateAsync).toHaveBeenCalledTimes(1);
    expect(eventsService.publish).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back the Epic when the external link cannot satisfy its connection FK', async () => {
    const input = importInput({
      externalTaskLink: {
        connectionId: 'missing-connection',
        provider: 'jira',
        remoteScopeKey: 'acme.atlassian.net',
        remoteTaskId: '10001',
        sourceSnapshot: { title: 'ENG-1' },
      },
    });

    await expect(service.createEpicWithExternalTaskLink(input)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epics').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM external_task_links').get()).toEqual({
      count: 0,
    });
    expect(eventsService.publish).not.toHaveBeenCalled();
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('recovers a link uniqueness race after rollback and publishes only for the winner', async () => {
    const firstInput = importInput();
    const movedTaskInput = importInput({
      epic: { ...firstInput.epic, title: 'Duplicate import attempt' },
      externalTaskLink: {
        ...firstInput.externalTaskLink,
        sourceSnapshot: { title: 'Imported task', listId: 'list-b' },
      },
    });

    const results = await Promise.all([
      service.createEpicWithExternalTaskLink(firstInput),
      service.createEpicWithExternalTaskLink(movedTaskInput),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.epic.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.externalTaskLink.id)).size).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epics').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM external_task_links').get()).toEqual({
      count: 1,
    });
    expect(eventsService.publish).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
