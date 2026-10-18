import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { createProductionFileSyncPaths } from '../../modules/file-sync/file-sync-paths';
import type { FileSyncPaths } from '../../modules/file-sync/file-sync-paths';
import { FileSyncService } from '../../modules/file-sync/file-sync.service';
import { SyncthingManager } from '../../modules/file-sync/syncthing-manager.service';
import {
  DEFAULT_GIT_COORDINATOR_TIMINGS,
  GIT_COORDINATOR_TIMINGS,
} from '../../modules/remotes/git-coordinator/git-coordinator.service';
import { GitCoordinatorStore } from '../../modules/remotes/git-coordinator/git-coordinator.store';
import type { GitCoordinatorRecord } from '../../modules/remotes/git-coordinator/git-coordinator.dto';
import { GitOwnerStore } from '../../modules/remotes/git-owner.store';
import { GIT_SHIM_REFRESH_MS } from '../../modules/remotes/git-shim/git-shim-registry.service';
import {
  DEFAULT_HOME_GIT_WRITE_TIMINGS,
  HOME_GIT_WRITE_TIMINGS,
} from '../../modules/remotes/git-writes/home-git-write.service';
import { HomeGitWriteStore } from '../../modules/remotes/git-writes/home-git-write.store';
import { ensureProvider } from '../../modules/remotes/replica/__fixtures__/replica-seed';
import { RemoteFileSyncService } from '../../modules/remotes/sync/remote-file-sync.service';
import type { Remote, RemoteOperation } from '../../modules/storage/models/domain.models';
import { seedRemoteProject, type SeededRemoteProject } from './remote-project.fixture';
import { startTwoInstances, waitForValue, type TwoInstances } from './two-instance.fixture';

/**
 * A project connected between two booted DevChain apps over real Syncthing, with the real git
 * shim and supervisor on each side. Commands run as child processes with their own HOME, whose
 * pid file points the supervisor at that side's app. See docs/git-coordinator.md.
 */
export type Side = 'home' | 'vm';

export interface GitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningGit {
  child: ChildProcess;
  result: Promise<GitResult>;
}

export interface GitOwnershipPair {
  pair: TwoInstances;
  seed: SeededRemoteProject;
  projectId: string;
  remote: Remote;
  root(side: Side): string;
  /** Real Git without the shim, for setup and assertions. */
  real(side: Side, ...args: string[]): string;
  /** Git through the shim, as an agent or a terminal on that side runs it. */
  /** `bypass` runs real Git the same way, for overhead comparisons. */
  start(side: Side, args: string[], options?: { stdin?: boolean; bypass?: boolean }): RunningGit;
  run(side: Side, ...args: string[]): Promise<GitResult>;
  write(side: Side, path: string, content: string): void;
  vm(): GitCoordinatorRecord;
  homeCache(): { owner: string; generation: number };
  /** Waits until the VM confirmed every home write; a home command returns before that. */
  confirmed(timeoutMs?: number, intervalMs?: number): Promise<void>;
  restartHome(): Promise<void>;
  restartHost(): Promise<void>;
  close(): Promise<void>;
}

