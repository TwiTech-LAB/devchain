import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService } from '../../file-sync/file-sync.service';
import type { WaitForCompleteOptions } from '../../file-sync/file-sync.service';
import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { GitService } from '../../git/services/git.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { GitCoordinatorIndexService } from '../git-coordinator/git-coordinator-index.service';
import type { GitCoordinatorRecord, GitTransition } from '../git-coordinator/git-coordinator.dto';
import { refsDigest } from '../git-coordinator/git-checkpoint';
import { GitOwnerStore } from '../git-owner.store';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import {
  DEFAULT_HOME_GIT_HANDOVER_TIMINGS,
  HOME_GIT_HANDOVER_TIMINGS,
  HomeGitHandoverService,
} from './home-git-handover.service';
import type { HomeGitTransitionContext } from './home-git-transitions';

jest.mock('../git-coordinator/git-checkpoint');

// Unit tests drive the handover and step-down orchestration against an in-memory VM that follows
// the coordinator's phase rules; the coordinator integration spec covers the VM side over HTTP.
const refused = (hostCode: string) =>
  new RemoteHostRequestError('refused', { remoteId: 'r', path: '/x', status: 409, hostCode });
const vmOwned = (): GitCoordinatorRecord => ({
  owner: 'vm',
  generation: 0,
  homeName: 'PC',
  homeWrites: {},
  checkpoint: { writeId: 'w0', generation: 0, refsDigest: 'refs', at: 1 },
  vmHolds: {},
  transition: null,
});
const handover = (
  phase: Extract<GitTransition, { kind: 'handover' }>['phase'],
): GitCoordinatorRecord => ({
  ...vmOwned(),
  ...(phase === 'published' && { owner: 'home' as const, generation: 1 }),
  transition: {
    kind: 'handover',
    id: 'h1',
    phase,
    lease: 1,
    sequences: { 'code:p': 4, 'git:p': 9 },
  },
});
const synced = (overrides: Partial<FolderSyncStatus> = {}): FolderSyncStatus => ({
  folderId: 'git:p',
  state: 'idle',
  localFiles: 3,
  localDirectories: 1,
  globalFiles: 3,
  globalDirectories: 1,
  needTotalItems: 0,
  needBytes: 0,
  receiveOnlyChangedFiles: 0,
  peer: { deviceId: 'HOME', completion: 100, needItems: 0, needBytes: 0, remoteState: 'valid' },
  ...overrides,
});

