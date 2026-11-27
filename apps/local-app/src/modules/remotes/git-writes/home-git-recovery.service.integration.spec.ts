import { Test, type TestingModule } from '@nestjs/testing';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findDevchainCli } from '../../../common/devchain-cli-launcher';
import { waitForValue } from '../../../common/test/two-instance.fixture';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { GitService } from '../../git/services/git.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { captureGitBaseline, refsDigest } from '../git-coordinator/git-checkpoint';
import { GitCoordinatorIndexService } from '../git-coordinator/git-coordinator-index.service';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';
import { GitOwnerStore } from '../git-owner.store';
import { GIT_SHIM_HOME } from '../git-shim/git-shim-registry.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import {
  DEFAULT_HOME_GIT_HANDOVER_TIMINGS,
  HOME_GIT_HANDOVER_TIMINGS,
  HomeGitHandoverService,
} from './home-git-handover.service';
import { HomeGitRecoveryService } from './home-git-recovery.service';
import { HomeGitWriteStore } from './home-git-write.store';

jest.mock('../../../common/devchain-cli-launcher');
const mockRecoveryWarn = jest.fn();
jest.mock('../../../common/logging/logger', () => {
  const actual = jest.requireActual<typeof import('../../../common/logging/logger')>(
    '../../../common/logging/logger',
  );
  return {
    ...actual,
    createLogger: (context: string) => {
      const logger = actual.createLogger(context);
      if (context === 'HomeGitRecovery')
        logger.warn = (...args: unknown[]) => mockRecoveryWarn(...args);
      return logger;
    },
  };
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, DEVCHAIN_GIT_BYPASS: '1' } },
  ).trim();
}

