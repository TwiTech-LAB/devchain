import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import type { SyncPathFacts, SyncPathInspection } from '../../file-sync/sync-path-inspection.dto';
import { FileSyncFailuresService } from './file-sync-failures.service';

// Service units test per-side list reduction and builder authority; Git and HTTP have their own tests.
const owner = { uid: 1000, name: 'alice' };
const denied = { path: 'logs', error: 'permission denied' };
const staged = { path: 'logs/staged.txt', error: 'chmod: operation not permitted' };
function fact(path: string, extra: Partial<SyncPathFacts> = {}): SyncPathFacts {
  return {
    path,
    kind: 'folder',
    owner,
    foreignOwner: false,
    foreignOwners: [],
    fileCount: 2,
    ignored: true,
    ignoreRule: { source: '.gitignore', line: 1, pattern: 'logs/' },
    ignoreRules: [{ source: '.gitignore', line: 1, pattern: 'logs/' }],
    ignoredAncestor: null,
    tracked: false,
    trackedDescendants: [],
    ...extra,
  };
}
function inspection(entries: SyncPathFacts[]): SyncPathInspection {
  return {
    rootPath: '/checkout',
    exists: true,
    repository: true,
    projectOwner: owner,
    gitState: 'repo',
    candidates: [],
    requestedPaths: ['logs', 'logs/staged.txt'],
    entries,
  };
}
function checked(inspection: SyncPathInspection, patterns: readonly string[]): SyncPathInspection {
  return {
    ...inspection,
    patternChecks: {
      state: 'checked',
      results: patterns.map((pattern) => ({
        pattern,
        tracked: { count: 0, files: [], complete: true },
        kept: { count: 0, sample: [] },
      })),
    },
  };
}
function setup() {
  const home = inspection([fact('logs'), fact(staged.path, { kind: 'file' })]);
  const vm = inspection([
    fact('logs', { ignored: false, trackedDescendants: [staged.path] }),
    fact(staged.path, {
      kind: 'file',
      ignored: false,
      tracked: true,
      owner: { uid: 48, name: 'apache' },
    }),
  ]);
  const files = {
    status: jest.fn(
      async () =>
        ({
          fileErrors: [
            denied,
            { ...denied, error: 'hashing: denied' },
            {
              path: 'transient',
              error: 'syncing: file modified but not rescanned; will try again later',
            },
          ],
        }) as FolderSyncStatus,
    ),
    getIgnores: () => [],
  };
  const host = {
    syncChown: jest.fn(),
    syncStatus: jest.fn(async () => ({ fileErrors: [denied, staged] }) as FolderSyncStatus),
    syncInspect: jest.fn(
      async (_remoteId: string, request: { patterns?: string[] }): Promise<SyncPathInspection> => ({
        ...checked(vm, request.patterns ?? []),
        vmUser: { uid: 1001, name: 'claimed-user' },
      }),
    ),
  };
  const inspector = {
    inspect: jest.fn(async (_root: string, _scan: boolean, _paths: string[], patterns?: string[]) =>
      checked(home, patterns ?? []),
    ),
  };
  const service = new FileSyncFailuresService(
    { getProject: async () => ({ rootPath: '/checkout' }) } as never,
    { get: async () => ({ state: 'remote', remoteId: 'r' }) } as never,
    files as never,
    host as never,
    inspector as never,
    { get: () => ['(?d)/container-output'] } as never,
  );
  return { service, files, host, inspector };
}

