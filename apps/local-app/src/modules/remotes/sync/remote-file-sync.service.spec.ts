import type { ExclusionSuggestion } from '../../file-sync/sync-path-inspection.dto';
import { hostname } from 'node:os';
import type { GitOwner } from '../git-owner.store';
import { DEFAULT_FILE_SYNC_IGNORES } from '../../file-sync/file-sync.dto';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { RemoteFileSyncService } from './remote-file-sync.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { ProjectFileSyncFailures } from './remote-file-sync.dto';
import { SyncChownRequestSchema, type SyncChownResult } from '../../file-sync/sync-chown.dto';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Unit tests exercise lifecycle gates and retries; actual file survival uses real Syncthing below.
function setup() {
  const files = Object.assign(new FakeFileSyncService(), {
    folderPath: jest.fn(async () => '/checkout'),
  });
  const hostFiles = new FakeFileSyncService();
  files.gitProjects.add('p');
  const initial = {
    type: 'receiveonly' as const,
    paused: false,
    peerDeviceId: 'peer',
    ignores: [],
  };
  files.peers.add('peer');
  files.folders.set('code:p', initial);
  hostFiles.folders.set('code:p', { ...initial, type: 'sendonly' });
  const host = {
    syncFolderConfiguration: jest.fn((_: string, id: string) => hostFiles.folderConfiguration(id)),
    syncRevert: jest.fn((_: string, id: string) => hostFiles.revertLocalChanges(id)),
    installGitGuard: jest.fn(async () => ({ warning: null as string | null })),
    refreshGitIndex: jest.fn(async (_: string, _project: string, _since: string | null) => ({
      head: 'head1',
      refreshed: true,
      warning: null as string | null,
    })),
    syncDevice: jest.fn(async () => hostFiles.device()),
    syncPeer: jest.fn(async () => undefined),
    syncFolders: jest.fn((_: string, request: Parameters<typeof files.ensureFolder>[0]) =>
      hostFiles.ensureFolder(request),
    ),
    syncFolderType: jest.fn(
      (_: string, id: string, patch: Parameters<typeof files.updateFolder>[1]) =>
        hostFiles.updateFolder(id, patch),
    ),
    syncScan: jest.fn(async () => undefined),
    syncStatus: jest.fn((_: string, id: string, peer?: string) => hostFiles.status(id, peer)),
    syncChown: jest
      .fn<Promise<SyncChownResult>, [string, unknown]>()
      .mockResolvedValue({ user: null, items: [] }),
  };
  const binding = { state: 'remote', remoteId: 'r' };
  const health: { online: boolean; versionMatches: boolean; apiKeyRejected?: boolean } = {
    online: true,
    versionMatches: true,
  };
  const git = {
    mirroredHead: jest.fn(async () => 'head1'),
    refreshIndexFromHead: jest.fn(async () => undefined),
  };
  const guard = { install: jest.fn(async () => undefined) };
  const bindings = { get: jest.fn(async () => binding) };
  const storage = {
    listRemoteOperations: jest.fn<Promise<RemoteOperation[]>, []>().mockResolvedValue([]),
    getProject: jest.fn(async () => ({ rootPath: '/checkout' })),
  };
  const autoSettings = { enabled: true, actions: [] };
  const autoFix = { get: jest.fn(() => autoSettings), record: jest.fn() };
  const failures = {
    failed: jest
      .fn<Promise<Pick<ProjectFileSyncFailures, 'groups'> & Partial<ProjectFileSyncFailures>>, []>()
      .mockResolvedValue({ groups: [] }),
  };
  const owner = { value: 'vm' as GitOwner, generation: 0 };
  const service = new RemoteFileSyncService(
    files as never,
    host as never,
    bindings as never,
    { getState: () => health } as never,
    { get: () => ['/managed'] } as never,
    git as never,
    guard as never,
    storage as never,
    autoFix as never,
    failures as never,
    { get: () => owner.value, generation: () => owner.generation } as never,
  );
  const tick = (active = () => true) => service.tick('p', 'r', active);
  return {
    service,
    files,
    hostFiles,
    host,
    binding,
    bindings,
    health,
    git,
    guard,
    storage,
    autoSettings,
    autoFix,
    failures,
    tick,
    owner,
  };
}

it.each(['done', 'cancelled'] as const)(
  'resumes ordinary file upkeep after Force sync is %s',
  async (state) => {
    const s = setup();
    s.storage.listRemoteOperations.mockResolvedValue([
      { kind: 'force_sync', state } as RemoteOperation,
    ]);
    await s.tick();
    expect(s.host.syncDevice).toHaveBeenCalled();
    expect(s.host.syncFolderType).toHaveBeenCalled();
  },
);

