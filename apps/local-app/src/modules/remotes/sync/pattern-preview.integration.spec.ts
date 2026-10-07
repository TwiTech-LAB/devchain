import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { compileIgnorePattern } from '../../file-sync/ignore-pattern-matcher';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import type {
  SyncInspectRequest,
  SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { FileSyncFailuresService } from './file-sync-failures.service';
import { FileSyncPatternPreviewService } from './file-sync-pattern-preview.service';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';
import { ProjectFileSyncController } from './project-file-sync.controller';
import { RemoteFileSyncService } from './remote-file-sync.service';
import { RemoteLiveSyncService } from './remote-live-sync.service';
import type { ProjectPatternPreview } from './remote-file-sync.dto';

// HTTP integration is the cheapest layer that proves validation, status codes and real Git results together.
describe('connected project pattern preview route', () => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  const remoteId = '00000000-0000-4000-8000-000000000002';
  const url = `/api/projects/${projectId}/file-sync/pattern-preview`;
  let app: NestFastifyApplication;
  let inspector: SyncPathInspector;
  let directory: string;
  let homeRoot: string;
  let vmRoot: string;
  let projectRoot: string;
  let connected: boolean;
  const host = {
    syncInspect: jest.fn<Promise<SyncPathInspection>, [string, SyncInspectRequest]>(),
  };

  const repository = (root: string, count: number): void => {
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, '.gitignore'), '*.egg-info/\n!keep.egg-info/\n');
    mkdirSync(join(root, 'keep.egg-info'));
    mkdirSync(join(root, 'drop.egg-info'));
    writeFileSync(join(root, 'drop.egg-info/file'), 'ignored output');
    for (let index = 0; index < count; index++) {
      writeFileSync(join(root, `source${index}.egg-info`), 'tracked source');
      writeFileSync(join(root, 'keep.egg-info', `source${index}`), 'Git-kept source');
    }
    execFileSync('git', [
      '-C',
      root,
      'add',
      ...Array.from({ length: count }, (_, i) => `source${i}.egg-info`),
    ]);
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'devchain-pattern-preview-'));
    homeRoot = join(directory, 'home');
    vmRoot = join(directory, 'vm');
    repository(homeRoot, 7);
    repository(vmRoot, 2);
    const module = await Test.createTestingModule({
      controllers: [ProjectFileSyncController],
      providers: [
        FileSyncPatternPreviewService,
        SyncPathInspector,
        { provide: ProcessExecutor, useValue: new ChildProcessExecutor() },
        {
          provide: STORAGE_SERVICE,
          useValue: { getProject: async () => ({ rootPath: projectRoot }) },
        },
        {
          provide: RemoteBindingsService,
          useValue: { get: async () => (connected ? { state: 'remote', remoteId } : null) },
        },
        { provide: RemoteHostClient, useValue: host },
        { provide: RemoteLiveSyncService, useValue: {} },
        { provide: RemoteFileSyncService, useValue: {} },
        { provide: FileSyncSuggestionsService, useValue: {} },
        { provide: FileSyncFailuresService, useValue: {} },
      ],
    }).compile();
    inspector = module.get(SyncPathInspector);
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    connected = true;
    projectRoot = homeRoot;
    host.syncInspect
      .mockReset()
      .mockImplementation((_remote, request) =>
        inspector.inspect(vmRoot, request.scan, request.paths, request.patterns),
      );
  });

  afterAll(async () => {
    await app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('returns the matcher syntax error as 400 before requesting an inspection', async () => {
    const compiled = compileIgnorePattern('broken[');
    const response = await app.inject({ method: 'POST', url, payload: { pattern: 'broken[' } });
    expect(response.statusCode).toBe(400);
    expect(compiled.kind).toBe('error');
    if (compiled.kind === 'error') expect(response.json().message).toBe(compiled.error);
    expect(host.syncInspect).not.toHaveBeenCalled();
  });

  it('requires a connected binding and returns 409 before inspecting', async () => {
    connected = false;
    const response = await app.inject({ method: 'POST', url, payload: { pattern: '*.egg-info' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('FILE_SYNC_NOT_CONNECTED');
    expect(host.syncInspect).not.toHaveBeenCalled();
  });

  it('returns tracked and Git-kept counts from both sides, caps samples and forwards a pattern-only request', async () => {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: { pattern: ' *.egg-info ' },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<ProjectPatternPreview>();
    expect(result).toEqual({
      home: {
        state: 'checked',
        tracked: { count: 7, sample: Array.from({ length: 5 }, (_, i) => `source${i}.egg-info`) },
        kept: { count: 7, sample: Array.from({ length: 5 }, (_, i) => `keep.egg-info/source${i}`) },
      },
      vm: {
        state: 'checked',
        tracked: { count: 2, sample: ['source0.egg-info', 'source1.egg-info'] },
        kept: { count: 2, sample: ['keep.egg-info/source0', 'keep.egg-info/source1'] },
      },
    });
    expect(host.syncInspect).toHaveBeenCalledWith(remoteId, {
      path: homeRoot,
      scan: false,
      paths: [],
      patterns: ['*.egg-info'],
    });
  });

  it('preserves tracked counts when the inspector cannot return a complete file list', async () => {
    projectRoot = join(directory, 'many-tracked');
    repository(projectRoot, 51);
    const response = await app.inject({ method: 'POST', url, payload: { pattern: '*.egg-info' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().home).toEqual({
      state: 'checked',
      tracked: { count: 51, sample: [] },
      kept: {
        count: 51,
        sample: Array.from({ length: 51 }, (_, i) => `keep.egg-info/source${i}`)
          .sort()
          .slice(0, 5),
      },
    });
  });

  it('reports an unreachable VM without discarding home results', async () => {
    host.syncInspect.mockRejectedValueOnce(new Error('VM unavailable'));
    const response = await app.inject({ method: 'POST', url, payload: { pattern: '*.egg-info' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      home: { state: 'checked', tracked: { count: 7 }, kept: { count: 7 } },
      vm: { state: 'unavailable', tracked: null, kept: null },
    });
  });

  it.each(['home', 'vm'] as const)(
    'reports a reachable %s Git failure as error with unknown counts',
    async (side) => {
      const brokenRoot = join(directory, `broken-${side}`);
      repository(brokenRoot, 1);
      writeFileSync(join(brokenRoot, '.git/index'), 'corrupt index');
      if (side === 'home') projectRoot = brokenRoot;
      else
        host.syncInspect.mockImplementationOnce((_remote, request) =>
          inspector.inspect(brokenRoot, request.scan, request.paths, request.patterns),
        );
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { pattern: '*.egg-info' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()[side]).toEqual({ state: 'error', tracked: null, kept: null });
    },
  );

  it.each(['no-root', 'no-repo'] as const)(
    'preserves the %s state instead of claiming zero matches',
    async (state) => {
      projectRoot = join(directory, state);
      if (state === 'no-repo') mkdirSync(projectRoot);
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { pattern: '*.egg-info' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().home).toEqual({ state, tracked: null, kept: null });
    },
  );
});