describe('FileSyncFailuresService', () => {
  it('uses the checkout owner when an older inspection has no claimed-user metadata', async () => {
    const s = setup();
    const legacy = await s.host.syncInspect('r', {});
    delete legacy.vmUser;
    s.host.syncInspect.mockResolvedValue(legacy);
    expect((await s.service.failed('p')).vmUser).toEqual(owner);
    expect(s.host.syncChown).not.toHaveBeenCalled();
  });
  it('classifies unique persistent failures per side with VM ignore authority and tracked repairs', async () => {
    const s = setup();
    const result = await s.service.failed('p');
    expect(result).toMatchObject({
      ownerSide: 'vm',
      vmUser: { uid: 1001, name: 'claimed-user' },
      installedPrefix: ['/.git', '(?d)/container-output'],
      overLimit: false,
      home: { entries: [{ ...denied, owner, git: { state: 'repo', ignored: true } }] },
      vm: {
        entries: [
          expect.objectContaining(denied),
          expect.objectContaining({
            ...staged,
            owner: { uid: 48, name: 'apache' },
            git: expect.objectContaining({ tracked: true }),
          }),
        ],
      },
      groups: [
        expect.objectContaining({
          path: 'logs',
          selected: false,
          patterns: [],
        }),
        expect.objectContaining({
          path: staged.path,
          patterns: [],
          chown: expect.objectContaining({ vm: "sudo chown -R alice '/checkout/logs/staged.txt'" }),
        }),
      ],
    });
    expect(result.home.readError).toBeUndefined();
    expect(result.vm.readError).toBeUndefined();
    expect(s.host.syncStatus).toHaveBeenCalledWith('r', 'code:p', undefined, { allErrors: true });
    expect(s.host.syncInspect).toHaveBeenNthCalledWith(1, 'r', {
      path: '/checkout',
      scan: false,
      paths: ['logs', staged.path],
    });
    expect(s.host.syncInspect).toHaveBeenCalledTimes(1);
    expect(s.host.syncChown).not.toHaveBeenCalled();
    expect(s.inspector.inspect).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'checks rules and literals on both sides and disables exclusions when checks fail=%s',
    async (unavailable) => {
      const s = setup();
      const paths = ['a.egg-info', 'b.egg-info'];
      const owner = inspection(
        paths.map((path) =>
          fact(path, {
            foreignOwner: true,
            ignoreRule: { source: '.gitignore', line: 1, pattern: '*.egg-info/' },
            ignoreRules: [{ source: '.gitignore', line: 1, pattern: '*.egg-info/' }],
          }),
        ),
      );
      owner.requestedPaths = paths;
      s.files.status.mockResolvedValue({
        fileErrors: paths.map((path) => ({ path, error: 'permission denied' })),
      } as FolderSyncStatus);
      s.host.syncStatus.mockResolvedValue({ fileErrors: [] } as unknown as FolderSyncStatus);
      s.inspector.inspect.mockImplementation(async (_root, _scan, _paths, patterns) =>
        checked(owner, patterns ?? []),
      );
      s.host.syncInspect.mockImplementation(async (_remoteId, request) => {
        if (unavailable && request.patterns) throw new Error('VM disappeared');
        return checked(owner, request.patterns ?? []);
      });
      const result = await s.service.failed('p');
      expect(result.groups.map((group) => group.patterns)).toEqual(
        unavailable ? [[], []] : [['(?d)*.egg-info']],
      );
      expect(result.home.entries.map((entry) => entry.path)).toEqual(paths);
      expect(s.host.syncInspect).toHaveBeenLastCalledWith('r', {
        path: '/checkout',
        scan: false,
        paths: [],
        patterns: expect.arrayContaining(['(?d)*.egg-info', '(?d)/a.egg-info', '(?d)/b.egg-info']),
      });
      expect(s.inspector.inspect).toHaveBeenLastCalledWith(
        '/checkout',
        false,
        [],
        expect.arrayContaining(['(?d)*.egg-info', '(?d)/a.egg-info', '(?d)/b.egg-info']),
      );
    },
  );

  it('returns installed prefixes without inspecting when no failed paths exist', async () => {
    const s = setup();
    s.files.status.mockResolvedValue({ fileErrors: [] } as unknown as FolderSyncStatus);
    s.host.syncStatus.mockResolvedValue({ fileErrors: [] } as unknown as FolderSyncStatus);
    const result = await s.service.failed('p');
    expect(result).toMatchObject({
      installedPrefix: ['/.git', '(?d)/container-output'],
      groups: [],
    });
    expect(s.inspector.inspect).not.toHaveBeenCalled();
    expect(s.host.syncInspect).not.toHaveBeenCalled();
  });

  it.each(['home-status', 'vm-status', 'home-inspect', 'vm-inspect'] as const)(
    'reports %s failure while retaining the readable side',
    async (failure) => {
      const s = setup();
      if (failure === 'home-status') s.files.status.mockRejectedValue(new Error('unavailable'));
      if (failure === 'vm-status') s.host.syncStatus.mockRejectedValue(new Error('unavailable'));
      if (failure === 'home-inspect')
        s.inspector.inspect.mockRejectedValue(new Error('unavailable'));
      if (failure === 'vm-inspect') s.host.syncInspect.mockRejectedValue(new Error('unavailable'));
      const result = await s.service.failed('p');
      const side = failure.startsWith('home') ? 'home' : 'vm';
      if (failure === 'vm-inspect') expect(result.vmUser).toBeUndefined();
      expect(s.host.syncChown).not.toHaveBeenCalled();
      expect(result[side].readError).toContain(
        failure.endsWith('status') ? 'could not read' : 'could not inspect',
      );
      expect(result[side === 'home' ? 'vm' : 'home'].entries[0]).toMatchObject({
        ...denied,
        owner,
      });
      if (failure.endsWith('inspect'))
        expect(result.groups.flatMap((group) => group.patterns)).toEqual([]);
      else expect(result[side].entries).toEqual([]);
    },
  );
});
