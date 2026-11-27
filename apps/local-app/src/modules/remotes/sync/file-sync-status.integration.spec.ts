import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { FileSyncStatusController } from './file-sync-status.controller';
import type { FileSyncStatusResponse } from './file-sync-status.dto';
import { FileSyncStatusService } from './file-sync-status.service';
import { RemoteFileSyncService } from './remote-file-sync.service';

// One small Nest app proves the route, its query validation and the JSON contract.
// The module provides no RemoteHostClient, so the route cannot call the VM.
describe('GET /api/remotes/file-sync/status', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const VM = 'VM-DEVICE';
  const syncthing = { running: true, version: 'v2.1.5', error: null as string | null };
  let app: NestFastifyApplication;
  let files: FakeFileSyncService;

  beforeAll(async () => {
    files = new FakeFileSyncService();
    await files.addPeer({ deviceId: VM, address: 'tcp://10.0.0.2:22000' });
    for (const projectId of [A, B])
      for (const kind of ['code', 'git'] as const)
        await files.ensureFolder({
          projectId,
          kind,
          type: 'sendreceive',
          peerDeviceId: VM,
          ignores: [],
        });
    const module = await Test.createTestingModule({
      controllers: [FileSyncStatusController],
      providers: [
        FileSyncStatusService,
        { provide: FileSyncService, useValue: files },
        { provide: SyncthingManager, useValue: { getState: () => ({ ...syncthing }) } },
        {
          provide: RemoteBindingsService,
          useValue: {
            list: async () => [
              { projectId: A, remoteId: 'vm', state: 'remote' },
              { projectId: B, remoteId: 'vm', state: 'remote' },
              { projectId: 'local-project', remoteId: 'vm', state: 'local' },
            ],
          },
        },
        { provide: RemoteFileSyncService, useValue: { upkeepState: () => null } },
        {
          provide: REMOTE_HEALTH_PORT,
          useValue: { getState: () => ({ online: true, versionMatches: true }) },
        },
        { provide: STORAGE_SERVICE, useValue: { listRemoteOperations: async () => [] } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    Object.assign(syncthing, { running: true, error: null });
    jest.restoreAllMocks();
  });

  it('answers one project with its folders for projectId and details=true', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/remotes/file-sync/status?projectId=${A}&details=true`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<FileSyncStatusResponse>();
    expect(body.links).toEqual([
      {
        remoteId: 'vm',
        connected: true,
        since: new Date(0).toISOString(),
        address: '127.0.0.1:22000',
        sentBytes: 0,
        receivedBytes: 0,
      },
    ]);
    expect(body.scopes).toEqual([
      {
        projectId: A,
        remoteId: 'vm',
        verdict: 'in-sync',
        reason: null,
        toVm: { items: 0, bytes: 0 },
        fromVm: { items: 0, bytes: 0 },
        failed: { home: 0, vm: null },
        files: 2,
        bytes: null,
        lastReceived: null,
        folders: ['code', 'git'].map((kind) =>
          expect.objectContaining({ id: `${kind}:${A}`, kind }),
        ),
      },
    ]);
  });

  it('answers 200 with only the project whose read failed unknown', async () => {
    const read = files.status.bind(files);
    jest
      .spyOn(files, 'status')
      .mockImplementation(async (folderId, ...rest) =>
        folderId === `code:${A}` ? Promise.reject(new Error('timeout')) : read(folderId, ...rest),
      );

    const response = await app.inject({ method: 'GET', url: '/api/remotes/file-sync/status' });

    expect(response.statusCode).toBe(200);
    const body = response.json<FileSyncStatusResponse>();
    expect(body.scopes.map(({ projectId, verdict }) => [projectId, verdict])).toEqual([
      [A, 'unknown'],
      [B, 'in-sync'],
    ]);
    expect(body.links).toEqual([expect.objectContaining({ remoteId: 'vm', connected: true })]);
  });

  it('answers 200 with every project unknown while Syncthing does not run', async () => {
    Object.assign(syncthing, { running: false, error: 'Syncthing is not installed' });

    const response = await app.inject({ method: 'GET', url: '/api/remotes/file-sync/status' });

    expect(response.statusCode).toBe(200);
    const body = response.json<FileSyncStatusResponse>();
    expect(body.syncthing).toEqual({
      running: false,
      version: 'v2.1.5',
      error: 'Syncthing is not installed',
    });
    expect(body.scopes.map(({ projectId, verdict }) => [projectId, verdict])).toEqual([
      [A, 'unknown'],
      [B, 'unknown'],
    ]);
  });

  it.each(['projectId=not-a-uuid', 'details=yes', 'other=1'])(
    'rejects the query %s with 400',
    async (query) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/remotes/file-sync/status?${query}`,
      });

      expect(response.statusCode).toBe(400);
    },
  );
});