describe('HomeGitHandoverService', () => {
  let service: HomeGitHandoverService;
  let vm: GitCoordinatorRecord;
  let calls: string[];
  let directory: string;
  let root: string;
  const host = {
    handoverBegin: jest.fn(),
    handoverPhase: jest.fn(),
    handoverComplete: jest.fn(),
    handoverRenew: jest.fn(),
    handoverAbort: jest.fn(),
    gitCoordinatorStatus: jest.fn(),
    gitCoordinatorIndex: jest.fn(),
    syncRemoteNeedThrough: jest.fn(),
    syncStatus: jest.fn(),
  };
  const files = {
    device: jest.fn(),
    status: jest.fn(),
    updateFolder: jest.fn(),
    folderPath: jest.fn(),
    waitForComplete: jest.fn(),
    revertLocalChanges: jest.fn(),
    override: jest.fn(),
  };
  const guard = { install: jest.fn(), remove: jest.fn(), protectBranches: jest.fn() };
  const indexes = { save: jest.fn(), replace: jest.fn() };
  const owners = { remember: jest.fn() };
  const git = { refreshIndexFromHead: jest.fn() };
  const log = (entry: string) => async () => {
    calls.push(entry);
  };
  const context = (
    record: GitCoordinatorRecord,
    signal = new AbortController().signal,
  ): HomeGitTransitionContext => ({
    projectId: 'p',
    remoteId: 'r',
    remoteName: 'vm-01',
    record,
    writeId: 'hw-1',
    signal,
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    calls = [];
    vm = vmOwned();
    directory = await mkdtemp(join(tmpdir(), 'home-git-handover-'));
    root = join(directory, 'project');
    await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
    await mkdir(join(root, '.git', 'objects', 'ab'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(root, '.git', 'refs', 'heads', 'main'), 'abcd\n');
    await writeFile(join(root, '.git', 'objects', 'ab', 'cd'), 'object');
    host.handoverBegin.mockImplementation(async (_r, _p, { id }) => {
      calls.push('begin');
      vm = { ...vm, transition: { kind: 'handover', id, phase: 'draining', lease: 1 } };
      return structuredClone(vm);
    });
    host.handoverPhase.mockImplementation(async (_r, _p, { phase, writeId }) => {
      calls.push(`phase:${phase}`);
      const transition = vm.transition as Extract<GitTransition, { kind: 'handover' }>;
      if (phase === 'draining') transition.sequences = { 'code:p': 4, 'git:p': 9 };
      else if (phase !== 'published') transition.phase = phase;
      else {
        vm = { ...vm, owner: 'home', generation: vm.generation + 1 };
        vm.homeWrites[writeId] = 1;
        transition.phase = 'published';
      }
      return structuredClone(vm);
    });
    host.handoverComplete.mockImplementation(async () => {
      calls.push('complete');
      vm = { ...vm, transition: null };
      return structuredClone(vm);
    });
    host.handoverAbort.mockImplementation(async () => {
      calls.push('abort');
      vm = { ...vm, transition: null };
      return structuredClone(vm);
    });
    host.handoverRenew.mockResolvedValue(undefined);
    host.gitCoordinatorStatus.mockImplementation(async () => ({
      ...structuredClone(vm),
      worktreeBranches: ['lane-1'],
    }));
    host.gitCoordinatorIndex.mockResolvedValue(Buffer.from('DIRC'));
    host.syncRemoteNeedThrough.mockResolvedValue([]);
    files.device.mockReturnValue({ deviceId: 'HOME' });
    files.status.mockResolvedValue({ fileErrors: [] });
    files.folderPath.mockResolvedValue(root);
    files.updateFolder.mockImplementation(async (_id, { type }) => calls.push(`home:${type}`));
    files.waitForComplete.mockImplementation(log('settle'));
    guard.install.mockImplementation(async () => {
      calls.push('guard-on');
      return null;
    });
    guard.remove.mockImplementation(async () => {
      calls.push('guard-off');
      return { removed: true, indexRefreshed: null, warning: null };
    });
    guard.protectBranches.mockImplementation(async () => {
      calls.push('protect');
      return null;
    });
    indexes.save.mockImplementation(log('index-save'));
    indexes.replace.mockImplementation(log('index-install'));
    owners.remember.mockImplementation(async (_p, { owner, generation }) =>
      calls.push(`cache:${owner}:${generation}`),
    );
    git.refreshIndexFromHead.mockImplementation(log('index-from-head'));
    jest.mocked(refsDigest).mockResolvedValue('refs');
    const module = await Test.createTestingModule({
      providers: [
        HomeGitHandoverService,
        { provide: RemoteHostClient, useValue: host },
        { provide: FileSyncService, useValue: files },
        { provide: HomeGitGuardService, useValue: guard },
        { provide: GitCoordinatorIndexService, useValue: indexes },
        { provide: GitOwnerStore, useValue: owners },
        { provide: GitService, useValue: git },
        { provide: ProcessExecutor, useValue: { run: jest.fn().mockResolvedValue({}) } },
        {
          provide: RemoteLiveSyncService,
          useValue: { runExclusive: (_id: string, work: () => Promise<unknown>) => work() },
        },
        { provide: FILE_SYNC_PATHS, useValue: createProductionFileSyncPaths(directory) },
        {
          provide: HOME_GIT_HANDOVER_TIMINGS,
          useValue: {
            ...DEFAULT_HOME_GIT_HANDOVER_TIMINGS,
            barrierPollMs: 1,
            retryMs: 1,
            renewMs: 5,
          },
        },
      ],
    }).compile();
    service = module.get(HomeGitHandoverService);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const finish = [
    'guard-off',
    'protect',
    'index-save',
    'index-install',
    'complete',
    'cache:home:1',
  ];
  const flip = ['phase:vm-receiving', 'phase:home-sending', 'home:sendonly', 'phase:published'];

  it('runs C1–C4 receiver first and caches home ownership only after handoverComplete', async () => {
    await service.handover(context(vmOwned()));
    expect(calls).toEqual(['begin', 'phase:draining', ...flip, ...finish]);
    expect(host.handoverPhase).toHaveBeenCalledWith(
      'r',
      'p',
      expect.objectContaining({ phase: 'published', writeId: 'hw-1' }),
    );
    expect(guard.protectBranches).toHaveBeenCalledWith('p', 'r', ['lane-1']);
    expect(indexes.save).toHaveBeenCalledWith('p', Buffer.from('DIRC'), expect.any(Function));
    expect(vm).toMatchObject({ owner: 'home', generation: 1, homeWrites: { 'hw-1': 1 } });
  });

  it.each([
    ['draining', flip],
    ['vm-receiving', flip.slice(1)],
    ['home-sending', flip.slice(2)],
    ['published', []],
  ] as const)('resumes a handover found in phase %s and finishes forward', async (phase, rest) => {
    vm = handover(phase);
    await service.handover(context(structuredClone(vm)));
    expect(calls).toEqual([...rest, ...finish]);
  });

  it('waits for VM Git processes to drain before the VM guard and sequences', async () => {
    host.handoverPhase.mockRejectedValueOnce(refused('GIT_VM_HELD'));
    await service.handover(context(vmOwned()));
    expect(calls.slice(0, 3)).toEqual(['begin', 'phase:draining', 'phase:vm-receiving']);
    expect(host.handoverPhase.mock.calls[0][2]).toMatchObject({ phase: 'draining' });
  });

  it('waits for VM changes up to the recorded sequences, but not for items that failed here', async () => {
    host.syncRemoteNeedThrough.mockImplementation(async (_r, folderId: string) => {
      calls.push(`need:${folderId}`);
      return folderId === 'code:p' && calls.filter((call) => call === 'need:code:p').length < 2
        ? ['src/app.ts', 'logs/denied.log']
        : ['logs/denied.log'];
    });
    files.status.mockResolvedValue({ fileErrors: [{ path: 'logs/denied.log', error: 'denied' }] });
    vm = handover('draining');
    await service.handover(context(structuredClone(vm)));
    expect(host.syncRemoteNeedThrough).toHaveBeenCalledWith('r', 'code:p', 'HOME', 4);
    expect(host.syncRemoteNeedThrough).toHaveBeenCalledWith('r', 'git:p', 'HOME', 9);
    expect(calls.indexOf('phase:vm-receiving')).toBe(calls.lastIndexOf('need:git:p') + 1);
    expect(calls.filter((call) => call === 'need:code:p')).toHaveLength(2);
  });

  it('renews the lease while it waits before the flip', async () => {
    host.syncRemoteNeedThrough.mockImplementation(async () =>
      host.handoverRenew.mock.calls.length ? [] : ['src/app.ts'],
    );
    vm = handover('draining');
    await service.handover(context(structuredClone(vm)));
    expect(host.handoverRenew).toHaveBeenCalledWith('r', 'p', {
      expectedGeneration: 0,
      transitionId: 'h1',
    });
  });

  it('renews the lease of the new handover after a reread', async () => {
    vm = handover('draining');
    const renewed = (id: string) =>
      host.handoverRenew.mock.calls.some(([, , fence]) => fence.transitionId === id);
    host.syncRemoteNeedThrough.mockImplementation(async () =>
      renewed((vm.transition as { id: string }).id) ? [] : ['src/app.ts'],
    );
    host.handoverPhase.mockImplementationOnce(async () => {
      // The VM ended h1's lease and a new handover h2 now drains.
      vm = {
        ...vm,
        transition: {
          kind: 'handover',
          id: 'h2',
          phase: 'draining',
          lease: 2,
          sequences: { 'code:p': 5, 'git:p': 10 },
        },
      };
      throw refused('GIT_GENERATION_MISMATCH');
    });
    await service.handover(context(structuredClone(vm)));
    expect(host.handoverRenew).toHaveBeenLastCalledWith('r', 'p', {
      expectedGeneration: 0,
      transitionId: 'h2',
    });
  });

  it.each([
    ['for VM changes', ['begin', 'phase:draining', 'abort']],
    ['for VM Git to exit', ['begin', 'abort']],
  ])(
    'aborts before the flip when the supervisor goes away while waiting %s',
    async (wait, expected) => {
      const supervisor = new AbortController();
      if (wait === 'for VM changes')
        host.syncRemoteNeedThrough.mockImplementation(async () => {
          supervisor.abort();
          return [];
        });
      else
        host.handoverPhase.mockImplementationOnce(async () => {
          supervisor.abort();
          throw refused('GIT_VM_HELD');
        });
      await expect(service.handover(context(vmOwned(), supervisor.signal))).rejects.toThrow();
      expect(calls).toEqual(expected);
    },
  );

  it('finishes forward after the flip even when the supervisor is gone', async () => {
    const supervisor = new AbortController();
    supervisor.abort();
    vm = handover('vm-receiving');
    await service.handover(context(structuredClone(vm), supervisor.signal));
    expect(calls).toEqual([...flip.slice(1), ...finish]);
    expect(host.handoverAbort).not.toHaveBeenCalled();
  });

  it('rereads the VM record after a refused retry and continues from its phase', async () => {
    const publish = host.handoverPhase.getMockImplementation()!;
    host.handoverPhase.mockImplementationOnce(async (...args) => {
      await publish(...args);
      throw refused('GIT_GENERATION_MISMATCH');
    });
    vm = handover('home-sending');
    await service.handover(context(structuredClone(vm)));
    expect(calls).toEqual(['home:sendonly', 'phase:published', ...finish]);
  });

  it('steps down guard first, settles, rebuilds the index, and caches the VM generation last', async () => {
    const reclaimed = { ...vmOwned(), generation: 4 };
    await service.stepDown(context(reclaimed));
    expect(calls).toEqual([
      'guard-on',
      'home:receiveonly',
      'settle',
      'index-from-head',
      'cache:vm:4',
    ]);
    expect(existsSync(join(directory, '.devchain', 'backups'))).toBe(false);
    expect(files.override).not.toHaveBeenCalled();
  });

  it('backs up refs and objects before going receive-only when Git changed after the checkpoint', async () => {
    jest.mocked(refsDigest).mockResolvedValue('changed by an unshimmed git');
    const backups = join(directory, '.devchain', 'backups', 'git', 'p');
    files.updateFolder.mockImplementation(async () => {
      const [backup] = await readdir(backups);
      calls.push(`home:receiveonly after ${backup ? 'backup' : 'nothing'}`);
      expect(existsSync(join(backups, backup, 'refs', 'heads', 'main'))).toBe(true);
      expect(existsSync(join(backups, backup, 'objects', 'ab', 'cd'))).toBe(true);
    });
    await service.stepDown(context({ ...vmOwned(), generation: 4 }));
    expect(calls).toContain('home:receiveonly after backup');
  });

  it('reverts receive-only Git changes only after the VM index has fully arrived', async () => {
    await service.stepDown(context({ ...vmOwned(), generation: 4 }));
    const options = files.waitForComplete.mock.calls[0][1] as WaitForCompleteOptions;
    files.status.mockResolvedValue(synced({ receiveOnlyChangedFiles: 2 }));
    host.syncStatus.mockResolvedValueOnce(synced({ peer: null }));
    await options.receiver();
    expect(files.revertLocalChanges).not.toHaveBeenCalled();
    host.syncStatus.mockResolvedValueOnce(synced());
    await options.receiver();
    expect(files.revertLocalChanges).toHaveBeenCalledWith('git:p');
  });
});
