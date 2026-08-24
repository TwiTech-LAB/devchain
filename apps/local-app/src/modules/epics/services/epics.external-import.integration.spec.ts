import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
  let eventsService: {
    publish: jest.Mock;
    prepareCommitted?: jest.Mock;
    emitCommitted?: jest.Mock;
  };
  let secretDirectory: string;
  let projectId: string;
  let statusId: string;
  let statusName: string;

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
    enableAtomicEventPath();
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
    const defaultStatus = (await storage.listStatuses(projectId)).items[0];
    statusId = defaultStatus.id;
    statusName = defaultStatus.label;
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

  function enableAtomicEventPath(): void {
    eventsService.prepareCommitted = jest.fn((name: string, payload: Record<string, unknown>) => {
      expect(sqlite.inTransaction).toBe(true);
      return {
        id: randomUUID(),
        name,
        payload,
        requestId: null,
        publishedAt: new Date().toISOString(),
      };
    });
    eventsService.emitCommitted = jest.fn();
  }

  function persistedEpicCreatedPayload(): Record<string, unknown> {
    const row = sqlite
      .prepare(
        "SELECT payload_json FROM events WHERE name = 'epic.created' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.payload_json) as Record<string, unknown>;
  }

  function persistedEpicUpdatedPayload(): Record<string, unknown> {
    const row = sqlite
      .prepare(
        "SELECT payload_json FROM events WHERE name = 'epic.updated' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.payload_json) as Record<string, unknown>;
  }

  describe('transactional epic.created status snapshot', () => {
    it('persists statusName through createEpic', async () => {
      enableAtomicEventPath();

      await service.createEpic({
        projectId,
        title: 'Direct creation',
        description: null,
        statusId,
        data: null,
        tags: [],
      });

      expect(persistedEpicCreatedPayload()).toMatchObject({
        projectName: 'External import project',
        statusId,
        statusName,
      });
      expect(eventsService.publish).not.toHaveBeenCalled();
      expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
    });

    it('persists the resolved default statusName through createEpicForProject', async () => {
      enableAtomicEventPath();

      await service.createEpicForProject(projectId, { title: 'Project creation' });

      expect(persistedEpicCreatedPayload()).toMatchObject({
        projectName: 'External import project',
        statusId,
        statusName,
      });
      expect(eventsService.publish).not.toHaveBeenCalled();
      expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
    });

    it('persists statusName through createEpicWithExternalTaskLink', async () => {
      enableAtomicEventPath();

      await service.createEpicWithExternalTaskLink(importInput());

      expect(persistedEpicCreatedPayload()).toMatchObject({
        projectName: 'External import project',
        statusId,
        statusName,
      });
      expect(eventsService.publish).not.toHaveBeenCalled();
      expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
    });

    it('persists status names inside an epic.updated status change', async () => {
      const statuses = (await storage.listStatuses(projectId)).items;
      const previousStatus = statuses[0];
      const currentStatus = statuses[1];
      expect(currentStatus).toBeDefined();
      const epic = await service.createEpic({
        projectId,
        title: 'Status update',
        description: null,
        statusId: previousStatus.id,
        data: null,
        tags: [],
      });

      await service.updateEpic(epic.id, { statusId: currentStatus.id }, epic.version);

      expect(persistedEpicUpdatedPayload()).toMatchObject({
        changes: {
          statusId: {
            previous: previousStatus.id,
            current: currentStatus.id,
            previousName: previousStatus.label,
            currentName: currentStatus.label,
          },
        },
      });
      expect(eventsService.publish).not.toHaveBeenCalled();
    });
  });

  it('commits the Epic and link in one outer transaction before emitting epic.created', async () => {
    const runImmediateAsync = jest.spyOn(TransactionRunner.prototype, 'runImmediateAsync');
    eventsService.emitCommitted!.mockImplementation(
      (event: { name: string; payload: { epicId: string } }) => {
        expect(event.name).toBe('epic.created');
        expect(sqlite.inTransaction).toBe(false);
        expect(
          sqlite
            .prepare('SELECT COUNT(*) AS count FROM external_task_links WHERE epic_id = ?')
            .get(event.payload.epicId),
        ).toEqual({ count: 1 });
      },
    );

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
    expect(eventsService.publish).not.toHaveBeenCalled();
    expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
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
    expect(eventsService.emitCommitted).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE name = 'epic.created'").get(),
    ).toEqual({
      count: 0,
    });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('recovers a link uniqueness race after rollback and emits only for the winner', async () => {
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
    expect(eventsService.publish).not.toHaveBeenCalled();
    expect(eventsService.emitCommitted).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
