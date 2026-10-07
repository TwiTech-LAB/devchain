// The step boundary is the cheapest layer for the repository table and preflight refusals.
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { SyncPathInspection } from '../../file-sync/sync-path-inspection.dto';
import { ForceSyncOperation } from './force-sync.operation';
import type { RemoteOperationStepRun } from './remote-operation.types';

function setup(source: 'home' | 'vm' = 'home', homeRepository = true, vmRepository = true) {
  const home: SyncPathInspection = {
    rootPath: '/home/project',
    exists: true,
    repository: homeRepository,
    gitState: 'repo',
    projectOwner: null,
    candidates: [],
    requestedPaths: [],
    entries: [],
  };
  const vm = { ...home, repository: vmRepository };
  const binding = { state: 'remote', remoteId: 'r' };
  const healthState = { online: true, versionMatches: true, apiKeyRejected: false };
  const health = { refresh: jest.fn(async () => healthState) };
  const bindings = { get: jest.fn(async () => binding) };
  const host = {
    syncDevice: jest.fn(async () => ({ deviceId: 'VM' })),
    syncInspect: jest.fn(async () => vm),
    freeze: jest.fn(),
    stopSessions: jest.fn(),
    thaw: jest.fn(),
  };
  const files = {
    isConnected: jest.fn(async () => true),
    folderPath: jest.fn(async () => home.rootPath),
  };
  const inspector = { inspect: jest.fn(async () => home) };
  const handoff = {
    ensureAvailable: jest.fn(),
    ensureRepository: jest.fn(async () => {
      home.repository = true;
      return true;
    }),
    forceCopy: jest.fn(),
    restoreConnected: jest.fn(),
  };
  const live = { runExclusive: jest.fn(async (_: string, work: () => Promise<void>) => work()) };
  const upkeep = { forget: jest.fn(), forceSyncOffer: jest.fn() };
  const definition = new ForceSyncOperation(
    { getProject: async () => ({ rootPath: home.rootPath }) } as never,
    health as never,
    bindings as never,
    host as never,
    files as never,
    inspector as never,
    handoff as never,
    live as never,
    upkeep as never,
  );
  const operation: RemoteOperation = {
    id: 'op',
    kind: 'force_sync',
    remoteId: 'r',
    projectId: 'p',
    state: 'running',
    steps: [],
    details: { source, forceSync: { source } },
    createdAt: 'now',
    updatedAt: 'now',
  };
  const details = structuredClone(operation.details);
  const progress = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(details, patch);
  });
  const run: RemoteOperationStepRun = { operation, details, progress };
  const preflight = () => definition.steps[0].run(run);
  return {
    home,
    vm,
    binding,
    healthState,
    health,
    bindings,
    host,
    files,
    inspector,
    handoff,
    live,
    upkeep,
    definition,
    operation,
    details,
    progress,
    preflight,
  };
}

