import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { SyncPathInspector, SYNC_PATH_FILESYSTEM } from '../../file-sync/sync-path-inspector';
import type {
  SyncInspectRequest,
  SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import { RemotesController } from '../controllers/remotes.controller';
import { RemotesService } from '../services/remotes.service';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';
import { FileSyncFailuresService } from './file-sync-failures.service';
import { FileSyncPatternPreviewService } from './file-sync-pattern-preview.service';
import type { FolderSyncStatus, SyncStatusOptions } from '../../file-sync/file-sync.dto';
import { FileSyncController } from '../../file-sync/file-sync.controller';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { GitService } from '../../git/services/git.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { ProjectReplicaApplier } from '../replica/project-replica.applier';
import { ProjectReplicaBuilder } from '../replica/project-replica.builder';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { ProjectFileSyncController } from './project-file-sync.controller';
import { RemoteFileSyncService } from './remote-file-sync.service';
import { GitOwnerStore } from '../git-owner.store';
import { RemoteLiveSyncService } from './remote-live-sync.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { SyncChownRequest, SyncChownResult } from '../../file-sync/sync-chown.dto';
import type { ExclusionSuggestion } from '../../file-sync/sync-path-inspection.dto';

// A small Nest app proves routing and validation with both real application services; no transfer is needed.
describe('project file sync settings routes', () => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  let app: NestFastifyApplication;
  let files: FakeFileSyncService;
  let root: string;
  const foreignPaths = new Set<string>();
  let operations: RemoteOperation[] = [];
  const remoteId = '00000000-0000-4000-8000-000000000002';
  const binding = { state: 'local', remoteId, projectId };
  const autoSettings = { enabled: true, actions: [] };
  const record = jest.fn();
  const readRevision = async () => {
    const current = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/file-sync/ignores`,
    });
    expect(current.statusCode).toBe(200);
    return current.json<{ revision: number }>().revision;
  };
  const host = {
    syncChown: jest
      .fn<Promise<SyncChownResult>, [string, SyncChownRequest]>()
      .mockResolvedValue({ user: null, items: [] }),
    syncDevice: jest.fn(async () => ({ deviceId: 'VM' })),
    syncInspect: jest
      .fn<Promise<SyncPathInspection>, [string, SyncInspectRequest]>()
      .mockRejectedValue(new Error('VM unavailable')),
    syncStatus: jest
      .fn<Promise<FolderSyncStatus>, [string, string, string?, SyncStatusOptions?]>()
      .mockRejectedValue(new Error('VM unavailable')),
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-project-suggestions-'));
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, '.gitignore'), 'logs/\n');
    writeFileSync(join(root, 'logs/file'), 'runtime');
    foreignPaths.add(join(root, 'logs/file'));
    files = new FakeFileSyncService();
    const module = await Test.createTestingModule({
      controllers: [ProjectFileSyncController, FileSyncController, RemotesController],
      providers: [
        RemoteFileSyncService,
        { provide: GitOwnerStore, useValue: { get: () => 'vm' } },
        {
          provide: FileSyncAutoFixStore,
          useValue: {
            get: () => autoSettings,
            setEnabled: (_id: string, enabled: boolean) => {
              autoSettings.enabled = enabled;
              return autoSettings;
            },
            record,
          },
        },
        { provide: RemotesService, useValue: {} },
        RemoteLiveSyncService,
        FileSyncSuggestionsService,
        FileSyncFailuresService,
        FileSyncPatternPreviewService,
        SyncPathInspector,
        {
          provide: SYNC_PATH_FILESYSTEM,
          useValue: {
            ...fs,
            lstat: async (path: string) =>
              Object.assign(await fs.lstat(path), { uid: foreignPaths.has(path) ? 0 : 1000 }),
          },
        },
        { provide: ProcessExecutor, useValue: new ChildProcessExecutor() },
        {
          provide: STORAGE_SERVICE,
          useValue: {
            getProject: async () => ({ id: projectId, rootPath: root }),
            listRemoteProjectBindings: async () => [binding],
            listRemoteOperations: async () => operations,
          },
        },
        { provide: FileSyncService, useValue: files },
        {
          provide: RemoteBindingsService,
          useValue: {
            list: async () => [],
            get: async () => (binding.state === 'local' ? null : binding),
          },
        },
        {
          provide: REMOTE_HEALTH_PORT,
          useValue: { getState: () => ({ online: true, versionMatches: true }) },
        },
        { provide: RemoteHostClient, useValue: host },
        { provide: ProjectReplicaApplier, useValue: {} },
        { provide: ProjectReplicaBuilder, useValue: {} },
        { provide: FileSyncManagedExclusionsStore, useValue: { get: () => [] } },
        { provide: GitService, useValue: {} },
        { provide: HomeGitGuardService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('gives only eligible VM paths through the connected queue, records the repair and retains the ignore list', async () => {
    const failures = app.get(FileSyncFailuresService);
    const vm = {
      path: 'migration.ts',
      kind: 'file' as const,
      owner: { uid: 0, name: 'root' },
      foreignOwner: true,
      foreignOwners: [],
      fileCount: 1,
      ignored: false,
      ignoreRule: null,
      ignoreRules: [],
      ignoredAncestor: null,
      tracked: false,
      trackedDescendants: [],
    };
    const group: ExclusionSuggestion = {
      path: vm.path,
      side: 'vm',
      owner: vm.owner,
      home: null,
      vm,
      fileCount: 1,
      reason: 'Written by root',
      reasonKind: 'foreignOwner',
      selected: false,
      patterns: ['(?d)/migration.ts'],
    };
    const failed = jest.spyOn(failures, 'failed').mockResolvedValue({
      installedPrefix: ['/.git'],
      ownerSide: 'vm',
      vmUser: { uid: 1001, name: 'alice' },
      home: { entries: [] },
      vm: { entries: [] },
      groups: [group],
      overLimit: false,
    });
    const queue = jest
      .spyOn(app.get(RemoteLiveSyncService), 'runExclusive')
      .mockImplementation(async (_id, work) => work(() => true));
    const list = files.getIgnores(projectId);
    const revision = await readRevision();
    binding.state = 'remote';
    host.syncChown.mockResolvedValueOnce({
      user: { uid: 1001, name: 'alice' },
      items: [{ path: 'migration.ts', state: 'repaired', paths: ['migration.ts'] }],
    });
    try {
      const result = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/file-sync/give-ownership`,
        payload: { paths: ['migration.ts', 'not-eligible'] },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().items).toEqual([
        expect.objectContaining({ path: 'migration.ts', state: 'repaired' }),
        expect.objectContaining({ path: 'not-eligible', state: 'refused' }),
      ]);
      expect(host.syncChown).toHaveBeenLastCalledWith(remoteId, {
        root,
        items: [{ path: 'migration.ts', mode: 'give' }],
      });
      expect(record).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ kind: 'chown', side: 'vm', paths: ['migration.ts'] }),
      );
      expect(files.getIgnores(projectId)).toEqual(list);
      expect(await readRevision()).toBe(revision);
      operations = [{ kind: 'force_sync', state: 'running' } as RemoteOperation];
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/file-sync/give-ownership`,
            payload: { paths: ['migration.ts'] },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      binding.state = 'local';
      operations = [];
      failed.mockRestore();
      queue.mockRestore();
    }
  });

  it.each(['force_sync', 'git_owner'] as const)(
    'refuses ignore saves during a persisted %s hold before storing the desired list',
    async (kind) => {
      const before = files.getIgnores(projectId);
      operations = [{ kind, state: 'failed' } as RemoteOperation];
      try {
        const result = await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/file-sync/ignores`,
          payload: { revision: await readRevision(), ignores: ['/blocked'] },
        });
        expect(result.statusCode).toBe(409);
        expect(result.json().message).toBe(
          'Force sync or a Git switch is running for this project. Save the list after it finishes.',
        );
        expect(files.getIgnores(projectId)).toEqual(before);
      } finally {
        operations = [];
      }
    },
  );

  it('rechecks the hold inside the live-sync queue before an earlier save changes ignores', async () => {
    const live = app.get(RemoteLiveSyncService);
    const before = files.getIgnores(projectId);
    const exclusive = jest.spyOn(live, 'runExclusive').mockImplementationOnce(async (_, work) => {
      operations = [{ kind: 'force_sync', state: 'running' } as RemoteOperation];
      return work(() => true);
    });
    try {
      const result = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/file-sync/ignores`,
        payload: { revision: await readRevision(), ignores: ['/queued'] },
      });
      expect(result.statusCode).toBe(409);
      expect(files.getIgnores(projectId)).toEqual(before);
    } finally {
      operations = [];
      exclusive.mockRestore();
    }
  });

  it('exposes the active warning classification through bindings', async () => {
    const service = app.get(RemoteFileSyncService);
    const warning = jest
      .spyOn(service, 'warning')
      .mockReturnValue('File sync could not finish updating this project.');
    const problem = jest.spyOn(service, 'problem').mockReturnValue('setup');
    binding.state = 'remote';
    try {
      const response = await app.inject({ method: 'GET', url: '/api/remotes/bindings' });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0]).toMatchObject({
        fileSyncWarning: 'File sync could not finish updating this project.',
        fileSyncProblem: 'setup',
      });
      binding.state = 'local';
      expect(
        (await app.inject({ method: 'GET', url: '/api/remotes/bindings' })).json().items[0],
      ).not.toHaveProperty('fileSyncProblem');
    } finally {
      binding.state = 'local';
      warning.mockRestore();
      problem.mockRestore();
    }
  });

  it('stores an unbound project through the new PUT and keeps the GET readable', async () => {
    const save = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/file-sync/ignores`,
      payload: { revision: await readRevision(), ignores: ['/runtime'] },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      ignores: ['/runtime'],
      revision: files.getIgnoresRevision(projectId),
      applied: false,
      message: 'Saved. The list applies at the next Connect.',
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/file-sync/projects/${projectId}/ignores`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      ignores: ['/runtime'],
      revision: files.getIgnoresRevision(projectId),
    });
  });

  it('reads the default-on preference and changes it separately from the ignore list', async () => {
    const url = `/api/projects/${projectId}/file-sync/auto-fix`;
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({
      enabled: true,
      actions: [],
    });
    const revision = files.getIgnoresRevision(projectId);
    const disabled = await app.inject({ method: 'PUT', url, payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({
      enabled: false,
      actions: [],
    });
    expect(files.getIgnoresRevision(projectId)).toBe(revision);
    expect(
      (await app.inject({ method: 'PUT', url, payload: { enabled: 'false' } })).statusCode,
    ).toBe(400);
  });

  it('refuses an invalid body before changing the desired list', async () => {
    files.setIgnores(projectId, ['/keep']);
    const result = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/file-sync/ignores`,
      payload: {
        revision: files.getIgnoresRevision(projectId),
        ignores: ['/changed'],
        type: 'sendonly',
      },
    });
    expect(result.statusCode).toBe(400);
    expect(files.getIgnores(projectId)).toEqual(['/keep']);
  });

  it('rejects a stale open draft after an automatic list write and rereads both GET routes', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/file-sync/ignores`,
    });
    const snapshot = first.json<{ ignores: string[]; revision: number }>();
    files.setIgnores(projectId, [...snapshot.ignores, '/automatic']);
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/file-sync/ignores`,
      payload: { ignores: ['/old-draft'], revision: snapshot.revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ message: 'The file list changed. Review it again.' });
    for (const url of [
      `/api/projects/${projectId}/file-sync/ignores`,
      `/api/file-sync/projects/${projectId}/ignores`,
    ]) {
      const read = await app.inject({ method: 'GET', url });
      expect(read.json()).toEqual({
        ignores: [...snapshot.ignores, '/automatic'],
        revision: snapshot.revision + 1,
      });
    }
  });

  it('returns home suggestions when the VM is unavailable without changing the desired list', async () => {
    files.setIgnores(projectId, []);
    const result = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/file-sync/suggestions`,
      payload: { remoteId },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      ownerSide: 'home',
      vm: 'unavailable',
      overLimit: false,
      groups: [{ path: 'logs', selected: true, pattern: '(?d)logs', patterns: ['(?d)logs'] }],
    });
    expect(host.syncInspect).toHaveBeenCalledWith(remoteId, {
      path: root,
      scan: true,
      paths: ['logs'],
    });
    expect(files.getIgnores(projectId)).toEqual([]);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/file-sync/suggestions`,
      payload: { remoteId, scan: true },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('scans the VM once, protects its staged files and inspects its new candidates at home', async () => {
    const vmRoot = mkdtempSync(join(tmpdir(), 'devchain-vm-suggestions-'));
    try {
      execFileSync('git', ['init', '-q', vmRoot]);
      mkdirSync(join(vmRoot, 'logs'));
      mkdirSync(join(vmRoot, 'clockwork'));
      writeFileSync(join(vmRoot, '.gitignore'), 'logs/\nclockwork/\n');
      writeFileSync(join(vmRoot, 'logs/keep'), 'staged only on VM');
      writeFileSync(join(vmRoot, 'clockwork/file'), 'runtime');
      foreignPaths.add(join(vmRoot, 'clockwork/file'));
      execFileSync('git', ['-C', vmRoot, 'add', '-f', 'logs/keep']);
      const inspector = app.get(SyncPathInspector);
      host.syncInspect
        .mockClear()
        .mockImplementation((_remote, request) =>
          inspector.inspect(vmRoot, request.scan, request.paths, request.patterns),
        );
      const result = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/file-sync/suggestions`,
        payload: { remoteId },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().groups).toEqual([
        expect.objectContaining({
          path: 'logs',
          selected: true,
          patterns: ['!/logs/keep', '(?d)logs'],
        }),
        expect.objectContaining({
          path: 'clockwork',
          side: 'vm',
          selected: false,
          home: expect.objectContaining({ kind: 'missing' }),
          patterns: [],
        }),
      ]);
      expect(host.syncInspect).toHaveBeenCalledTimes(2);
      expect(host.syncInspect).toHaveBeenCalledWith(remoteId, {
        path: root,
        scan: true,
        paths: ['logs'],
      });
    } finally {
      host.syncInspect.mockReset().mockRejectedValue(new Error('VM unavailable'));
      rmSync(vmRoot, { recursive: true, force: true });
    }
  });

  it('lists connected failed files with facts and reports an unreadable VM without failing the route', async () => {
    const url = `/api/projects/${projectId}/file-sync/failed`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409);
    const vmRoot = mkdtempSync(join(tmpdir(), 'devchain-vm-failures-'));
    const codeId = `code:${projectId}`;
    try {
      binding.state = 'remote';
      await files.ensureFolder({
        projectId,
        kind: 'code',
        type: 'sendreceive',
        peerDeviceId: 'VM',
        ignores: [],
      });
      const baseline = await files.status(codeId);
      const homeStatus = jest.spyOn(files, 'status').mockResolvedValue({
        ...baseline,
        errors: 1,
        fileErrors: [{ path: 'logs/file', error: 'permission denied' }],
      });
      execFileSync('git', ['init', '-q', vmRoot]);
      mkdirSync(join(vmRoot, 'logs'));
      writeFileSync(join(vmRoot, '.gitignore'), 'logs/\n');
      writeFileSync(join(vmRoot, 'logs/file'), 'VM staged');
      writeFileSync(join(vmRoot, 'logs/runtime'), 'runtime');
      execFileSync('git', ['-C', vmRoot, 'add', '-f', 'logs/file']);
      host.syncStatus.mockResolvedValueOnce({
        ...baseline,
        errors: 2,
        fileErrors: [
          { path: 'logs/file', error: 'chmod: operation not permitted' },
          { path: 'logs/runtime', error: 'permission denied' },
        ],
      });
      host.syncInspect.mockImplementation((_remote, request) =>
        app.get(SyncPathInspector).inspect(vmRoot, request.scan, request.paths, request.patterns),
      );
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        forceSync: {
          offered: false,
          reason: expect.any(String),
          pending: { fromVm: 0, fromHome: null },
        },
        ownerSide: 'vm',
        home: { entries: [{ path: 'logs/file', git: { state: 'repo', tracked: false } }] },
        vm: {
          entries: [
            { path: 'logs/file', git: { state: 'repo', tracked: true } },
            { path: 'logs/runtime', git: { ignored: true } },
          ],
        },
        groups: [
          {
            path: 'logs/file',
            patterns: [],
            chown: { vm: expect.stringContaining(`${vmRoot}/logs/file`) },
          },
          { path: 'logs/runtime', selected: true, patterns: ['(?d)/logs/runtime'] },
        ],
      });
      host.syncInspect.mockRejectedValue(new Error('VM unavailable'));
      const unavailable = await app.inject({ method: 'GET', url });
      expect(unavailable.statusCode).toBe(200);
      expect(unavailable.json()).toMatchObject({
        home: { entries: [{ path: 'logs/file', owner: { uid: expect.any(Number) } }] },
        vm: { entries: [], readError: "DevChain could not read the VM's errors." },
        groups: [{ path: 'logs/file', gitUnchecked: true, patterns: [] }],
      });
      homeStatus.mockRestore();
    } finally {
      binding.state = 'local';
      rmSync(vmRoot, { recursive: true, force: true });
    }
  });
});