describe('VM ownership repairs', () => {
  const start = Date.UTC(2026, 9, 5);
  const tracked = (path: string): ExclusionSuggestion => ({
    path,
    side: 'vm',
    owner: { uid: 0, name: 'root' },
    home: null,
    vm: null,
    fileCount: 1,
    reason: 'Written by root',
    reasonKind: 'foreignOwner',
    selected: false,
    patterns: [],
    chown: { vm: `sudo chown root ${path}` },
  });
  const failed = (path: string, vmTracked = true) => ({
    path,
    error: 'chmod: operation not permitted',
    owner: { uid: 0, name: 'root' },
    git: {
      state: 'repo' as const,
      tracked: vmTracked,
      ignored: false,
      ignoreRule: null,
      ignoredAncestor: null,
      trackedDescendants: [],
    },
  });
  beforeEach(() => jest.useFakeTimers().setSystemTime(start));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const at = (seconds: number) => jest.setSystemTime(start + seconds * 1000);
  const ready = async () => {
    const s = setup();
    s.files.gitProjects.clear();
    await s.tick();
    const status = await s.hostFiles.status('code:p');
    let count = 1;
    s.host.syncStatus.mockImplementation(async () => ({ ...status, errors: count }));
    s.failures.failed.mockResolvedValue({
      groups: [tracked('source.ts')],
      vm: { entries: [failed('source.ts')] },
    });
    s.host.syncChown.mockImplementation(async () => ({
      user: { uid: 1001, name: 'alice' },
      items: [{ path: 'source.ts', state: 'repaired', paths: ['source.ts'] }],
    }));
    await s.tick();
    return {
      ...s,
      setCount: (value: number) => {
        count = value;
      },
    };
  };
  it('repairs only failed VM tracked files, limits each file for ten minutes, and notes a second repair within an hour', async () => {
    const s = await ready();
    at(120);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledWith('r', {
      root: '/checkout',
      items: [{ path: 'source.ts', mode: 'automatic' }],
    });
    expect(s.autoFix.record).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ kind: 'chown', side: 'vm', paths: ['source.ts'] }),
    );
    s.setCount(2);
    at(150);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledTimes(1);
    at(750);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledTimes(2);
    expect(s.service.ownershipNotes('p')).toEqual([
      'A container keeps writing as another user in source.ts.',
    ]);
    s.setCount(3);
    at(780);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledTimes(2);
    at(750 + 3600);
    expect(s.service.ownershipNotes('p')).toEqual([]);
  });
  it('sends more than 200 failed files in one valid request and keeps the per-file retry gate', async () => {
    const s = await ready();
    const paths = Array.from({ length: 205 }, (_, index) => `source${index}.ts`);
    s.failures.failed.mockResolvedValue({
      groups: paths.map((path) => tracked(path)),
      vm: { entries: paths.map((path) => failed(path)) },
    });
    s.host.syncChown.mockResolvedValue({
      user: { uid: 1001, name: 'alice' },
      items: paths.map((path) => ({ path, state: 'repaired', paths: [path] })),
    });
    at(120);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledTimes(1);
    const request = s.host.syncChown.mock.calls[0][1];
    expect(SyncChownRequestSchema.parse(request)).toEqual({
      root: '/checkout',
      items: paths.map((path) => ({ path, mode: 'automatic' })),
    });
    expect(s.autoFix.record).toHaveBeenCalledTimes(2);
    expect(s.autoFix.record).toHaveBeenNthCalledWith(
      1,
      'p',
      expect.objectContaining({ kind: 'chown', side: 'vm', paths: paths.slice(0, 200) }),
    );
    expect(s.autoFix.record).toHaveBeenNthCalledWith(
      2,
      'p',
      expect.objectContaining({ kind: 'chown', side: 'vm', paths: paths.slice(200) }),
    );
    s.setCount(2);
    at(150);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledTimes(1);
  });
  it('does not infer VM tracking from a copy command and never sends home-only failures', async () => {
    const s = await ready();
    s.failures.failed.mockResolvedValue({
      groups: [tracked('source.ts')],
      vm: { entries: [failed('source.ts', false)] },
      home: { entries: [failed('home.ts')] },
    });
    at(120);
    await s.tick();
    expect(s.host.syncChown).not.toHaveBeenCalled();
  });
  it('attempts parent repair even when the failed tracked file already belongs to the VM user', async () => {
    const s = await ready();
    s.failures.failed.mockResolvedValue({
      groups: [tracked('code/source.ts')],
      vm: { entries: [{ ...failed('code/source.ts'), owner: { uid: 1001, name: 'alice' } }] },
    });
    s.host.syncChown.mockResolvedValue({
      user: { uid: 1001, name: 'alice' },
      items: [{ path: 'code/source.ts', state: 'repaired', paths: ['code'] }],
    });
    at(120);
    await s.tick();
    expect(s.host.syncChown).toHaveBeenCalledWith('r', {
      root: '/checkout',
      items: [{ path: 'code/source.ts', mode: 'automatic' }],
    });
    expect(s.autoFix.record).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ paths: ['code'] }),
    );
  });
  it.each(['unsupported', 'refused'] as const)(
    'preserves the copy command and failure warning when the host is %s',
    async (state) => {
      const s = await ready();
      const groups = [tracked('source.ts')];
      s.failures.failed.mockResolvedValue({ groups, vm: { entries: [failed('source.ts')] } });
      s.host.syncChown.mockResolvedValue({
        user: null,
        items: [{ path: 'source.ts', state, paths: [], reason: 'Use the copy command.' }],
      });
      at(120);
      await s.tick();
      expect(groups[0].chown?.vm).toBe('sudo chown root source.ts');
      expect(s.service.problem('p')).toBe('failed-files');
      expect(s.autoFix.record).not.toHaveBeenCalled();
    },
  );
});

