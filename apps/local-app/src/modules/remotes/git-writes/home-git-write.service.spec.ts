import { Test } from '@nestjs/testing';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { exportIndexSnapshot, refsDigest } from '../git-coordinator/git-checkpoint';
import { GitProcessIdentity } from '../git-coordinator/git-process-identity';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { GitOwnerStore } from '../git-owner.store';
import { HomeGitTransitions } from './home-git-transitions';
import {
  DEFAULT_HOME_GIT_WRITE_TIMINGS,
  HOME_GIT_WRITE_TIMINGS,
  HomeGitWriteService,
} from './home-git-write.service';
import { HomeGitWriteStore, type HomeGitWrite } from './home-git-write.store';

jest.mock('../git-coordinator/git-checkpoint');

// Unit tests drive the write-through loop with fake timers; Git formats, SQLite and HTTP are
// covered by the coordinator and controller integration specs.
const record = (overrides: Partial<GitCoordinatorRecord> = {}): GitCoordinatorRecord => ({
  owner: 'home',
  generation: 3,
  homeName: 'PC',
  homeWrites: {},
  checkpoint: null,
  vmHolds: {},
  transition: null,
  ...overrides,
});
const unreachable = () =>
  new RemoteHostRequestError('offline', {
    remoteId: 'r',
    path: '/x',
    status: null,
    hostCode: null,
  });
const refused = (hostCode: string) =>
  new RemoteHostRequestError('refused', { remoteId: 'r', path: '/x', status: 409, hostCode });
const saved = (n: number, overrides: Partial<HomeGitWrite> = {}): HomeGitWrite => ({
  writeId: `hw-${n}`,
  projectId: 'p',
  remoteId: 'r',
  pid: 70 + n,
  processStartTime: 'boot:1',
  generation: 3,
  createdAt: n,
  ...overrides,
});

