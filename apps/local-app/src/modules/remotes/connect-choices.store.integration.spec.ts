// Real SQLite is the cheapest layer that verifies settings persistence, recording and HTTP projection.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { NotFoundError } from '../../common/errors/error-types';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { ConnectChoicesController } from './connect-choices.controller';
import { ConnectChoicesStore } from './connect-choices.store';
import type { ConnectLastChoices } from './connect-choices.dto';
import { RemoteOperationsService } from './operations/remote-operations.service';

const projectId = '11111111-1111-4111-8111-111111111111';
const otherProject = '33333333-3333-4333-8333-333333333333';
const remoteId = '22222222-2222-4222-8222-222222222222';
let database: ReturnType<typeof createTestDatabase>;
let store: ConnectChoicesStore;
beforeEach(() => {
  database = createTestDatabase();
  store = new ConnectChoicesStore(database.db);
});
afterEach(() => database.sqlite.close());

const saved = (): ConnectLastChoices => ({
  remoteId,
  includeDocker: true,
  items: {
    'container:web': { included: true, mode: 'without-data' },
    'container:db': { included: false },
  },
  savedAt: '2026-10-04T17:00:00.000Z',
});

function seed(value: string): void {
  database.sqlite
    .prepare('INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('connect-test', 'connect.lastChoices', value, '', '');
}

it('reads valid project entries independently of malformed siblings', () => {
  seed(JSON.stringify({ [projectId]: saved(), bad: { ...saved(), dataChoice: 'replace-home' } }));
  expect(store.get(projectId)).toEqual(saved());
  expect(store.get('bad')).toBeNull();
});

it.each(['broken-json', 'null', '[]', '42'])(
  'uses defaults for an invalid settings map %s',
  (value) => {
    seed(value);
    expect(store.get(projectId)).toBeNull();
  },
);

it('keeps the Docker snapshot when a later attach has no Docker selection', () => {
  seed(JSON.stringify({ [projectId]: saved() }));
  store.recordAttach(projectId, 'another-vm', false);
  expect(new ConnectChoicesStore(database.db).get(projectId)).toMatchObject({
    remoteId: 'another-vm',
    includeDocker: false,
    items: saved().items,
  });
});

it('replaces the offered snapshot with inclusions and exclusions keyed by kind and name', () => {
  seed(JSON.stringify({ [projectId]: saved(), [otherProject]: saved() }));
  store.recordPlan(projectId, remoteId, [
    {
      kind: 'container',
      name: 'shared',
      linkedReasons: ['bind'],
      choices: ['without-data'],
      selectedMode: 'without-data',
    },
    {
      kind: 'compose-project',
      name: 'shared',
      linkedReasons: ['compose'],
      choices: ['data-only'],
      selectedMode: null,
    },
    {
      kind: 'container',
      name: 'unlinked',
      linkedReasons: [],
      choices: ['without-data'],
      selectedMode: null,
    },
    {
      kind: 'container',
      name: 'blocked',
      linkedReasons: ['bind'],
      choices: [],
      selectedMode: null,
    },
  ]);
  expect(store.get(projectId)?.items).toEqual({
    'container:shared': { included: true, mode: 'without-data' },
    'compose-project:shared': { included: false },
  });
  expect(store.get(otherProject)).toEqual(saved());
});

it.each([false, true])(
  'records the VM and Docker toggle when attach is created (Docker %s)',
  async (includeDocker) => {
    const runner = { start: async () => ({ id: 'operation' }) };
    const service = new RemoteOperationsService(
      {
        getRemote: async () => ({ id: remoteId, baseUrl: 'https://vm:3000' }),
        listRemoteOperations: async () => [],
        getProject: async () => ({ id: projectId }),
      } as never,
      runner as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      store,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.attach(
      remoteId,
      projectId,
      includeDocker ? { items: [{ id: 'web', mode: 'without-data' }] } : undefined,
    );
    expect(new ConnectChoicesStore(database.db).get(projectId)).toMatchObject({
      remoteId,
      includeDocker,
      items: {},
    });
  },
);

it('does not overwrite choices when attach creation is refused', async () => {
  seed(JSON.stringify({ [projectId]: saved() }));
  const service = new RemoteOperationsService(
    {
      getRemote: async () => ({ baseUrl: 'https://vm:3000' }),
      listRemoteOperations: async () => [],
      getProject: async () => ({}),
    } as never,
    {
      start: async () => {
        throw new Error('busy');
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    store,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await expect(service.attach('other-vm', projectId)).rejects.toThrow('busy');
  expect(store.get(projectId)).toEqual(saved());
});

it('serves only the public choices and validates project IDs and existence', async () => {
  seed(JSON.stringify({ [projectId]: saved() }));
  const root = mkdtempSync(join(tmpdir(), 'connect-choices-'));
  const module = await Test.createTestingModule({
    controllers: [ConnectChoicesController],
    providers: [
      ConnectChoicesStore,
      { provide: DB_CONNECTION, useValue: database.db },
      {
        provide: STORAGE_SERVICE,
        useValue: {
          getProject: async (id: string) => {
            if (![projectId, otherProject].includes(id)) throw new NotFoundError('project', id);
            return { id, rootPath: root };
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const read = (id: string) =>
      app.inject({ method: 'GET', url: `/api/projects/${id}/connect-choices` });
    expect((await read(projectId)).json()).toEqual({
      remoteId,
      includeDocker: true,
      git: 'missing',
    });
    expect((await read(otherProject)).json()).toEqual({ includeDocker: false, git: 'missing' });
    mkdirSync(join(root, '.git'));
    expect((await read(projectId)).json().git).toBe('missing');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    for (const folder of ['objects', 'refs']) mkdirSync(join(root, '.git', folder));
    expect((await read(projectId)).json().git).toBe('present');
    rmSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /other/worktree');
    expect((await read(projectId)).json().git).toBe('present');
    expect((await read('not-a-uuid')).statusCode).toBe(400);
    expect((await read(remoteId)).statusCode).toBe(404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