describe('automatic exclusions', () => {
  const start = Date.UTC(2026, 9, 5);
  const group = (overrides: Partial<ExclusionSuggestion> = {}): ExclusionSuggestion => ({
    path: 'output',
    side: 'vm',
    owner: { uid: 0, name: 'root' },
    home: null,
    vm: null,
    fileCount: 1,
    reason: 'Written by root',
    reasonKind: 'foreignOwner',
    selected: true,
    patternChecksPassed: true,
    patterns: ['(?d)/output'],
    ...overrides,
  });
  const at = (seconds: number) => jest.setSystemTime(start + seconds * 1000);
  beforeEach(() => jest.useFakeTimers().setSystemTime(start));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const ready = async (groups: ExclusionSuggestion[]) => {
    const s = setup();
    s.files.gitProjects.clear();
    s.files.setIgnores('p', []);
    s.failures.failed.mockResolvedValue({ groups });
    await s.tick();
    const original = await s.hostFiles.status('code:p');
    let count = 1;
    s.host.syncStatus.mockImplementation(async () => ({ ...original, errors: count }));
    await s.tick();
    return {
      ...s,
      setCount: (value: number) => {
        count = value;
      },
    };
  };

  it('saves qualifying groups once in dialog order, records the additions and bounds reinspection', async () => {
    const s = await ready([
      group({ patterns: ['!/output/keep', '(?d)/output'] }),
      group({ path: 'cache', side: 'home', patterns: ['(?d)/cache'] }),
    ]);
    at(119);
    await s.tick();
    expect(s.failures.failed).not.toHaveBeenCalled();
    at(150);
    await s.tick();
    expect(s.files.getIgnores('p')).toEqual(['!/output/keep', '(?d)/output', '(?d)/cache']);
    expect(s.files.getIgnoresRevision('p')).toBe(2);
    expect(s.autoFix.record).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({
        kind: 'exclude',
        side: 'vm',
        patterns: ['!/output/keep', '(?d)/output'],
      }),
    );
    at(180);
    await s.tick();
    expect(s.failures.failed).toHaveBeenCalledTimes(1);
    s.setCount(2);
    at(210);
    await s.tick();
    expect(s.failures.failed).toHaveBeenCalledTimes(2);
    at(809);
    await s.tick();
    expect(s.failures.failed).toHaveBeenCalledTimes(2);
    at(840);
    await s.tick();
    expect(s.failures.failed).toHaveBeenCalledTimes(3);
    expect(s.files.getIgnoresRevision('p')).toBe(2);
    s.setCount(0);
    at(870);
    await s.tick();
    s.setCount(1);
    at(900);
    await s.tick();
    at(1020);
    await s.tick();
    expect(s.failures.failed).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'tracked',
      {
        home: {
          path: 'output',
          kind: 'file',
          owner: { uid: 0, name: 'root' },
          foreignOwner: true,
          foreignOwners: [],
          fileCount: 1,
          ignored: true,
          ignoreRule: null,
          ignoreRules: [],
          ignoredAncestor: null,
          tracked: true,
          trackedDescendants: [],
        },
      },
    ],
    ['not ignored', { selected: false }],
    ['not foreign', { reasonKind: 'untracked' }],
    ['blocked', { blockedBy: '!/output' }],
    ['unchecked Git', { gitUnchecked: true }],
    [
      'failed rule check',
      { pathCount: 2, pathSample: ['output', 'other'], patternChecksPassed: false },
    ],
    ['failed literal check', { patternChecksPassed: false }],
  ] as Array<[string, Partial<ExclusionSuggestion>]>)(
    'does not save %s groups',
    async (_name, overrides) => {
      const s = await ready([group(overrides)]);
      at(120);
      await s.tick();
      expect(s.files.getIgnores('p')).toEqual([]);
      expect(s.autoFix.record).not.toHaveBeenCalled();
    },
  );

  it('accepts a merged group only after its second pass succeeded', async () => {
    const s = await ready([
      group({
        pathCount: 2,
        pathSample: ['a.egg-info', 'b.egg-info'],
        patternChecksPassed: true,
        patterns: ['(?d)*.egg-info'],
      }),
    ]);
    at(120);
    await s.tick();
    expect(s.files.getIgnores('p')).toEqual(['(?d)*.egg-info']);
  });

  it('does nothing while disabled and reinspects when enabled', async () => {
    const s = await ready([group()]);
    s.autoSettings.enabled = false;
    at(120);
    await s.tick();
    expect(s.failures.failed).not.toHaveBeenCalled();
    expect(s.files.getIgnores('p')).toEqual([]);
    s.autoSettings.enabled = true;
    at(150);
    await s.tick();
    expect(s.files.getIgnores('p')).toEqual(['(?d)/output']);
  });

  it('keeps the warning and writes nothing when the complete list would exceed 200 lines', async () => {
    const s = await ready([group()]);
    const initial = Array.from({ length: 200 }, (_, index) => `/existing-${index}`);
    s.files.setIgnores('p', initial);
    const revision = s.files.getIgnoresRevision('p');
    at(120);
    await s.tick();
    expect(s.files.getIgnores('p')).toEqual(initial);
    expect(s.files.getIgnoresRevision('p')).toBe(revision);
    expect(s.service.problem('p')).toBe('failed-files');
    expect(s.autoFix.record).not.toHaveBeenCalled();
  });
});