describe('HomeGitWriteService', () => {
  let service: HomeGitWriteService;
  let writes: Map<string, HomeGitWrite>;
  let owners: Map<string, { owner: 'home' | 'vm'; generation: number }>;
  const signal = new AbortController().signal;
  const host = {
    gitCoordinatorStatus: jest.fn(),
    homeWriteBegin: jest.fn(),
    homeWriteEnd: jest.fn(),
    syncStatus: jest.fn(),
  };
  const files = {
    folderPath: jest.fn(),
    projectFolders: jest.fn(),
    device: jest.fn(),
    folderConfiguration: jest.fn(),
    rescan: jest.fn(),
    status: jest.fn(),
    remoteNeedThrough: jest.fn(),
  };
  const processes = { read: jest.fn() };
  const transitions = { handover: jest.fn(), stepDown: jest.fn() };
  const bindings = { get: jest.fn(), list: jest.fn() };

  beforeEach(async () => {
    jest.useFakeTimers({ now: 1_000 });
    jest.resetAllMocks();
    writes = new Map();
    jest.mocked(refsDigest).mockResolvedValue('digest');
    jest.mocked(exportIndexSnapshot).mockResolvedValue(Buffer.from('DIRC'));
    owners = new Map([['p', { owner: 'home', generation: 3 }]]);
    bindings.get.mockResolvedValue({ projectId: 'p', remoteId: 'r', state: 'remote' });
    bindings.list.mockResolvedValue([]);
    processes.read.mockResolvedValue('boot:1');
    host.gitCoordinatorStatus.mockResolvedValue(record());
    host.homeWriteBegin.mockResolvedValue(record());
    host.homeWriteEnd.mockResolvedValue(record());
    host.syncStatus.mockResolvedValue({ fileErrors: [] });
    files.folderPath.mockResolvedValue('/project');
    files.projectFolders.mockResolvedValue([
      { id: 'code:p', kind: 'code' },
      { id: 'git:p', kind: 'git' },
    ]);
    files.device.mockReturnValue({ deviceId: 'HOME' });
    files.folderConfiguration.mockResolvedValue({
      devices: [{ deviceID: 'HOME' }, { deviceID: 'VM' }],
    });
    files.status.mockResolvedValue({ sequence: 40 });
    files.remoteNeedThrough.mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        HomeGitWriteService,
        {
          provide: STORAGE_SERVICE,
          useValue: { getRemote: async () => ({ name: 'vm-01' }) },
        },
        { provide: RemoteBindingsService, useValue: bindings },
        { provide: RemoteHostClient, useValue: host },
        { provide: FileSyncService, useValue: files },
        { provide: GitProcessIdentity, useValue: processes },
        { provide: ProcessExecutor, useValue: {} },
        { provide: HomeGitTransitions, useValue: transitions },
        {
          provide: HomeGitWriteStore,
          useValue: {
            list: () => [...writes.values()],
            get: (id: string) => writes.get(id) ?? null,
            put: (write: HomeGitWrite) => writes.set(write.writeId, write),
            delete: (id: string) => writes.delete(id),
          },
        },
        {
          provide: GitOwnerStore,
          useValue: {
            get: (id: string) => owners.get(id)?.owner ?? 'vm',
            generation: (id: string) => owners.get(id)?.generation ?? 0,
            remember: (id: string, { owner, generation }: GitCoordinatorRecord) =>
              owners.set(id, { owner, generation }),
          },
        },
        { provide: HOME_GIT_WRITE_TIMINGS, useValue: DEFAULT_HOME_GIT_WRITE_TIMINGS },
      ],
    }).compile();
    service = module.get(HomeGitWriteService);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('registers a write in one VM round trip, saved first, and reuses its id after no answer', async () => {
    host.homeWriteBegin.mockRejectedValueOnce(unreachable());
    await expect(service.acquire('p', 77, signal)).rejects.toMatchObject({
      code: 'GIT_VM_UNREACHABLE',
      statusCode: 503,
    });
    const [saved] = writes.values();
    expect(saved).toMatchObject({ pid: 77, processStartTime: 'boot:1', generation: 3 });
    const { writeId } = await service.acquire('p', 77, signal);
    expect(writeId).toBe(saved.writeId);
    expect(host.homeWriteBegin).toHaveBeenLastCalledWith('r', 'p', {
      expectedGeneration: 3,
      transitionId: null,
      writeId,
      homeName: expect.any(String),
    });
    expect(host.gitCoordinatorStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['the VM owns Git', 'vm', [record({ owner: 'vm' })], ['handover']],
    [
      'the VM took back Git this PC owned',
      'home',
      [record({ owner: 'vm', generation: 4 }), record({ owner: 'vm', generation: 4 })],
      ['stepDown', 'handover'],
    ],
    [
      'a handover is unfinished',
      'vm',
      [record({ transition: { kind: 'handover', id: 'h', phase: 'published', lease: 1 } })],
      ['handover'],
    ],
  ] as const)(
    'moves Git before registering the write when %s',
    async (_case, cached, vm, moves) => {
      owners.set('p', { owner: cached, generation: 3 });
      // A cached home owner tries its generation first; the VM refuses it.
      if (cached === 'home')
        host.homeWriteBegin.mockRejectedValueOnce(refused('GIT_GENERATION_MISMATCH'));
      for (const answer of vm) host.gitCoordinatorStatus.mockResolvedValueOnce(answer);
      host.gitCoordinatorStatus.mockResolvedValue(record({ generation: 6 }));
      const order: string[] = [];
      transitions.handover.mockImplementation(async () => order.push('handover'));
      transitions.stepDown.mockImplementation(async () => {
        order.push('stepDown');
        owners.set('p', { owner: 'vm', generation: 4 });
      });
      const { writeId } = await service.acquire('p', 77, signal);
      expect(order).toEqual(moves);
      expect(transitions.handover).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p', remoteName: 'vm-01', writeId, signal }),
      );
      expect(owners.get('p')).toEqual({ owner: 'home', generation: 6 });
      expect(host.homeWriteBegin).toHaveBeenLastCalledWith(
        'r',
        'p',
        expect.objectContaining({ expectedGeneration: 6 }),
      );
      expect(writes.get(writeId)?.generation).toBe(6);
    },
  );

  it('steps down on the poll once the VM took back Git, and holds home writes until it ends', async () => {
    bindings.list.mockResolvedValue([{ projectId: 'p', remoteId: 'r', state: 'remote' }]);
    host.gitCoordinatorStatus.mockResolvedValueOnce(record());
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(transitions.stepDown).not.toHaveBeenCalled();
    let finish!: () => void;
    transitions.stepDown.mockImplementation(() => new Promise<void>((done) => (finish = done)));
    host.gitCoordinatorStatus.mockResolvedValue(record({ owner: 'vm', generation: 4 }));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(transitions.stepDown).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p', record: record({ owner: 'vm', generation: 4 }) }),
    );
    const write = service.acquire('p', 77, signal);
    await jest.advanceTimersByTimeAsync(0);
    expect(host.homeWriteBegin).not.toHaveBeenCalled();
    owners.set('p', { owner: 'vm', generation: 4 });
    finish();
    await write.catch(() => undefined);
    expect(host.homeWriteBegin).not.toHaveBeenCalledWith(
      'r',
      'p',
      expect.objectContaining({ expectedGeneration: 3 }),
    );
  });

  it('keeps the write in flight while its git is alive or unknown, and confirms it once git is gone', async () => {
    const { writeId } = await service.acquire('p', 77, signal);
    processes.read
      .mockResolvedValueOnce('boot:1')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(550);
    expect(host.homeWriteEnd).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(host.homeWriteEnd).toHaveBeenCalledWith('r', 'p', {
      expectedGeneration: 3,
      transitionId: null,
      writeId,
      refsDigest: 'digest',
      indexBase64: Buffer.from('DIRC').toString('base64'),
    });
    expect(writes.size).toBe(0);
  });

  it('waits for changed items up to the scanned sequence, but never for items the VM failed', async () => {
    processes.read.mockResolvedValueOnce('boot:1').mockResolvedValue(false);
    files.remoteNeedThrough
      .mockResolvedValueOnce(['bad.txt', 'slow.txt'])
      .mockResolvedValue(['bad.txt']);
    host.syncStatus.mockResolvedValue({ fileErrors: [{ path: 'bad.txt', error: 'denied' }] });
    await service.acquire('p', 77, signal);
    await jest.advanceTimersByTimeAsync(300);
    expect(files.rescan).toHaveBeenCalledWith('code:p');
    expect(files.remoteNeedThrough).toHaveBeenCalledWith('code:p', 'VM', 40);
    expect(host.homeWriteEnd).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(250);
    expect(host.homeWriteEnd).toHaveBeenCalledTimes(1);
    expect(writes.size).toBe(0);
  });

  it('retries a confirmation the VM did not answer until it lands', async () => {
    processes.read.mockResolvedValueOnce('boot:1').mockResolvedValue(false);
    host.homeWriteEnd.mockRejectedValueOnce(unreachable());
    await service.acquire('p', 77, signal);
    await jest.advanceTimersByTimeAsync(300);
    expect(host.homeWriteEnd).toHaveBeenCalledTimes(1);
    expect(writes.size).toBe(1);
    await jest.advanceTimersByTimeAsync(1_300);
    expect(host.homeWriteEnd).toHaveBeenCalledTimes(2);
    expect(writes.size).toBe(0);
  });

  it.each(['GIT_HOME_WRITE_UNKNOWN', 'GIT_GENERATION_MISMATCH'])(
    'drops a batch member the VM never registered (%s) and confirms the others',
    async (code) => {
      for (const n of [1, 2, 3]) writes.set(`hw-${n}`, saved(n));
      processes.read.mockResolvedValue('boot:2');
      host.homeWriteEnd.mockImplementation(async (_r, _p, { writeId }) => {
        if (writeId === 'hw-2') throw refused(code);
        return record();
      });
      await service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(host.homeWriteEnd.mock.calls.map(([, , body]) => body.writeId)).toEqual([
        'hw-1',
        'hw-2',
        'hw-3',
      ]);
      expect(writes.size).toBe(0);
    },
  );

  it('confirms every finished write of the project with one sync check, oldest first', async () => {
    writes.set('hw-3', saved(3, { generation: 5 }));
    writes.set('hw-1', saved(1));
    writes.set('hw-2', saved(2, { generation: 4 }));
    processes.read.mockResolvedValue('boot:2');
    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(files.rescan.mock.calls).toEqual([['code:p'], ['git:p']]);
    const index = Buffer.from('DIRC').toString('base64');
    expect(host.homeWriteEnd.mock.calls).toEqual(
      [
        ['hw-1', 3],
        ['hw-2', 4],
        ['hw-3', 5],
      ].map(([writeId, expectedGeneration]) => [
        'r',
        'p',
        {
          expectedGeneration,
          transitionId: null,
          writeId,
          refsDigest: 'digest',
          indexBase64: index,
        },
      ]),
    );
    expect(writes.size).toBe(0);
  });

  it.each([
    ['joins the batch once it ends within the settle wait', 1_000, [['hw-1', 'hw-2']]],
    ['stays out of the batch past the settle wait', 5_000, [['hw-1'], ['hw-2']]],
  ])('a write whose git still runs %s', async (_case, runsMs, batches) => {
    writes.set('hw-1', saved(1));
    writes.set('hw-2', saved(2));
    const alive = new Set([72]);
    processes.read.mockImplementation(async (pid: number) =>
      alive.has(pid) ? 'boot:1' : 'boot:2',
    );
    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(runsMs);
    alive.clear();
    await jest.advanceTimersByTimeAsync(1_000);
    const confirmed = host.homeWriteEnd.mock.calls.map(([, , body]) => body.writeId);
    expect(confirmed).toEqual(batches.flat());
    expect(files.rescan).toHaveBeenCalledTimes(2 * batches.length);
    expect(writes.size).toBe(0);
  });

  it.each([
    ['a VM that does not answer', unreachable()],
    ['GIT_CHECKPOINT_INCOMPLETE', refused('GIT_CHECKPOINT_INCOMPLETE')],
  ])(
    'stops the batch at %s, keeps the later members, and retries them with one more sync check',
    async (_case, error) => {
      for (const n of [1, 2, 3, 4]) writes.set(`hw-${n}`, saved(n));
      const alive = new Set([74]);
      processes.read.mockImplementation(async (pid: number) =>
        alive.has(pid) ? 'boot:1' : 'boot:2',
      );
      const seen: [string, string[]][] = [];
      host.homeWriteEnd.mockImplementation(async (_r, _p, { writeId }) => {
        seen.push([writeId, [...writes.keys()]]);
        if (writeId === 'hw-2' && seen.length === 2) {
          alive.clear();
          throw error;
        }
        return record();
      });
      await service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10_000);
      // hw-4's git outlives the settle wait, then ends while the first batch confirms.
      expect(seen).toEqual([
        ['hw-1', ['hw-1', 'hw-2', 'hw-3', 'hw-4']],
        ['hw-2', ['hw-2', 'hw-3', 'hw-4']],
        ['hw-2', ['hw-2', 'hw-3', 'hw-4']],
        ['hw-3', ['hw-3', 'hw-4']],
        ['hw-4', ['hw-4']],
      ]);
      expect(files.rescan).toHaveBeenCalledTimes(4);
      expect(writes.size).toBe(0);
    },
  );

  it('leaves out a saved write that is not tracked until its project settles', async () => {
    writes.set('hw-1', saved(1));
    bindings.list.mockResolvedValue([{ projectId: 'p', remoteId: 'r', state: 'remote' }]);
    host.gitCoordinatorStatus.mockRejectedValue(unreachable());
    processes.read.mockResolvedValueOnce('boot:1').mockResolvedValue('boot:2');
    await service.onApplicationBootstrap();
    const { writeId } = await service.acquire('p', 77, signal);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(host.homeWriteEnd.mock.calls.map(([, , body]) => body.writeId)).toEqual([writeId]);
    expect([...writes.keys()]).toEqual(['hw-1']);
  });

  it('confirms a saved write after a restart without its supervisor', async () => {
    writes.set('hw-1', saved(1, { pid: 77 }));
    processes.read.mockResolvedValue('boot:2');
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(300);
    expect(host.homeWriteEnd).toHaveBeenCalledWith(
      'r',
      'p',
      expect.objectContaining({ writeId: 'hw-1', expectedGeneration: 3 }),
    );
  });
});
