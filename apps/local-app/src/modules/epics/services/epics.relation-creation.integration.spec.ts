import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { EventsService } from '../../events/services/events.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { Agent, Epic, Project } from '../../storage/models/domain.models';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { EpicsService } from './epics.service';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomUUID: jest.fn(actual.randomUUID) };
});

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const LOWER_EPIC_ID = '00000000-0000-4000-8000-000000000010';
const HIGHER_EPIC_ID = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
const RELATION_ID = '99999999-9999-4999-8999-999999999999';
const realRandomUUID = jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID;
const randomUUIDMock = crypto.randomUUID as jest.MockedFunction<typeof crypto.randomUUID>;

describe('EpicsService atomic relation creation', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let service: EpicsService;
  let events: { publish: jest.Mock; prepareCommitted: jest.Mock; emitCommitted: jest.Mock };
  let project: Project;
  let actor: Agent;
  let target: Epic;

  beforeEach(async () => {
    resetRandomUUID();
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    storage = new LocalStorageService(drizzle(sqlite));
    events = {
      publish: jest.fn().mockResolvedValue('event-id'),
      prepareCommitted: jest.fn((name: string, payload: Record<string, unknown>) => {
        expect(sqlite.inTransaction).toBe(true);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM epic_relations').get()).toEqual({
          count: 1,
        });
        return {
          id: '77777777-7777-4777-8777-777777777777',
          name,
          payload,
          requestId: null,
          publishedAt: '2026-08-29T00:00:00.000Z',
        };
      }),
      emitCommitted: jest.fn(),
    };
    service = new EpicsService(
      storage,
      events as unknown as EventsService,
      { getAutoCleanStatusIds: jest.fn().mockReturnValue([]) } as unknown as SettingsService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
    project = await createProject('Atomic Focal');
    actor = await createAgent(project.id, 'Atomic Agent', true);
    randomUUIDMock.mockReturnValueOnce('88888888-8888-4888-8888-888888888888');
    target = await storage.createEpicForProject(project.id, { title: 'Target' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  async function createProject(name: string): Promise<Project> {
    return storage.createProject({
      name,
      description: null,
      rootPath: `/tmp/${name.toLowerCase().replaceAll(' ', '-')}`,
    });
  }

  function resetRandomUUID(): void {
    randomUUIDMock.mockReset();
    randomUUIDMock.mockImplementation(realRandomUUID);
  }

  async function createAgent(
    projectId: string,
    name: string,
    isProjectOwner = false,
  ): Promise<Agent> {
    const key = name.toLowerCase().replaceAll(' ', '-');
    const provider = await storage.createProvider({ name: `provider-${key}` });
    const profile = await storage.createAgentProfile({ projectId, name: `profile-${name}` });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${name}`,
    });
    return storage.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name,
      isProjectOwner,
    });
  }

  function persistedCounts() {
    const count = (table: string): number =>
      (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return {
      epics: count('epics'),
      relations: count('epic_relations'),
      tags: count('tags'),
      epicTags: count('epic_tags'),
      events: count('events'),
      eventHandlers: count('event_handlers'),
    };
  }

  async function createWithRelation(
    relation: 'related' | 'blocks' | 'blocked_by',
    generatedEpicId: string,
    input: {
      relatedEpicId?: string;
      parentId?: string;
      tags?: string[];
      actor?: { type: 'agent' | 'guest'; id: string };
    } = {},
  ): Promise<Epic> {
    resetRandomUUID();
    randomUUIDMock.mockReturnValueOnce(generatedEpicId).mockReturnValueOnce(RELATION_ID);
    return service.createEpicForProject(
      project.id,
      {
        title: `Created ${relation}`,
        parentId: input.parentId,
        tags: input.tags,
        relation: {
          relatedEpicId: input.relatedEpicId ?? target.id,
          relation,
        },
      },
      {
        actor: input.actor ?? { type: 'agent', id: actor.id },
        creatorAgentName: actor.name,
      },
    );
  }

  it.each([
    ['related', LOWER_EPIC_ID],
    ['related', HIGHER_EPIC_ID],
    ['blocks', LOWER_EPIC_ID],
    ['blocks', HIGHER_EPIC_ID],
    ['blocked_by', LOWER_EPIC_ID],
    ['blocked_by', HIGHER_EPIC_ID],
  ] as const)(
    'commits %s relative to the generated Epic in UUID order %s',
    async (relation, id) => {
      const created = await createWithRelation(relation, id);

      expect(created.id).toBe(id);
      expect(await storage.listEpicRelations(id)).toMatchObject({
        items: [expect.objectContaining({ epicId: target.id, type: relation })],
        total: 1,
      });
      expect(persistedCounts()).toEqual({
        epics: 2,
        relations: 1,
        tags: 0,
        epicTags: 0,
        events: 1,
        eventHandlers: 0,
      });
      expect(events.emitCommitted).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
        workspaceId: project.workspaceId,
      });
    },
  );

  it('allows the focal project current Project Owner to create a cross-project relation', async () => {
    resetRandomUUID();
    const peerProject = await createProject('Atomic Owner Peer');
    const peerTarget = await storage.createEpicForProject(peerProject.id, { title: 'Peer Target' });

    const created = await createWithRelation('blocks', LOWER_EPIC_ID, {
      relatedEpicId: peerTarget.id,
    });

    expect(await storage.listEpicRelations(created.id)).toMatchObject({
      items: [expect.objectContaining({ epicId: peerTarget.id, type: 'blocks' })],
      total: 1,
    });
  });

  it.each([
    ['missing', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NotFoundError],
    ['cross-workspace', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NotFoundError],
  ] as const)('rolls back a %s relation target', async (scenario, generatedId, ErrorType) => {
    let relatedEpicId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    if (scenario === 'cross-workspace') {
      const foreignWorkspace = await storage.createProjectWorkspace('Foreign');
      const foreignProject = await storage.createProject({
        name: 'Foreign',
        description: null,
        rootPath: '/tmp/foreign-atomic',
        workspaceId: foreignWorkspace.id,
      });
      relatedEpicId = (await storage.createEpicForProject(foreignProject.id, { title: 'Foreign' }))
        .id;
    }
    const before = persistedCounts();

    await expect(
      createWithRelation('related', generatedId, { relatedEpicId }),
    ).rejects.toBeInstanceOf(ErrorType);

    expect(persistedCounts()).toEqual(before);
    expect(events.emitCommitted).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rolls back ambiguous and direct-parent targets', async () => {
    const before = persistedCounts();
    const candidate = {
      id: target.id,
      projectId: project.id,
      projectName: project.name,
      title: target.title,
      statusId: target.statusId,
      statusLabel: 'New',
      statusColor: '#ccc',
      statusMcpHidden: false,
      parentId: null,
    };
    jest
      .spyOn(storage, 'getWorkspaceEpicsByIdPrefix')
      .mockResolvedValueOnce([
        candidate,
        { ...candidate, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      ]);
    await expect(
      createWithRelation('related', LOWER_EPIC_ID, { relatedEpicId: 'dddddddd' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(persistedCounts()).toEqual(before);

    jest.mocked(storage.getWorkspaceEpicsByIdPrefix).mockRestore();
    await expect(
      createWithRelation('blocks', HIGHER_EPIC_ID, {
        relatedEpicId: target.id,
        parentId: target.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(persistedCounts()).toEqual(before);
    expect(events.emitCommitted).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rolls back guest, unauthorized cross-project, and injected insert failures', async () => {
    const before = persistedCounts();
    await expect(
      createWithRelation('related', LOWER_EPIC_ID, {
        actor: { type: 'guest', id: 'guest-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(persistedCounts()).toEqual(before);

    resetRandomUUID();
    const peerProject = await createProject('Atomic Peer');
    const peerTarget = await storage.createEpicForProject(peerProject.id, { title: 'Peer Target' });
    const member = await createAgent(project.id, 'Atomic Member');
    const beforeUnauthorized = persistedCounts();
    await expect(
      createWithRelation('blocks', HIGHER_EPIC_ID, {
        relatedEpicId: peerTarget.id,
        actor: { type: 'agent', id: member.id },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(persistedCounts()).toEqual(beforeUnauthorized);

    resetRandomUUID();
    const beforeInjected = persistedCounts();
    jest
      .spyOn(storage, 'setEpicRelation')
      .mockRejectedValueOnce(new Error('injected relation insert'));
    await expect(
      createWithRelation('related', LOWER_EPIC_ID, { tags: ['Atomic Rollback Tag'] }),
    ).rejects.toThrow('injected relation insert');
    expect(persistedCounts()).toEqual(beforeInjected);
    expect(events.emitCommitted).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });
});