// Unit service tests retain folder records; HTTP and real scans are covered by the two-instance lane.
describe('saving desired file sync ignores', () => {
  async function atStep(step: 'directions' | 'guard' | 'done') {
    const s = setup();
    if (step === 'directions') {
      const update = s.host.syncFolderType.getMockImplementation()!;
      s.host.syncFolderType.mockImplementation(async (...args) => {
        if (args[2].type === 'sendreceive') throw new Error('direction unavailable');
        return update(...args);
      });
      await s.tick();
      s.host.syncFolderType.mockImplementation(update);
    } else {
      if (step === 'guard') s.guard.install.mockRejectedValueOnce(new Error('guard unavailable'));
      await s.tick();
    }
    return s;
  }

  it('applies the managed/user union to the VM before home', async () => {
    const s = await atStep('done');
    const [started, gate] = [deferred(), deferred()];
    const update = s.host.syncFolderType.getMockImplementation()!;
    s.host.syncFolderType.mockImplementationOnce(async (...args) => {
      started.resolve();
      await gate.promise;
      return update(...args);
    });
    const saved = s.service.saveIgnores('p', ['!/managed', '/runtime'], () => true);
    await started.promise;
    expect(s.files.getIgnores('p')).toEqual(['!/managed', '/runtime']);
    expect(s.files.folders.get('code:p')!.ignores).not.toContain('/runtime');
    gate.resolve();
    await expect(saved).resolves.toMatchObject({ applied: true });
    for (const files of [s.files, s.hostFiles]) {
      expect(files.folders.get('code:p')!.ignores).toEqual([
        '/.git',
        '/managed',
        '!/managed',
        '/runtime',
      ]);
    }
  });

  it.each([undefined, 0, 2])(
    'restarts only sides with positive pullErrors (%s)',
    async (pullErrors) => {
      const s = await atStep('done');
      const vmStatus = await s.hostFiles.status('code:p');
      s.host.syncStatus.mockResolvedValue({ ...vmStatus, errors: 3, pullErrors });
      const read = s.files.status.bind(s.files);
      jest
        .spyOn(s.files, 'status')
        .mockImplementation(async (...args) => ({ ...(await read(...args)), pullErrors }));
      const homePatch = jest.spyOn(s.files, 'updateFolder');
      s.host.syncFolderType.mockClear();
      const result = await s.service.saveIgnores('p', ['/runtime'], () => true);
      expect(result).toMatchObject({ applied: true, revision: 1 });
      const expected = pullErrors ? [{ paused: true }, { paused: false }] : [];
      expect(
        s.host.syncFolderType.mock.calls
          .map((call) => call[2])
          .filter((patch) => patch.paused !== undefined),
      ).toEqual(expected);
      expect(
        homePatch.mock.calls.map((call) => call[1]).filter((patch) => patch.paused !== undefined),
      ).toEqual(expected);
      if (pullErrors)
        expect(s.host.syncFolderType.mock.invocationCallOrder.at(-1)).toBeLessThan(
          homePatch.mock.invocationCallOrder[0],
        );
    },
  );

  it('resumes after a failed pause and preserves the applied save result', async () => {
    const s = await atStep('done');
    s.host.syncStatus.mockResolvedValue({ ...(await s.hostFiles.status('code:p')), pullErrors: 1 });
    const patch = s.host.syncFolderType.getMockImplementation()!;
    s.host.syncFolderType.mockImplementation(async (...args) => {
      if (args[2].paused === true) throw new Error('lost response');
      return patch(...args);
    });
    await expect(s.service.saveIgnores('p', ['/runtime'], () => true)).resolves.toMatchObject({
      ignores: ['/runtime'],
      applied: true,
    });
    expect(s.host.syncFolderType).toHaveBeenCalledWith('r', 'code:p', { paused: false });
    expect(s.files.folders.get('code:p')!.ignores).toContain('/runtime');
  });

  it('keeps a failed resume owed and completes it on later ticks', async () => {
    const s = await atStep('done');
    s.host.syncStatus.mockResolvedValue({ ...(await s.hostFiles.status('code:p')), pullErrors: 1 });
    const patch = s.host.syncFolderType.getMockImplementation()!;
    let lostResumes = 2;
    s.host.syncFolderType.mockImplementation(async (...args) => {
      if (args[2].paused === false && lostResumes-- > 0) throw new Error('network down');
      return patch(...args);
    });
    await expect(s.service.saveIgnores('p', ['/runtime'], () => true)).resolves.toMatchObject({
      applied: true,
    });
    expect(s.hostFiles.folders.get('code:p')!.paused).toBe(true);
    await s.tick();
    expect(s.hostFiles.folders.get('code:p')!.paused).toBe(true);
    await s.tick();
    expect(s.hostFiles.folders.get('code:p')!.paused).toBe(false);
    const resumes = s.host.syncFolderType.mock.calls.filter((call) => call[2].paused === false);
    await s.tick();
    expect(s.host.syncFolderType.mock.calls.filter((call) => call[2].paused === false)).toEqual(
      resumes,
    );
  });

  it('unpauses a code folder that a home restart left paused', async () => {
    const s = setup();
    s.hostFiles.folders.get('code:p')!.paused = true;
    s.files.folders.get('code:p')!.paused = true;
    await s.tick();
    expect(s.hostFiles.folders.get('code:p')!.paused).toBe(false);
    expect(s.files.folders.get('code:p')!.paused).toBe(false);
  });

  const retries = (['directions', 'guard', 'done'] as const).flatMap((step) =>
    (['vm', 'home', 'missing-home', 'offline', 'key', 'version', 'binding'] as const).map(
      (failure) => ({ step, failure }),
    ),
  );
  it.each(retries)('retries the stored list after $failure at $step', async ({ step, failure }) => {
    const s = await atStep(step);
    if (failure === 'vm') s.host.syncFolderType.mockRejectedValueOnce(new Error('VM failed'));
    if (failure === 'home' || failure === 'missing-home') {
      jest
        .spyOn(s.files, 'updateFolder')
        .mockRejectedValueOnce(
          failure === 'missing-home'
            ? new SyncthingRestError('missing folder', { path: '/rest/db/ignores', status: 404 })
            : new Error('home failed'),
        );
    }
    if (failure === 'offline') s.health.online = false;
    if (failure === 'key') s.health.apiKeyRejected = true;
    if (failure === 'version') s.health.versionMatches = false;
    if (failure === 'binding') s.bindings.get.mockRejectedValueOnce(new Error('store read failed'));
    const result = await s.service.saveIgnores('p', ['/runtime'], () => true);
    expect(result.applied).toBe(false);
    expect(result.message).toMatch(/Saved, not applied yet: .+; DevChain applies it automatically/);
    if (failure === 'missing-home') expect(result.message).toContain('folder is not shared');
    expect(s.files.getIgnores('p')).toEqual(['/runtime']);
    s.health.online = s.health.versionMatches = true;
    s.health.apiKeyRejected = false;
    await s.tick();
    for (const files of [s.files, s.hostFiles]) {
      expect(files.folders.get('code:p')).toMatchObject({
        type: 'sendreceive',
        ignores: ['/.git', '/managed', '/runtime'],
      });
    }
    expect(s.guard.install).toHaveBeenCalled();
  });

  it.each(['absent', 'create', 'settle', 'ignores'] as const)(
    'preserves setup at %s and pushes the newest list later',
    async (step) => {
      const s = setup();
      if (step === 'create') jest.spyOn(s.files, 'projectFolders').mockResolvedValueOnce([]);
      if (step === 'settle') s.files.need.set('git:p', { needItems: 1, needBytes: 1 });
      if (step === 'ignores')
        s.host.syncFolderType.mockRejectedValueOnce(new Error('ignores unavailable'));
      if (step !== 'absent') await s.tick();
      s.health.online = false;
      await s.service.saveIgnores('p', ['/runtime'], () => true);
      expect(s.files.folders.get('code:p')!.ignores).not.toContain('/runtime');
      s.files.need.clear();
      s.health.online = true;
      await s.tick();
      expect(s.files.folders.get('git:p')).toMatchObject({ type: 'receiveonly' });
      expect(s.hostFiles.folders.get('git:p')).toMatchObject({ type: 'sendonly' });
      expect(s.guard.install).toHaveBeenCalledWith('p', 'r');
      expect(s.files.folders.get('code:p')!.ignores).toContain('/runtime');
      expect(s.hostFiles.folders.get('code:p')!.ignores).toContain('/runtime');
    },
  );

  it('waits for git setup to settle even when the VM is healthy', async () => {
    const s = setup();
    s.files.need.set('git:p', { needItems: 1, needBytes: 1 });
    await s.tick();
    await expect(s.service.saveIgnores('p', ['/runtime'], () => true)).resolves.toMatchObject({
      applied: false,
    });
    expect(s.hostFiles.folders.get('code:p')!.ignores).not.toContain('/.git');
    s.files.need.clear();
    await s.tick();
    expect(s.hostFiles.folders.get('code:p')!.ignores).toContain('/runtime');
  });

  it.each(['unbound', 'attaching', 'detaching', 'not-running'] as const)(
    'only stores during %s',
    async (state) => {
      const s = setup();
      if (state === 'unbound') s.bindings.get.mockResolvedValue(null as never);
      else if (state !== 'not-running') s.binding.state = state;
      await expect(
        s.service.saveIgnores('p', ['/runtime'], () => state !== 'not-running'),
      ).resolves.toMatchObject({ applied: false });
      expect(s.files.getIgnores('p')).toEqual(['/runtime']);
      expect(s.hostFiles.folders.get('code:p')!.ignores).toEqual([]);
    },
  );

  it('restores defaults and applies them live', async () => {
    const s = await atStep('done');
    s.files.setIgnores('p', ['/runtime']);
    await expect(s.service.saveIgnores('p', null, () => true)).resolves.toMatchObject({
      applied: true,
      ignores: DEFAULT_FILE_SYNC_IGNORES,
    });
    expect(s.hostFiles.folders.get('code:p')!.ignores).toEqual([
      '/.git',
      '/managed',
      ...DEFAULT_FILE_SYNC_IGNORES,
    ]);
  });
});