function supportsReftable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'devchain-reftable-probe-'));
  try {
    return (
      spawnSync('git', ['init', '-q', '--ref-format=reftable', probe], {
        env: { ...process.env, DEVCHAIN_GIT_BYPASS: '1' },
      }).status === 0
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// Ref storage and shallow negotiation require real Git. Ownership and sync are service boundaries.
describe('Home Git backup recovery', () => {
  const startedAt = 1_000;
  const time = '1970-01-01T00-00-01-000Z';
  const record: GitCoordinatorRecord = {
    owner: 'vm',
    generation: 1,
    homeName: 'PC',
    homeWrites: {},
    checkpoint: null,
    vmHolds: {},
    transition: null,
  };
  let directory: string;
  let root: string;
  let testing: TestingModule;

  beforeEach(async () => {
    mockRecoveryWarn.mockClear();
    directory = await mkdtemp(join(tmpdir(), 'devchain-git-recovery-'));
    root = join(directory, 'pc');
    testing = await Test.createTestingModule({
      providers: [
        HomeGitHandoverService,
        HomeGitRecoveryService,
        { provide: FILE_SYNC_PATHS, useValue: createProductionFileSyncPaths(directory) },
        { provide: GIT_SHIM_HOME, useValue: join(directory, '.devchain', 'git-shim') },
        { provide: STORAGE_SERVICE, useValue: { getRemote: () => ({ name: 'VM' }) } },
        { provide: ProcessExecutor, useClass: ChildProcessExecutor },
        {
          provide: RemoteBindingsService,
          useValue: { get: () => ({ state: 'remote', remoteId: 'r' }) },
        },
        {
          provide: RemoteHostClient,
          useValue: { syncOverride: jest.fn(), gitCoordinatorStatus: () => record },
        },
        {
          provide: FileSyncService,
          useValue: {
            folderPath: () => root,
            updateFolder: jest.fn(),
            device: () => ({ deviceId: 'PC' }),
            waitForComplete: jest.fn(),
          },
        },
        { provide: HomeGitGuardService, useValue: { install: jest.fn() } },
        { provide: GitCoordinatorIndexService, useValue: {} },
        { provide: GitOwnerStore, useValue: { remember: jest.fn() } },
        { provide: GitService, useValue: { refreshIndexFromHead: jest.fn() } },
        {
          provide: RemoteLiveSyncService,
          useValue: { runExclusive: (_: string, work: () => Promise<void>) => work() },
        },
        { provide: HOME_GIT_HANDOVER_TIMINGS, useValue: DEFAULT_HOME_GIT_HANDOVER_TIMINGS },
        { provide: HomeGitWriteStore, useValue: { get: () => null } },
      ],
    }).compile();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await testing.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function backup(): Promise<string> {
    await testing.get(HomeGitHandoverService).stepDown({
      projectId: 'p',
      remoteId: 'r',
      remoteName: 'VM',
      record,
      startedAt,
      signal: new AbortController().signal,
    });
    return join(directory, '.devchain', 'backups', 'git', 'p', time);
  }

  const reftable = supportsReftable();
  (reftable ? it : it.skip)(
    `saves no rollback baseline for reftable, reads its logical HEAD and backs it up${reftable ? '' : ' (Git cannot initialize reftable)'}`,
    async () => {
      git(directory, 'init', '-qb', 'main', '--ref-format=reftable', root);
      git(root, 'commit', '-qm', 'saved tip', '--allow-empty');
      const tip = git(root, 'rev-parse', 'HEAD');
      const executor = testing.get(ProcessExecutor);

      // Reftable keeps operation state such as CHERRY_PICK_HEAD in the ref store, so a forced
      // reclaim cannot prove that a rollback removed it. No baseline means no forced reclaim.
      expect(await captureGitBaseline(executor, root, 0)).toBeUndefined();
      const attached = await refsDigest(executor, root);
      git(root, 'switch', '-q', '--detach');
      expect(await refsDigest(executor, root)).not.toBe(attached);
      expect(git(root, '--git-dir', await backup(), 'rev-parse', 'HEAD')).toBe(tip);
    },
  );

  it('recovers a shallow branch and keeps the backup pending when a zero exit creates no ref', async () => {
    const upstream = join(directory, 'upstream');
    const vm = join(directory, 'vm');
    git(directory, 'init', '-qb', 'main', upstream);
    git(upstream, 'commit', '-qm', 'shared tip', '--allow-empty');
    git(directory, 'clone', '-q', upstream, root);
    git(directory, 'clone', '-q', upstream, vm);
    git(upstream, 'switch', '-qc', 'topic');
    git(upstream, 'commit', '-qm', 'parent outside the shallow boundary', '--allow-empty');
    git(upstream, 'commit', '-qm', 'shallow tip', '--allow-empty');
    git(root, 'fetch', '-q', '--depth=1', upstream, 'refs/heads/topic:refs/heads/topic');
    const tip = git(root, 'rev-parse', 'refs/heads/topic');
    const saved = await backup();
    expect(await readFile(join(saved, 'shallow'), 'utf8')).toBe(`${tip}\n`);
    root = vm;

    const supervisor = join(directory, 'lib', 'git-supervisor.js');
    await mkdir(dirname(supervisor));
    // The IPC stand-in admits the write and can skip Git to simulate a successful no-op fetch.
    await writeFile(
      supervisor,
      `
      const { existsSync } = require('node:fs');
      const { execFileSync } = require('node:child_process');
      process.once('message', ({ ready }) => {
        if (ready !== 'test-write') process.exit(1);
        if (existsSync('run-fetch')) execFileSync('git', process.argv.slice(2));
        process.disconnect();
      });
      process.send({ writeId: 'test-write' });
    `,
    );
    jest.mocked(findDevchainCli).mockReturnValue(join(directory, 'cli.js'));
    const recovery = testing.get(HomeGitRecoveryService);
    recovery.schedule('p', 'r');
    const [error] = await waitForValue(async () => mockRecoveryWarn.mock.calls[0], 5_000);
    expect(error).toMatchObject({
      error: { message: expect.stringContaining('all planned refs') },
    });
    const [pending] = await recovery.list('p');
    expect(pending.state).toBe('pending');
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/devchain-recovered')).toBe(
      '',
    );

    await writeFile(join(root, 'run-fetch'), '');
    const now = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => now() + 5_001);
    recovery.schedule('p', 'r');
    const fetched = await waitForValue(async () => {
      const [entry] = await recovery.list('p');
      return entry.state === 'fetched' && entry;
    }, 5_000);
    expect(fetched.refs).toEqual(pending.refs);
    expect(fetched.refs).toEqual([
      expect.stringMatching(/^refs\/heads\/devchain-recovered\/[^/]+\/topic$/),
    ]);
    const [destination] = fetched.refs;
    expect(git(root, 'rev-parse', destination)).toBe(tip);
    expect(await readFile(join(root, '.git', 'shallow'), 'utf8')).toBe(`${tip}\n`);
  }, 15_000);
});