describe('ForceSyncOperation preflight', () => {
  it.each([
    { source: 'home' as const, home: true, vm: true },
    { source: 'home' as const, home: true, vm: false },
    { source: 'vm' as const, home: true, vm: true },
    { source: 'vm' as const, home: false, vm: true },
  ])('copies git for $source with home=$home and vm=$vm', async ({ source, home, vm }) => {
    const s = setup(source, home, vm);
    // Repository validity is independent of Git metadata/status inspection.
    s.home.gitState = 'error';
    s.vm.gitState = 'error';
    await s.preflight();
    expect(s.details).toMatchObject({
      source,
      kinds: ['code', 'git'],
      forceSync: { source, kinds: ['code', 'git'] },
    });
    expect(s.handoff.ensureRepository).not.toHaveBeenCalled();
    expect(s.upkeep.forceSyncOffer).not.toHaveBeenCalled();
  });

  it.each([
    {
      source: 'home' as const,
      home: false,
      vm: true,
      message:
        "The VM has a Git repository and this PC has none. Use the VM's files, or restore the repository on this PC.",
    },
    {
      source: 'vm' as const,
      home: true,
      vm: false,
      message: "The VM has no Git repository. Use this PC's files.",
    },
    {
      source: 'vm' as const,
      home: false,
      vm: false,
      message: "The VM has no Git repository. Use this PC's files.",
    },
  ])('refuses $source with home=$home and vm=$vm', async ({ source, home, vm, message }) => {
    const s = setup(source, home, vm);
    await expect(s.preflight()).rejects.toThrow(message);
    expect(s.handoff.ensureRepository).not.toHaveBeenCalled();
    expect(s.host.freeze).not.toHaveBeenCalled();
  });

  it('initializes only home when neither side has a repository and retains the durable note on replay', async () => {
    const s = setup('home', false, false);
    await s.preflight();
    expect(s.handoff.ensureRepository).toHaveBeenCalledWith('p');
    expect(s.progress).toHaveBeenCalledWith(
      expect.objectContaining({
        gitInit: 'created',
        forceSync: { source: 'home', gitInit: 'created' },
      }),
      { durable: true },
    );
    await s.preflight();
    expect(s.handoff.ensureRepository).toHaveBeenCalledTimes(1);
    expect(s.details).toMatchObject({ kinds: ['code', 'git'], forceSync: { gitInit: 'created' } });
  });

  it('keeps worktrees code-only when ensureRepository skips git init', async () => {
    const s = setup('home', false, false);
    s.handoff.ensureRepository.mockImplementation(async () => false);
    await s.preflight();
    expect(s.details).toMatchObject({ kinds: ['code'], forceSync: { kinds: ['code'] } });
    expect(s.details.gitInit).toBeUndefined();
  });

  it.each(['home', 'vm'] as const)(
    'propagates a %s read error without initializing any repository',
    async (side) => {
      const s = setup('home', false, false);
      (side === 'home' ? s.inspector.inspect : s.host.syncInspect).mockRejectedValueOnce(
        new Error(`${side} read denied`),
      );
      await expect(s.preflight()).rejects.toThrow(`${side} read denied`);
      expect(s.handoff.ensureRepository).not.toHaveBeenCalled();
    },
  );

  it.each(['home', 'vm'] as const)('refuses a missing %s source root', async (source) => {
    const s = setup(source);
    s[source].exists = false;
    await expect(s.preflight()).rejects.toThrow('The project folder is missing');
  });

  it.each(['binding', 'remote', 'offline', 'key', 'version', 'connection'] as const)(
    'refuses the %s gate before file inspection',
    async (gate) => {
      const s = setup();
      if (gate === 'binding') s.binding.state = 'local';
      if (gate === 'remote') s.binding.remoteId = 'other';
      if (gate === 'offline') s.healthState.online = false;
      if (gate === 'key') s.healthState.apiKeyRejected = true;
      if (gate === 'version') s.healthState.versionMatches = false;
      if (gate === 'connection') s.files.isConnected.mockResolvedValue(false);
      await expect(s.preflight()).rejects.toThrow();
      expect(s.inspector.inspect).not.toHaveBeenCalled();
      expect(s.handoff.ensureRepository).not.toHaveBeenCalled();
    },
  );

  it('waits for live-sync exclusion before inspecting or changing files', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.live.runExclusive.mockImplementation(async (_, work) => {
      await gate;
      return work();
    });
    const preflight = s.preflight();
    expect(s.bindings.get).not.toHaveBeenCalled();
    release();
    await preflight;
    expect(s.live.runExclusive).toHaveBeenCalledWith('p', expect.any(Function));
  });
});

describe('ForceSyncOperation cancellation', () => {
  it.each(['running', 'failed', 'done', 'pending'] as const)(
    'refuses after copy began, including %s after Retry',
    (state) => {
      const s = setup();
      s.operation.steps = [
        {
          id: 'force_copy',
          label: 'Copy files',
          state,
          startedAt: 'earlier',
          endedAt: null,
          error: null,
        },
      ];
      expect(() => s.definition.assertCancellable(s.operation)).toThrow(
        'Force sync is copying; retry it, or force a disconnect.',
      );
    },
  );

  it('allows cancellation before copy and thaws a possibly frozen host', async () => {
    const s = setup();
    s.operation.steps = [
      {
        id: 'freeze_host',
        label: 'Lock',
        state: 'failed',
        startedAt: 'earlier',
        endedAt: null,
        error: null,
      },
    ];
    expect(() => s.definition.assertCancellable(s.operation)).not.toThrow();
    await s.definition.rollback(s.operation);
    expect(s.host.thaw).toHaveBeenCalledWith('r', 'p');
    expect(s.handoff.restoreConnected).not.toHaveBeenCalled();
  });
});
