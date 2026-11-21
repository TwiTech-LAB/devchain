import { Test } from '@nestjs/testing';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { firstMatch } from '../../file-sync/ignore-pattern-matcher';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { SyncPathInspector, SYNC_PATH_FILESYSTEM } from '../../file-sync/sync-path-inspector';
import type { SyncInspectRequest } from '../../file-sync/sync-path-inspection.dto';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { projectAnchoredPath } from '../docker/docker-plan-files';
import {
  DockerAvailabilityError,
  DockerPlanSourceService,
} from '../docker/docker-plan-source.service';
import { DockerImportInventoryStore } from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { ManagedExclusionsCheckService } from './managed-exclusions-check.service';

describe('ManagedExclusionsCheckService', () => {
  const project = 'project';
  const remote = 'vm';
  const pattern = '/data/db';
  let root: string;
  let vm: string;
  let vmRoot: string;
  let inspector: SyncPathInspector;
  let service: ManagedExclusionsCheckService;
  const managed = jest.fn<string[], [string]>();
  const inventory = jest.fn();
  const health = jest.fn();
  const connect = jest.fn();
  const list = jest.fn();
  const compose = jest.fn();
  const dockerScan = jest.fn();
  const files = new FakeFileSyncService();
  let unavailableVmPath: string | undefined;
  const inspectVm = jest.fn(
    async (_remote: string, input: SyncInspectRequest, signal: AbortSignal) => {
      if (unavailableVmPath && input.paths.includes(unavailableVmPath))
        throw new Error('VM inspection unavailable');
      return inspector.inspect(vmRoot, input.scan, input.paths, undefined, undefined, {
        requestedTreesOnly: input.requestedTreesOnly,
        signal,
      });
    },
  );
  const owners = new Map<string, number>();
  let unreadable: string | undefined;
  const readdir = jest.fn(async (path: string) => {
    if (path === unreadable) throw Object.assign(new Error('Unreadable'), { code: 'EACCES' });
    return fs.readdir(path);
  });
  const homeMount = (path: string) =>
    list.mockResolvedValue([
      { Id: 'id', Names: ['/postgres'], Mounts: [{ Type: 'bind', Source: path }] },
    ]);
  const vmMount = (path: string) =>
    dockerScan.mockResolvedValue({
      containers: [{ name: 'postgres', mounts: [{ type: 'bind', source: path }] }],
    });
  const docker = (side: string) => ({ kind: 'docker', side, name: 'postgres' });
  const unchecked = (cause: string) => ({ kind: 'unchecked', cause });
  const permissions = (side: string) => ({ kind: 'permissions', side, owners: ['postgres'] });

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'exclusions-home-'));
    vm = await fs.mkdtemp(join(tmpdir(), 'exclusions-vm-'));
    for (const directory of [root, vm]) {
      await fs.mkdir(join(directory, 'data/db/.cache/locked'), { recursive: true });
      await fs.writeFile(join(directory, 'data/db/file'), '');
    }
    const module = await Test.createTestingModule({
      providers: [
        ManagedExclusionsCheckService,
        SyncPathInspector,
        { provide: FileSyncManagedExclusionsStore, useValue: { get: managed } },
        { provide: DockerImportInventoryStore, useValue: { get: inventory } },
        { provide: STORAGE_SERVICE, useValue: { getProject: async () => ({ rootPath: root }) } },
        { provide: REMOTE_HEALTH_PORT, useValue: { getState: health } },
        { provide: DockerPlanSourceService, useValue: { connect, compose } },
        { provide: RemoteHostClient, useValue: { dockerScan, syncInspect: inspectVm } },
        { provide: ProcessExecutor, useValue: {} },
        { provide: FileSyncService, useValue: files },
        {
          provide: SYNC_PATH_FILESYSTEM,
          useValue: {
            readdir,
            lstat: async (path: string) =>
              Object.assign(await fs.lstat(path), { uid: owners.get(path) ?? 1000 }),
            readFile: () => Promise.resolve('postgres:x:999:999::::'),
          },
        },
      ],
    }).compile();
    inspector = module.get(SyncPathInspector);
    service = module.get(ManagedExclusionsCheckService);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    managed.mockReturnValue([pattern]);
    inventory.mockReturnValue({
      items: [
        { name: 'old-db', bindPaths: [pattern] },
        { name: 'other', bindPaths: ['/unmanaged'] },
      ],
    });
    health.mockReturnValue({ online: true, versionMatches: true });
    connect.mockResolvedValue({ json: list });
    dockerScan.mockResolvedValue({ containers: [] });
    list.mockResolvedValue([]);
    compose.mockResolvedValue(null);
    vmRoot = vm;
    unavailableVmPath = undefined;
    owners.clear();
    unreadable = undefined;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([root, vm].map((path) => fs.rm(path, { recursive: true, force: true })));
  });

  it.each<{ label: string; setup: () => void; reason?: object }>([
    {
      label: 'equal home bind',
      setup: () => homeMount(join(root, 'data/db')),
      reason: docker('home'),
    },
    {
      label: 'VM bind inside the folder',
      setup: () => vmMount(join(root, 'data/db/log')),
      reason: docker('vm'),
    },
    {
      label: 'enclosing home bind',
      setup: () => homeMount(join(root, 'data')),
      reason: docker('home'),
    },
    { label: 'project-root bind', setup: () => homeMount(root) },
    { label: 'bind enclosing the checkout', setup: () => vmMount('/') },
    { label: 'sibling with a common prefix', setup: () => vmMount(join(root, 'data/db-copy')) },
    {
      label: 'profiled Compose service bind',
      setup: () =>
        compose.mockResolvedValue({
          name: 'stack',
          services: {
            postgres: { profiles: ['db'], volumes: [{ type: 'bind', source: './data/db' }] },
          },
        }),
      reason: docker('compose'),
    },
    {
      label: 'failed all-profile read',
      setup: () => compose.mockRejectedValue(new Error()),
      reason: unchecked('compose-mounts-unavailable'),
    },
    {
      label: 'absent home socket',
      setup: () => connect.mockRejectedValue(new DockerAvailabilityError('no-socket', 'missing')),
    },
    {
      label: 'inaccessible home socket',
      setup: () =>
        connect.mockRejectedValue(new DockerAvailabilityError('no-socket-access', 'denied')),
      reason: unchecked('home-mounts-unavailable'),
    },
    {
      label: 'foreign home file',
      setup: () => owners.set(join(root, 'data/db/file'), 999),
      reason: permissions('home'),
    },
    {
      label: 'foreign VM file',
      setup: () => owners.set(join(vm, 'data/db/file'), 999),
      reason: permissions('vm'),
    },
    {
      label: 'unreadable descendant',
      setup: () => {
        unreadable = join(root, 'data/db/.cache/locked');
      },
      reason: unchecked('home-inspection-incomplete'),
    },
    {
      label: 'retained parent later in stored order',
      setup: () => {
        managed.mockReturnValue([pattern, '/data']);
        owners.set(join(root, 'data'), 999);
      },
      reason: { kind: 'covered', by: '/data' },
    },
    {
      label: 'home read that never answers',
      setup: () => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10));
        list.mockReturnValue(new Promise(() => {}));
      },
      reason: unchecked('home-mounts-unavailable'),
    },
    {
      label: 'missing VM checkout',
      setup: () => {
        vmRoot = join(vm, 'missing');
      },
    },
    {
      label: 'offline VM',
      setup: () => health.mockReturnValue({ online: false }),
      reason: unchecked('offline'),
    },
    {
      label: 'rejected key',
      setup: () => health.mockReturnValue({ apiKeyRejected: true }),
      reason: unchecked('api-key-rejected'),
    },
    {
      label: 'incompatible VM',
      setup: () => health.mockReturnValue({ online: true, versionMatches: false }),
      reason: unchecked('version-mismatch'),
    },
  ])('$label', async ({ setup, reason }) => {
    setup();
    const [row] = await service.evaluate(project, remote);
    expect(row).toEqual({
      pattern,
      containers: ['old-db'],
      ...(reason ? { status: 'stays', reason } : { status: 'will-remove' }),
    });
    if (reason && 'kind' in reason && reason.kind === 'docker')
      expect(readdir).not.toHaveBeenCalled();
    if (compose.mock.calls.length) {
      const signal = connect.mock.calls[0][0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(compose).toHaveBeenCalledWith(root, { allProfiles: true, strict: true, signal });
      expect(dockerScan).toHaveBeenCalledWith(remote, [], { signal });
      if (list.mock.calls.length)
        expect(list).toHaveBeenCalledWith('GET', '/containers/json?all=true', undefined, {
          signal,
        });
      if (inspectVm.mock.calls.length)
        expect(inspectVm).toHaveBeenCalledWith(
          remote,
          { path: root, scan: false, paths: ['data/db'], requestedTreesOnly: true },
          signal,
        );
    }
    if (!reason) expect(readdir).not.toHaveBeenCalledWith(join(root, 'data'));
  });

  // The existing real inspector fixture catches rules that cover more than its literal walk.
  it.each([
    ['data*', 'database'],
    ['data?', 'data1'],
    ['data[12]', 'data1'],
    ['{data,cache}', 'cache'],
    ['data ', 'data'],
    ['cafe\u0301', 'café'],
  ])('retains the generated rule for %s and its enclosing exclusion', async (name, mounted) => {
    const generated = projectAnchoredPath(root, join(root, name));
    const nested = projectAnchoredPath(root, join(root, 'unmounted', name));
    managed.mockReturnValue([nested, '/unmounted', generated]);
    homeMount(join(root, mounted));
    expect(firstMatch([generated], `${mounted}/file`)).toMatchObject({
      kind: 'matched',
      ignored: true,
    });

    expect(await service.evaluate(project, remote)).toEqual([
      {
        pattern: nested,
        containers: [],
        status: 'stays',
        reason: unchecked('nonliteral-pattern'),
      },
      {
        pattern: '/unmounted',
        containers: [],
        status: 'stays',
        reason: unchecked('retained-descendant'),
      },
      {
        pattern: generated,
        containers: [],
        status: 'stays',
        reason: unchecked('nonliteral-pattern'),
      },
    ]);
  });

  it('keeps a known mount reason when a later read fails for the remaining folders', async () => {
    managed.mockReturnValue([pattern, '/other']);
    homeMount(join(root, 'data/db'));
    dockerScan.mockRejectedValue(new Error('VM unavailable'));
    expect(await service.evaluate(project, remote)).toEqual([
      { pattern, containers: ['old-db'], status: 'stays', reason: docker('home') },
      {
        pattern: '/other',
        containers: [],
        status: 'stays',
        reason: unchecked('vm-mounts-unavailable'),
      },
    ]);
    expect(compose).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('uses the first installed rule after all removable managed folders are removed', async () => {
    managed.mockReturnValue(['/data', pattern, '/other']);
    jest.spyOn(files, 'getIgnores').mockReturnValue(['!/data/db', '/data', 'other']);
    expect(await service.evaluate(project, remote)).toEqual([
      { pattern: '/data', containers: [], status: 'will-remove', remainingRule: '/data' },
      { pattern, containers: ['old-db'], status: 'will-remove' },
      { pattern: '/other', containers: [], status: 'will-remove', remainingRule: 'other' },
    ]);
  });

  it.each([
    { order: 'parent first', nested: ['/data', pattern] },
    { order: 'child first', nested: [pattern, '/data'] },
  ])('retains the parent of an unchecked child with $order', async ({ nested }) => {
    managed.mockReturnValue([...nested, '/data/logs', '/database']);
    unavailableVmPath = 'data/db';
    const rows = await service.evaluate(project, remote);
    expect(Object.fromEntries(rows.map(({ pattern, ...row }) => [pattern, row]))).toEqual({
      '/data': { status: 'stays', containers: [], reason: unchecked('retained-descendant') },
      '/data/db': {
        status: 'stays',
        containers: ['old-db'],
        reason: unchecked('vm-inspection-unavailable'),
      },
      '/data/logs': { status: 'stays', containers: [], reason: { kind: 'covered', by: '/data' } },
      '/database': { status: 'will-remove', containers: [] },
    });
  });
});