describe('remote file maintenance', () => {
  // The fake folder records expose the sender's survival and receiver-only network work.
  it('restores saved PC ownership after restart without reverting or guarding its Git', async () => {
    const s = setup();
    s.owner.value = 'home';
    s.files.receiveOnlyChanges.set('git:p', { count: 1, sample: ['refs/heads/local-commit'] });
    s.hostFiles.receiveOnlyChanges.set('git:p', { count: 1, sample: ['refs/heads/vm-edit'] });
    const homeRevert = jest.spyOn(s.files, 'revertLocalChanges');
    const homeEnsure = jest.spyOn(s.files, 'ensureFolder');
    await s.tick();
    expect(s.host.syncRevert).toHaveBeenCalledWith('r', 'git:p');
    expect(s.files.receiveOnlyChanges.get('git:p')).toEqual({
      count: 1,
      sample: ['refs/heads/local-commit'],
    });
    expect(s.guard.install).not.toHaveBeenCalled();
    await s.tick();
    s.service.forget('p');
    await s.tick();
    expect(s.files.folders.get('git:p')).toMatchObject({ type: 'sendonly', paused: false });
    expect(s.hostFiles.folders.get('git:p')).toMatchObject({ type: 'receiveonly', paused: false });
    expect(s.host.syncFolders.mock.invocationCallOrder[0]).toBeLessThan(
      homeEnsure.mock.invocationCallOrder[0],
    );
    expect(s.host.installGitGuard).toHaveBeenLastCalledWith('r', 'p', {
      homeName: hostname(),
      reason: 'pc-git',
    });
    expect(s.guard.install).not.toHaveBeenCalled();
    expect(homeRevert).not.toHaveBeenCalled();
    expect(s.git.refreshIndexFromHead).not.toHaveBeenCalled();
    expect(s.service.warning('p')).toBeNull();
  });

  it('rebuilds the VM index once per synced HEAD, retries warnings and reverts only idle VM Git', async () => {
    const s = setup();
    s.owner.value = 'home';
    await s.tick();
    s.host.refreshGitIndex.mockResolvedValueOnce({
      head: 'head1',
      refreshed: false,
      warning: 'index locked',
    });
    await s.tick();
    expect(s.service.warning('p')).toBe('index locked');
    await s.tick();
    expect(s.host.refreshGitIndex).toHaveBeenNthCalledWith(2, 'r', 'p', null);
    await s.tick();
    expect(s.host.refreshGitIndex).toHaveBeenCalledTimes(2);
    s.git.mirroredHead.mockResolvedValue('head2');
    s.host.refreshGitIndex.mockResolvedValue({ head: 'head2', refreshed: true, warning: null });
    await s.tick();
    await s.tick();
    expect(s.host.refreshGitIndex).toHaveBeenCalledTimes(3);
    expect(s.host.refreshGitIndex).toHaveBeenLastCalledWith('r', 'p', 'head1');
    const read = s.hostFiles.status.bind(s.hostFiles);
    s.hostFiles.receiveOnlyChanges.set('git:p', { count: 1, sample: ['refs/heads/vm-edit'] });
    s.host.syncStatus.mockImplementation(async (...args) => ({
      ...(await read(args[1], args[2])),
      state: 'scanning',
    }));
    await s.tick();
    expect(s.host.syncRevert).not.toHaveBeenCalled();
    s.host.syncStatus.mockImplementation((_: string, id: string, peer?: string) => read(id, peer));
    s.hostFiles.folders.get('git:p')!.paused = true;
    await s.tick();
    expect(s.host.syncRevert).not.toHaveBeenCalled();
    s.hostFiles.folders.get('git:p')!.paused = false;
    await s.tick();
    expect(s.host.syncRevert).toHaveBeenCalledTimes(1);
    expect(s.hostFiles.receiveOnlyChanges.has('git:p')).toBe(false);
    expect(s.git.refreshIndexFromHead).not.toHaveBeenCalled();
    expect(s.service.warning('p')).toBeNull();
  });

  it('gates all work by ownership, health version, and the live lifecycle', async () => {
    const s = setup();
    for (const state of ['attaching', 'detaching', 'failed']) {
      s.binding.state = state;
      await s.tick();
    }
    s.binding.state = 'remote';
    s.health.versionMatches = false;
    await s.tick();
    s.health.versionMatches = true;
    s.health.apiKeyRejected = true;
    await s.tick();
    s.health.apiKeyRejected = false;
    await s.tick(() => false);
    expect(s.host.syncFolders).not.toHaveBeenCalled();
  });

  it('moves Git first, applies system ignores before user negations and changes host code first', async () => {
    const s = setup();
    s.files.setIgnores('p', ['!/.git', '!/managed']);
    await s.tick();
    expect(s.files.folders.get('git:p')).toMatchObject({
      type: 'receiveonly',
      ignores: ['*.lock', '/hooks', '/index'],
    });
    expect(s.hostFiles.folders.get('git:p')).toMatchObject({ type: 'sendonly' });
    for (const files of [s.files, s.hostFiles]) {
      expect(files.folders.get('code:p')).toMatchObject({
        type: 'sendreceive',
        ignores: ['/.git', '/managed', '!/.git', '!/managed'],
      });
    }
    expect(s.guard.install).toHaveBeenCalledWith('p', 'r');
    expect(s.git.refreshIndexFromHead).not.toHaveBeenCalled();
  });

  it('only reverts idle receive-only Git; index refresh runs once per mirrored HEAD', async () => {
    const s = setup();
    const revert = jest.spyOn(s.files, 'revertLocalChanges');
    await s.tick();
    await s.tick();
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(1);
    s.git.mirroredHead.mockResolvedValue('head2');
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
    const status = await s.files.status('git:p');
    const statusSpy = jest
      .spyOn(s.files, 'status')
      .mockResolvedValue({ ...status, receiveOnlyChangedFiles: 1, state: 'scanning' });
    await s.tick();
    expect(revert).not.toHaveBeenCalled();
    statusSpy.mockResolvedValue({ ...status, receiveOnlyChangedFiles: 1 });
    s.files.folders.get('git:p')!.type = 'sendreceive';
    await s.tick();
    expect(revert).not.toHaveBeenCalled();
    s.files.folders.get('git:p')!.type = 'receiveonly';
    await s.tick();
    expect(revert).toHaveBeenCalledWith('git:p');
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the receiver index after a take and a return bring back the old HEAD', async () => {
    const s = setup();
    await s.tick();
    await s.tick();
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(1);
    // Take, commit on the PC and return, all between two ticks; the VM then checks out head1 again.
    s.owner.generation += 2;
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
  });

  it('keeps a guard skip warning visible after successful upkeep', async () => {
    const s = setup();
    s.guard.install.mockResolvedValue('Custom hooksPath: guard was skipped' as never);
    await s.tick();
    await s.tick();
    expect(s.service.warning('p')).toContain('guard was skipped');
  });

  it('retries an index refresh failure and ignores an unborn HEAD', async () => {
    const s = setup();
    await s.tick();
    s.git.refreshIndexFromHead.mockRejectedValueOnce(new Error('index locked'));
    await s.tick();
    expect(s.service.warning('p')).toContain('retry automatically');
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
    expect(s.service.warning('p')).toBeNull();
    s.git.mirroredHead.mockResolvedValue(null as never);
    await s.tick();
    expect(s.git.refreshIndexFromHead).toHaveBeenCalledTimes(2);
  });

  it('replays an interrupted migration after losing its in-memory progress', async () => {
    const s = setup();
    s.guard.install.mockRejectedValueOnce(new Error('busy'));
    await s.tick();
    s.service.forget('p');
    await s.tick();
    expect(s.guard.install).toHaveBeenCalledTimes(2);
    expect(s.files.folders.get('code:p')?.type).toBe('sendreceive');
    expect(s.service.warning('p')).toBeNull();
  });

  it.each(['create', 'ignores', 'directions', 'guard'])(
    'retries failed %s without reverting code',
    async (step) => {
      const s = setup();
      const revert = jest.spyOn(s.files, 'revertLocalChanges');
      if (step === 'create') s.host.syncFolders.mockRejectedValueOnce(new Error('offline'));
      else if (step === 'guard') s.guard.install.mockRejectedValueOnce(new Error('filesystem'));
      else {
        const update = s.host.syncFolderType.getMockImplementation()!;
        let failed = false;
        s.host.syncFolderType.mockImplementation(async (...args) => {
          if (
            !failed &&
            args[1] === 'code:p' &&
            (step === 'ignores' ? args[2].ignores : args[2].type)
          ) {
            failed = true;
            throw new Error('offline');
          }
          return update(...args);
        });
      }
      await s.tick();
      expect(s.service.warning('p')).toContain('retry automatically');
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(s.files.folders.get('code:p')?.type).toBe('sendreceive');
      expect(s.guard.install).toHaveBeenCalledTimes(step === 'guard' ? 2 : 1);
      expect(revert).not.toHaveBeenCalledWith('code:p');
    },
  );

  it('does not switch code before Git settles, and stops before subsequent migration steps', async () => {
    const s = setup();
    const read = s.files.status.bind(s.files);
    jest
      .spyOn(s.files, 'status')
      .mockImplementation(async (...args) => ({ ...(await read(...args)), needTotalItems: 1 }));
    await s.tick();
    expect(s.files.folders.get('code:p')?.type).toBe('receiveonly');
    expect(s.service.warning('p')).toContain('settling');
    let active = true;
    s.files.status = async (...args) => {
      active = false;
      return read(...args);
    };
    await s.tick(() => active);
    expect(s.guard.install).not.toHaveBeenCalled();
  });
});