const REPO = resolve(__dirname, '../../../../..');
const SUPERVISOR = join(REPO, 'scripts', 'lib', 'git-supervisor.js');
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Owner Test',
  GIT_AUTHOR_EMAIL: 'owner@example.test',
  GIT_COMMITTER_NAME: 'Owner Test',
  GIT_COMMITTER_EMAIL: 'owner@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export function syncthingBinary(): string | null {
  if (process.env.SYNCTHING_BIN) return process.env.SYNCTHING_BIN;
  try {
    return execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function pathsFor(dataDir: string): FileSyncPaths {
  return {
    ...createProductionFileSyncPaths(join(dataDir, 'home')),
    syncthingHome: () => join(dataDir, 'syncthing'),
    codeFolder: (project) => join(dataDir, 'projects', project.id),
  };
}

export async function startGitOwnership(
  options: {
    vmAcquireMs?: number;
    homeWrites?: Partial<typeof DEFAULT_HOME_GIT_WRITE_TIMINGS>;
  } = {},
): Promise<GitOwnershipPair> {
  const configure = (builder: TestingModuleBuilder, instance: 'home' | 'host') => {
    // The test writes each side's shim project list itself: both apps share one HOME here.
    builder.overrideProvider(GIT_SHIM_REFRESH_MS).useValue(0);
    if (instance === 'host')
      builder.overrideProvider(GIT_COORDINATOR_TIMINGS).useValue({
        ...DEFAULT_GIT_COORDINATOR_TIMINGS,
        pollMs: 200,
        acquireMs: options.vmAcquireMs ?? 3_000,
        gcMs: Infinity,
      });
    else
      builder.overrideProvider(HOME_GIT_WRITE_TIMINGS).useValue({
        ...DEFAULT_HOME_GIT_WRITE_TIMINGS,
        stepDownPollMs: 300,
        ...options.homeWrites,
      });
    return builder;
  };
  const pair = await startTwoInstances({
    fileSyncPaths: (_name, dataDir) => pathsFor(dataDir),
    configureModule: configure,
  });
  try {
    const seed = seedRemoteProject(pair.home.sqlite);
    const projectId = seed.projectId;
    ensureProvider(pair.host.sqlite, 'host-claude', seed.providerName, null);
    const remote = await pair.registerRemote('vm-1');
    await waitForValue(
      async () =>
        [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection() !== null),
      30_000,
    );
    await waitForValue(async () => {
      const list = (await (await fetch(`${pair.home.url}/api/remotes`)).json()) as {
        items: { id: string; online: boolean }[];
      };
      return list.items.find((item) => item.id === remote.id)?.online;
    }, 30_000);

    const root = (side: Side) =>
      join((side === 'home' ? pair.home : pair.host).dataDir, 'projects', projectId);
    const real = (side: Side, ...args: string[]) =>
      execFileSync('git', ['-C', root(side), ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...IDENTITY, DEVCHAIN_GIT_BYPASS: '1' },
      }).trim();
    const write = (side: Side, path: string, content: string) => {
      mkdirSync(join(root(side), path, '..'), { recursive: true });
      writeFileSync(join(root(side), path), content);
    };

    mkdirSync(root('home'), { recursive: true });
    real('home', 'init', '-q', '-b', 'main');
    real('home', 'config', 'commit.gpgsign', 'false');
    // Lane commits run inside the apps, without the test's identity environment.
    real('home', 'config', 'user.name', IDENTITY.GIT_AUTHOR_NAME);
    real('home', 'config', 'user.email', IDENTITY.GIT_AUTHOR_EMAIL);
    write('home', 'a.txt', 'one\ntwo\nthree\n');
    real('home', 'add', '.');
    real('home', 'commit', '-qm', 'base');
    pair.home.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(root('home'), projectId);
    await runOperation(pair, remote.id, projectId, 'attach');
    // Lanes run Git in the project root, which on this one machine differs per side.
    pair.host.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(root('vm'), projectId);
    await waitForValue(async () => {
      try {
        return real('vm', 'rev-parse', 'HEAD') === real('home', 'rev-parse', 'HEAD');
      } catch {
        return false;
      }
    }, 30_000);
    // Upkeep's first pass after Connect re-applies both folders paused, then resumes them; a
    // handover in between would find a paused VM folder.
    const upkeep = pair.home.app.get(RemoteFileSyncService) as unknown as {
      projects: Map<string, { step: string }>;
    };
    await waitForValue(async () => {
      if (upkeep.projects.get(projectId)?.step !== 'done') return false;
      for (const instance of [pair.home, pair.host])
        for (const kind of ['code', 'git'])
          if (
            (await instance.app.get(FileSyncService).folderConfiguration(`${kind}:${projectId}`))
              .paused
          )
            return false;
      return true;
    }, 60_000);
    const vm = () => pair.host.app.get(GitCoordinatorStore).read(projectId);
    const homeCache = () => {
      const owners = pair.home.app.get(GitOwnerStore);
      return { owner: owners.get(projectId), generation: owners.generation(projectId) };
    };

    const sideHome = (side: Side) => join(pair.rootDir, `shim-${side}`);
    const shimHome = (side: Side) => join(sideHome(side), '.devchain', 'git-shim');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const pidFile = (side: Side) => {
      const instance = side === 'home' ? pair.home : pair.host;
      writeFileSync(
        join(sideHome(side), '.devchain', 'devchain.pid'),
        JSON.stringify({
          pid: process.pid,
          port: Number(new URL(instance.url).port),
          host: '127.0.0.1',
        }),
      );
    };
    for (const side of ['home', 'vm'] as const) {
      mkdirSync(join(shimHome(side), 'state'), { recursive: true });
      pidFile(side);
      execFileSync(process.execPath, [
        '-e',
        `require(${JSON.stringify(join(REPO, 'scripts', 'lib', 'git-shim.js'))}).installShim(JSON.parse(process.argv[1]))`,
        JSON.stringify({
          home: shimHome(side),
          realGit,
          supervisor: SUPERVISOR,
          node: process.execPath,
        }),
      ]);
      const state = join(shimHome(side), 'state', projectId);
      writeFileSync(
        join(shimHome(side), 'projects.sh'),
        `case $devchain_common in\n  '${realpathSync(join(root(side), '.git'))}') devchain_project='${projectId}' devchain_side=${side} devchain_remote='${side === 'home' ? 'vm-1' : 'home-pc'}' devchain_state='${state}' ;;\nesac\n`,
      );
    }
    // The shim reads the owner only to choose read locks and the fetch skip.
    const writeState = (side: Side) => {
      const { owner, generation } = side === 'vm' ? vm() : homeCache();
      writeFileSync(join(shimHome(side), 'state', projectId), `${owner} ${generation}\n`);
    };

    const start = (
      side: Side,
      args: string[],
      startOptions: { stdin?: boolean; bypass?: boolean } = {},
    ) => {
      // A stopped app leaves its side's last state, as the shim would see it.
      const instance = side === 'home' ? pair.home : pair.host;
      if (!instance.isClosed()) writeState(side);
      const child = spawn(
        startOptions.bypass ? realGit : join(shimHome(side), 'bin', 'git'),
        args,
        {
          cwd: root(side),
          env: {
            ...process.env,
            ...IDENTITY,
            HOME: sideHome(side),
            PATH: `${join(shimHome(side), 'bin')}:${process.env.PATH}`,
          },
          stdio: [startOptions.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk) => (stdout += chunk));
      child.stderr!.on('data', (chunk) => (stderr += chunk));
      const result = new Promise<GitResult>((done) =>
        child.on('close', (code, signal) => done({ code, signal, stdout, stderr })),
      );
      return { child, result };
    };

    return {
      pair,
      seed,
      projectId,
      remote,
      root,
      real,
      start,
      run: (side, ...args) => start(side, args).result,
      write,
      vm,
      homeCache,
      confirmed: async (timeoutMs = 30_000, intervalMs) => {
        await waitForValue(
          async () =>
            pair.home.app.get(HomeGitWriteStore).list().length === 0 &&
            Object.keys(vm().homeWrites).length === 0,
          timeoutMs,
          intervalMs,
        );
      },
      restartHome: async () => {
        await pair.restartHome();
        pidFile('home');
      },
      restartHost: async () => {
        await pair.restartHost();
      },
      close: () => pair.close(),
    };
  } catch (error) {
    await pair.close();
    throw error;
  }
}

async function runOperation(
  pair: TwoInstances,
  remoteId: string,
  projectId: string,
  kind: 'attach' | 'detach',
): Promise<RemoteOperation> {
  const started = await fetch(`${pair.home.url}/api/remotes/${remoteId}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (started.status !== 202) throw new Error(`${kind} refused: ${await started.text()}`);
  const { id } = (await started.json()) as RemoteOperation;
  return waitForValue(async () => {
    const operation = (await (
      await fetch(`${pair.home.url}/api/remotes/operations/${id}`)
    ).json()) as RemoteOperation;
    if (operation.state === 'failed')
      throw new Error(`${kind} failed: ${JSON.stringify(operation.steps)}`);
    return operation.state === 'done' ? operation : null;
  }, 90_000);
}

/** The FileSyncService of one side, for folder type assertions. */
export function folderType(pair: GitOwnershipPair, side: Side, kind: 'code' | 'git') {
  const instance = side === 'home' ? pair.pair.home : pair.pair.host;
  return instance.app
    .get(FileSyncService)
    .folderConfiguration(`${kind}:${pair.projectId}`)
    .then((config) => config.type);
}