// Unit tests keep elapsed-time boundaries deterministic without waiting on network transfers.
describe('connected file sync checks', () => {
  const start = new Date(2026, 8, 28, 16, 15).getTime();
  beforeEach(() => jest.useFakeTimers().setSystemTime(start));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const at = (seconds: number) => jest.setSystemTime(start + seconds * 1000);
  const ready = async (hasGit = true) => {
    const s = setup();
    if (!hasGit) s.files.gitProjects.clear();
    await s.tick();
    return s;
  };

  it.each(['home', 'vm'] as const)(
    'warns about %s failed files only after grace and clears the count on recovery',
    async (side) => {
      const s = await ready();
      const source = side === 'home' ? s.files : s.hostFiles;
      const read = source.status.bind(source);
      let count = 4;
      jest.spyOn(source, 'status').mockImplementation(async (...args) => ({
        ...(await read(...args)),
        ...(args[0] === 'code:p' ? { errors: count } : {}),
      }));
      await s.tick();
      at(90);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(s.service.failedCounts('p')).toBeNull();
      expect(s.service.problem('p')).toBeNull();
      at(120);
      await s.tick();
      expect(s.service.warning('p')).toBe(
        `4 files on ${side === 'vm' ? 'the VM' : 'this PC'} fail to sync since 16:15.`,
      );
      expect(s.service.problem('p')).toBe('failed-files');
      expect(s.service.failedCounts('p')).toEqual({
        home: side === 'home' ? 4 : 0,
        vm: side === 'vm' ? 4 : 0,
      });
      count = 0;
      at(150);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(s.service.failedCounts('p')).toBeNull();
    },
  );

  it('retains VM failures and their original time across failed VM status reads', async () => {
    const s = await ready(false);
    const status = await s.hostFiles.status('code:p');
    s.host.syncStatus.mockResolvedValue({ ...status, errors: 7 });
    await s.tick();
    s.host.syncStatus.mockRejectedValue(new Error('VM status unavailable'));
    at(120);
    await s.tick();
    expect(s.service.warning('p')).toBe('7 files on the VM fail to sync since 16:15.');
    expect(s.service.failedCounts('p')).toEqual({ home: 0, vm: 7 });
    at(150);
    await s.tick();
    expect(s.service.warning('p')).toBe('7 files on the VM fail to sync since 16:15.');
    s.host.syncStatus.mockResolvedValue(status);
    at(180);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    expect(s.service.failedCounts('p')).toBeNull();
  });

  it.each([true, false])(
    'debounces disconnection and clears at recovery (git: %s)',
    async (hasGit) => {
      const s = await ready(hasGit);
      const connected = jest.spyOn(s.files, 'isConnected').mockResolvedValue(false);
      await s.tick();
      at(90);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      at(120);
      await s.tick();
      expect(s.service.warning('p')).toContain('No file sync connection to the VM since 16:15');
      expect(s.service.problem('p')).toBe('connection');
      expect(connected).toHaveBeenCalledWith('peer');
      expect(connected).not.toHaveBeenCalledWith(s.files.deviceId);
      connected.mockResolvedValue(true);
      at(150);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      connected.mockResolvedValue(false);
      at(180);
      await s.tick();
      connected.mockResolvedValue(true);
      at(270);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      connected.mockResolvedValue(false);
      at(300);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
    },
  );

  it.each([
    ['paused', {}, true, 'folder is paused'],
    ['state', { state: 'error' }, false, 'folder is in an error state'],
    ['message', { error: 'permission denied' }, false, 'permission denied'],
    ['count', { errors: 3 }, false, '3 files failed'],
  ] as const)(
    'debounces a folder %s problem using the check clock',
    async (_name, patch, paused, text) => {
      const s = await ready();
      const read = s.files.status.bind(s.files);
      const status = jest.spyOn(s.files, 'status').mockImplementation(async (...args) => ({
        ...(await read(...args)),
        ...(args[0] === 'git:p' ? { ...patch, ...(paused ? { state: '' } : {}) } : {}),
      }));
      s.files.folders.get('git:p')!.paused = paused;
      await s.tick();
      at(90);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      at(120);
      await s.tick();
      expect(s.service.warning('p')).toBe(`File sync at home has an error since 16:15: ${text}.`);
      expect(s.service.problem('p')).toBe(_name === 'count' ? 'failed-files' : 'error');
      status.mockRestore();
      s.files.folders.get('git:p')!.paused = false;
      at(150);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
    },
  );

  it.each(['code:p', 'git:p', 'peer'])('detects and clears stalled %s items', async (side) => {
    const s = await ready();
    let count = 12;
    const read = s.files.status.bind(s.files);
    jest.spyOn(s.files, 'status').mockImplementation(async (...args) => {
      const status = await read(...args);
      if (side === 'peer' && status.peer) status.peer.needItems = count;
      else if (args[0] === side) status.needTotalItems = count;
      return status;
    });
    await s.tick();
    at(570);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    at(600);
    await s.tick();
    expect(s.service.warning('p')).toContain(
      side === 'peer' ? 'The VM has not received 12' : 'This PC has not received 12',
    );
    expect(s.service.warning('p')).toContain('since 16:15');
    expect(s.service.problem('p')).toBe('stalled');
    count = 11;
    at(630);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    count = 13;
    at(1200);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    at(1230);
    await s.tick();
    expect(s.service.warning('p')).toContain('13 pending');
    count = 0;
    at(1260);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
    count = 1;
    at(1290);
    await s.tick();
    expect(s.service.warning('p')).toBeNull();
  });

  it.each(['home', 'peer'] as const)(
    'restarts the %s stall clock when bytes fall with constant items',
    async (side) => {
      const s = await ready(false);
      const read = s.files.status.bind(s.files);
      let bytes = 100;
      jest.spyOn(s.files, 'status').mockImplementation(async (...args) => {
        const status = await read(...args);
        if (side === 'home') Object.assign(status, { needTotalItems: 1, needBytes: bytes });
        else Object.assign(status.peer!, { needItems: 1, needBytes: bytes });
        return status;
      });
      await s.tick();
      at(570);
      bytes = 50;
      await s.tick();
      at(600);
      await s.tick();
      expect(s.service.problem('p')).toBeNull();
      at(1170);
      await s.tick();
      expect(s.service.problem('p')).toBe('stalled');
    },
  );

  it.each([true, false])(
    'retains a failed-check warning until successful retry (git: %s)',
    async (hasGit) => {
      const s = await ready(hasGit);
      const check = jest
        .spyOn(s.files, 'isConnected')
        .mockRejectedValueOnce(new Error('unavailable'));
      await s.tick();
      expect(s.service.warning('p')).toContain('could not read the file sync status');
      at(5);
      await s.tick();
      expect(s.service.warning('p')).toContain('could not read the file sync status');
      expect(check).toHaveBeenCalledTimes(1);
      at(30);
      await s.tick();
      expect(s.service.warning('p')).toBeNull();
      expect(check).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps upkeep and guard warnings independent, with check warnings first', async () => {
    const s = setup();
    s.guard.install.mockResolvedValue('guard skipped' as never);
    await s.tick();
    s.git.mirroredHead.mockRejectedValue(new Error('locked'));
    const check = jest
      .spyOn(s.files, 'isConnected')
      .mockRejectedValueOnce(new Error('unavailable'));
    await s.tick();
    expect(s.service.warning('p')).toContain('could not read');
    s.files.folders.get('git:p')!.paused = true;
    at(30);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.service.warning('p')).toContain('could not finish updating');
    expect(s.service.problem('p')).toBe('setup');
    s.files.folders.get('git:p')!.paused = false;
    s.git.mirroredHead.mockResolvedValue('head');
    at(60);
    await s.tick();
    expect(s.service.warning('p')).toBe('guard skipped');
    expect(s.service.problem('p')).toBeNull();
  });

  it('throttles checks, gates offline/version mismatch, and resets on forget', async () => {
    const s = setup();
    const check = jest.spyOn(s.files, 'isConnected');
    await s.tick();
    expect(check).not.toHaveBeenCalled();
    s.host.syncStatus.mockClear();
    await s.tick();
    at(29);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(s.host.syncStatus).toHaveBeenCalledTimes(1);
    expect(s.host.syncStatus).toHaveBeenLastCalledWith('r', 'code:p');
    at(30);
    await s.tick();
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.host.syncStatus).toHaveBeenCalledTimes(2);
    at(60);
    s.health.online = false;
    await s.tick();
    s.health.online = true;
    s.health.versionMatches = false;
    await s.tick();
    s.health.versionMatches = true;
    s.health.apiKeyRejected = true;
    await s.tick();
    s.health.apiKeyRejected = false;
    await s.tick(() => false);
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.host.syncStatus).toHaveBeenCalledTimes(2);
    s.service.forget('p');
    await s.tick();
    await s.tick();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('keeps each project timer and warning independent', async () => {
    const s = await ready(false);
    s.files.folders.set('code:other', {
      ...s.files.folders.get('code:p')!,
      peerDeviceId: 'other-peer',
    });
    s.hostFiles.folders.set('code:other', { ...s.files.folders.get('code:other')! });
    s.files.peers.add('other-peer');
    const otherTick = () => s.service.tick('other', 'r', () => true);
    await otherTick();
    s.files.peers.delete('peer');
    const check = jest.spyOn(s.files, 'isConnected');
    await s.tick();
    await otherTick();
    expect(check).toHaveBeenCalledTimes(2);
    at(120);
    await s.tick();
    await otherTick();
    expect(s.service.warning('p')).toContain('No file sync connection');
    expect(s.service.warning('other')).toBeNull();
  });

  it('discards a completed check when the live lifecycle stopped during the read', async () => {
    const s = await ready(false);
    let active = true;
    jest.spyOn(s.files, 'status').mockImplementationOnce(async () => {
      active = false;
      throw new Error('read interrupted');
    });
    await s.tick(() => active);
    expect(s.service.warning('p')).toBeNull();
  });
});
