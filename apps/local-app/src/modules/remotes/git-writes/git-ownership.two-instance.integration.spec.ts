import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { FILE_SYNC_PATHS, type FileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService, projectFolderId } from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { WorktreesService } from '../../worktrees/worktrees.service';
import { refsDigest } from '../git-coordinator/git-checkpoint';
import { GitCoordinatorIndexService } from '../git-coordinator/git-coordinator-index.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { HomeGitWriteService } from './home-git-write.service';
import { HomeGitWriteStore } from './home-git-write.store';
import { HomeGitRecoveryService } from './home-git-recovery.service';
import {
  folderType,
  startGitOwnership,
  syncthingBinary,
  type GitOwnershipPair,
  type GitResult,
  type RunningGit,
  type Side,
} from '../../../common/test/git-ownership.fixture';
import { waitForValue } from '../../../common/test/two-instance.fixture';

// The scenarios run in order: each starts from the Git owner the previous one left.
// Two booted apps, real Syncthing, the real shim and supervisor processes: these scenarios cross
// the PC, the VM, file sync and process lifetimes, which no single-service test can.
const binary = syncthingBinary();
const real = binary && process.platform === 'linux' ? describe : describe.skip;
jest.setTimeout(180_000);

real('Git ownership moves between two instances', () => {
  let g: GitOwnershipPair;
  const savedBin = process.env.SYNCTHING_BIN;
  const read = (side: Side, path: string) => readFileSync(join(g.root(side), path), 'utf8');
  const homeWrites = () => g.pair.home.app.get(HomeGitWriteStore).list();
  const stepsDown = () =>
    waitForValue(
      async () => g.homeCache().owner === 'vm' && g.homeCache().generation === g.vm().generation,
      30_000,
    );
  const pauseVmCode = (paused: boolean) =>
    g.pair.host.app.get(FileSyncService).updateFolder(`code:${g.projectId}`, { paused });

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    g = await startGitOwnership();
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await g?.close();
    if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
    else process.env.SYNCTHING_BIN = savedBin;
  }, 60_000);

  it('moves Git to the PC with the VM staged entries, while reads never move Git or fail', async () => {
    g.write('vm', 'a.txt', 'one\nTWO\nthree\n');
    expect(await g.run('vm', 'add', 'a.txt')).toMatchObject({ code: 0, stderr: '' });
    g.write('vm', 'a.txt', 'one\nTWO\nthree\nfour\n');
    const staged = g.real('vm', 'show', ':a.txt');
    await waitForValue(async () => read('home', 'a.txt') === 'one\nTWO\nthree\nfour\n', 30_000);
    const before = g.vm();
    for (const args of [
      ['status', '--porcelain'],
      ['log', '-1'],
      ['diff', '--cached'],
    ])
      expect((await g.run('home', ...args)).code).toBe(0);
    expect(g.vm()).toMatchObject({ owner: 'vm', generation: before.generation, transition: null });

    let reading = true;
    const reads: GitResult[] = [];
    const readLoop = (async () => {
      while (reading) {
        reads.push(await g.run('home', 'status', '--porcelain'));
        reads.push(await g.run('home', 'log', '-1', '--format=%H'));
      }
    })();
    g.write('home', 'b.txt', 'from the PC\n');
    const write = await g.run('home', 'add', 'b.txt');
    reading = false;
    await readLoop;

    expect(write).toMatchObject({ code: 0, stderr: '' });
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.filter((result) => result.code !== 0)).toEqual([]);
    await g.confirmed();
    const generation = before.generation + 1;
    expect(g.vm()).toMatchObject({ owner: 'home', generation, transition: null });
    expect(g.homeCache()).toEqual({ owner: 'home', generation });
    // Before Git ran here, the PC had the VM's last worktree change and its staged entry.
    expect(g.real('home', 'show', ':a.txt')).toBe(staged);
    expect(read('home', 'a.txt')).toBe('one\nTWO\nthree\nfour\n');
    expect(g.real('home', 'diff', '--cached', '--name-only')).toBe('a.txt\nb.txt');
    expect(await folderType(g, 'home', 'git')).toBe('sendonly');
    expect(await folderType(g, 'vm', 'git')).toBe('receiveonly');
  });

  it('keeps partial staging when the VM takes Git back, and the PC then steps down', async () => {
    g.write('home', 'c.txt', 'staged on the PC\n');
    expect(await g.run('home', 'add', 'c.txt')).toMatchObject({ code: 0, stderr: '' });
    await g.confirmed();
    g.write('home', 'c.txt', 'still editing\n');
    const generation = g.vm().generation;
    g.write('vm', 'd.txt', 'agent file\n');
    expect(await g.run('vm', 'add', 'd.txt')).toMatchObject({ code: 0, stderr: '' });
    expect(g.vm()).toMatchObject({ owner: 'vm', generation: generation + 1 });
    expect(g.real('vm', 'show', ':c.txt')).toBe('staged on the PC');
    expect(g.real('vm', 'diff', '--cached', '--name-only')).toBe('a.txt\nb.txt\nc.txt\nd.txt');
    await stepsDown();
    expect(await folderType(g, 'home', 'git')).toBe('receiveonly');
    expect(await folderType(g, 'vm', 'git')).toBe('sendonly');
  });

  it('resumes an interrupted write-through without a lost or duplicated checkpoint', async () => {
    const client = g.pair.home.app.get(RemoteHostClient);
    const end = client.homeWriteEnd.bind(client);
    const spy = jest.spyOn(client, 'homeWriteEnd').mockImplementationOnce(async (...args) => {
      await end(...args);
      throw new Error('the answer was lost');
    });
    const result = await g.run('home', 'commit', '-qm', 'from the PC');
    await g.confirmed();
    const calls = spy.mock.calls.map((call) => call[2].writeId);
    spy.mockRestore();
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const writeId = calls[0];
    expect(calls).toEqual([writeId, writeId]);
    const record = g.vm();
    expect(record).toMatchObject({ owner: 'home', checkpoint: { writeId } });
    expect(Object.keys(record.confirmedWrites ?? {}).filter((id) => id === writeId)).toHaveLength(
      1,
    );
  });

  it('runs a hook that spawns Git inside the same write without a deadlock', async () => {
    const hook = join(g.root('home'), '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hook,
      '#!/bin/sh\necho made by the hook > hook.txt\ngit add hook.txt && git rev-parse HEAD >/dev/null\n',
      { mode: 0o755 },
    );
    g.write('home', 'e.txt', 'e\n');
    expect((await g.run('home', 'add', 'e.txt')).code).toBe(0);
    const result = await g.run('home', 'commit', '-qm', 'hooked');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(g.real('home', 'show', '--name-only', '--format=', 'HEAD')).toBe('e.txt\nhook.txt');
    await g.confirmed();
    expect(g.vm().owner).toBe('home');
    writeFileSync(hook, '#!/bin/sh\n', { mode: 0o755 });
  });

  it('returns before the VM confirms, keeps the write in flight until sync resumes, and the VM then takes Git back', async () => {
    await pauseVmCode(true);
    try {
      g.write('home', 'f.txt', 'waits for the VM\n');
      expect(await g.run('home', 'add', 'f.txt')).toMatchObject({ code: 0, stderr: '' });
      // The VM has not received f.txt, so the write is still unconfirmed on both sides.
      expect(homeWrites()).toHaveLength(1);
      expect(Object.keys(g.vm().homeWrites)).toHaveLength(1);
    } finally {
      await pauseVmCode(false);
    }
    await g.confirmed(60_000);
    expect(await g.run('vm', 'commit', '-qm', 'agent takes Git back')).toMatchObject({ code: 0 });
    expect(g.vm().owner).toBe('vm');
    expect(g.real('vm', 'show', '--name-only', '--format=', 'HEAD')).toContain('f.txt');
    await stepsDown();
  });

  it('Ctrl-C while a handover waits for VM Git aborts it before the flip', async () => {
    const agent = g.start('vm', ['hash-object', '-w', '--stdin'], { stdin: true });
    await waitForValue(async () => Object.keys(g.vm().vmHolds).length > 0, 10_000);
    g.write('home', 'g.txt', 'never written\n');
    const write = g.start('home', ['add', 'g.txt']);
    await waitForValue(async () => g.vm().transition?.kind === 'handover', 10_000);
    const interrupted = Date.now();
    write.child.kill('SIGINT');
    expect(await write.result).toMatchObject({ code: 130 });
    expect(Date.now() - interrupted).toBeLessThan(5_000);
    await waitForValue(async () => g.vm().transition === null, 10_000);
    expect(g.vm().owner).toBe('vm');
    expect(existsSync(join(g.root('vm'), '.git', 'hooks', 'reference-transaction'))).toBe(false);
    expect(homeWrites()).toEqual([]);
    expect(g.real('home', 'diff', '--cached', '--name-only')).not.toContain('g.txt');
    agent.child.stdin!.end('blob\n');
    expect((await agent.result).code).toBe(0);
  });

  it.each([
    ['the supervisor goes away once the VM is receiving', 'home-sending'],
    ['home DevChain restarts once the VM has published', 'published'],
  ] as const)('never loses a home write after the flip when %s', async (loss, held) => {
    const client = g.pair.home.app.get(RemoteHostClient);
    const handoverPhase = client.handoverPhase.bind(client);
    let release!: () => void;
    const released = new Promise<void>((done) => (release = done));
    const spy = jest.spyOn(client, 'handoverPhase').mockImplementation(async (...args) => {
      if (args[2].phase !== held) return handoverPhase(...args);
      if (held === 'home-sending') {
        await released;
        return handoverPhase(...args);
      }
      // The VM publishes the write; home stops before it hears the answer.
      await handoverPhase(...args);
      throw new Error('home DevChain stopped');
    });
    g.write('home', `${held}.txt`, 'after the flip\n');
    const write = g.start('home', ['add', `${held}.txt`]);
    await waitForValue(
      async () =>
        g.vm().transition?.phase === (held === 'home-sending' ? 'vm-receiving' : 'published'),
      30_000,
    );
    if (held === 'home-sending') {
      write.child.kill('SIGINT');
      await write.result;
      // Home must see the closed request before the handover goes on.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
    } else {
      expect((await write.result).code).toBe(1);
      spy.mockRestore();
      await g.restartHome();
    }
    await waitForValue(async () => {
      const vm = g.vm();
      return vm.owner === 'home' && !vm.transition && Object.keys(vm.homeWrites).length === 0;
    }, 60_000);
    spy.mockRestore();
    g.write('vm', `${held}-vm.txt`, 'agent\n');
    expect(await g.run('vm', 'add', `${held}-vm.txt`)).toMatchObject({ code: 0, stderr: '' });
    expect(g.vm().owner).toBe('vm');
    await stepsDown();
  });

  it('a VM DevChain restart with a live Git hold blocks a handover until that Git exits', async () => {
    const agent = g.start('vm', ['hash-object', '-w', '--stdin'], { stdin: true });
    await waitForValue(async () => Object.keys(g.vm().vmHolds).length > 0, 10_000);
    await g.restartHost();
    g.write('home', 'h.txt', 'after the VM git\n');
    const write = g.start('home', ['add', 'h.txt']);
    let finished = false;
    void write.result.then(() => (finished = true));
    await waitForValue(async () => g.vm().transition?.kind === 'handover', 15_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(finished).toBe(false);
    expect(Object.keys(g.vm().vmHolds)).toHaveLength(1);
    expect(g.vm().transition).toMatchObject({ phase: 'draining' });
    agent.child.stdin!.end('blob\n');
    expect((await agent.result).code).toBe(0);
    expect(await write.result).toMatchObject({ code: 0, stderr: '' });
    await g.confirmed();
    expect(g.vm().owner).toBe('home');
  });

  it('during a PC rebase, a VM write waits and fails with the middle-of-a-rebase line', async () => {
    const pc = async (...args: string[]) => (await g.run('home', ...args)).code;
    expect(await pc('add', '-A')).toBe(0);
    expect(await pc('commit', '-qm', 'h')).toBe(0);
    expect(await pc('switch', '-qc', 'topic')).toBe(0);
    g.write('home', 'r.txt', 'topic\n');
    expect(await pc('add', 'r.txt')).toBe(0);
    expect(await pc('commit', '-qm', 'topic')).toBe(0);
    expect(await pc('switch', '-q', 'main')).toBe(0);
    g.write('home', 'r.txt', 'main\n');
    expect(await pc('add', 'r.txt')).toBe(0);
    expect(await pc('commit', '-qm', 'main')).toBe(0);
    expect(await pc('switch', '-q', 'topic')).toBe(0);
    expect(await pc('rebase', 'main')).not.toBe(0);
    expect(existsSync(join(g.root('home'), '.git', 'rebase-merge'))).toBe(true);
    await waitForValue(
      async () =>
        existsSync(join(g.root('vm'), '.git', 'rebase-merge')) &&
        Object.keys(g.vm().homeWrites).length === 0,
      30_000,
    );
    g.write('vm', 'i.txt', 'agent\n');
    const blocked = await g.run('vm', 'add', 'i.txt');
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.trim().split('\n')).toEqual([
      `git: Git is on PC '${g.vm().homeName}': Git there is in the middle of a rebase.`,
    ]);
    expect(await pc('rebase', '--abort')).toBe(0);
    expect(await pc('switch', '-q', 'main')).toBe(0);
    await waitForValue(async () => !existsSync(join(g.root('vm'), '.git', 'rebase-merge')), 30_000);
    await g.confirmed();
    expect(await g.run('vm', 'add', 'i.txt')).toMatchObject({ code: 0, stderr: '' });
    expect(g.vm().owner).toBe('vm');
    await stepsDown();
  });

  it('a lane commit waits while the PC owns Git, and a PC change to a VM lane branch is refused', async () => {
    const lanes = g.pair.host.app.get(WorktreesService);
    const lane = await lanes.create(g.projectId, g.seed.leadAgentId, { name: 'lane' });
    writeFileSync(join(lane.path, 'lane.txt'), 'lane work\n');
    const laneHead = g.real('vm', 'rev-parse', lane.branch);
    const pcWrite = g.start('home', ['hash-object', '-w', '--stdin'], { stdin: true });
    await waitForValue(async () => g.vm().owner === 'home', 30_000);
    await expect(
      lanes.commit(g.projectId, g.seed.leadAgentId, 'lane', 'lane commit'),
    ).rejects.toMatchObject({
      code: 'GIT_VM_ACQUIRE_TIMEOUT',
    });
    expect(g.real('vm', 'rev-parse', lane.branch)).toBe(laneHead);
    pcWrite.child.stdin!.end('blob\n');
    expect((await pcWrite.result).code).toBe(0);
    await g.confirmed();
    await lanes.commit(g.projectId, g.seed.leadAgentId, 'lane', 'lane commit');
    const committed = g.real('vm', 'rev-parse', lane.branch);
    expect(committed).not.toBe(laneHead);
    await stepsDown();
    await waitForValue(async () => {
      try {
        return g.real('home', 'rev-parse', lane.branch) === committed;
      } catch {
        return false;
      }
    }, 30_000);

    const refused = await g.run('home', 'branch', '-f', lane.branch, 'HEAD');
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(lane.branch);
    expect(g.vm().owner).toBe('home');
    expect(g.real('home', 'rev-parse', lane.branch)).toBe(committed);
    expect(g.real('vm', 'rev-parse', lane.branch)).toBe(committed);
  });

  it('power-off after confirm: the VM takes Git back, and the restarted PC steps down without moving it', async () => {
    expect(
      await g.run('home', 'commit', '--allow-empty', '-qm', 'confirmed on the PC'),
    ).toMatchObject({
      code: 0,
      stderr: '',
    });
    await g.confirmed();
    expect(g.vm().owner).toBe('home');
    await g.pair.home.close();
    g.write('vm', 'k.txt', 'agent while the PC is off\n');
    expect(await g.run('vm', 'add', 'k.txt')).toMatchObject({ code: 0, stderr: '' });
    expect(await g.run('vm', 'commit', '-qm', 'agent while the PC is off')).toMatchObject({
      code: 0,
      stderr: '',
    });
    const record = g.vm();
    expect(record.owner).toBe('vm');
    await g.restartHome();
    await stepsDown();
    const head = g.real('vm', 'rev-parse', 'HEAD');
    await waitForValue(async () => g.real('home', 'rev-parse', 'HEAD') === head, 30_000);
    expect(g.real('home', 'ls-files', '--stage')).toBe(g.real('vm', 'ls-files', '--stage'));
    // Upkeep keeps following the VM record after the restart.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await folderType(g, 'vm', 'git')).toBe('sendonly');
    expect(await folderType(g, 'home', 'git')).toBe('receiveonly');
    expect(g.vm()).toMatchObject({ owner: 'vm', generation: record.generation });
  });
});

real('Git reclaim after the PC goes offline', () => {
  // Only the two-instance fixture exercises both the supervised process lifetimes and the VM
  // rollback against files that actually arrived from the paused rebase.
  it('keeps the last quiet baseline while a supervised PC rebase is still live', async () => {
    const graceMs = 5_000;
    const g = await startGitOwnership({ vmGraceMs: graceMs, vmAcquireMs: 2_500 });
    const rebases: { git: RunningGit; release: string }[] = [];
    try {
      const { home, host } = g.pair;
      const client = home.app.get(RemoteHostClient);
      const homeFiles = home.app.get(FileSyncService);
      const vmFiles = host.app.get(FileSyncService);
      const writes = home.app.get(HomeGitWriteService);
      const indexes = host.app.get(GitCoordinatorIndexService);
      const directory = indexes.directory(g.projectId);
      const snapshot = () => ({
        baseline: readFileSync(join(directory, 'baseline.json')),
        index: readFileSync(join(directory, 'index')),
        vmIndex: readFileSync(join(g.root('vm'), '.git', 'index')),
        identity: g.vm().baseline,
        checkpoint: g.vm().checkpoint,
      });
      const pc = async (...args: string[]) =>
        expect(await g.run('home', ...args)).toMatchObject({ code: 0 });
      await pc('switch', '-qc', 'topic');
      await pc('commit', '--allow-empty', '-qm', 'topic commit');
      await pc('switch', '-q', 'main');
      g.write('home', 'main.txt', 'main work\n');
      await pc('add', 'main.txt');
      await pc('commit', '-qm', 'advance main');
      await pc('switch', '-qc', 'next');
      g.write('home', 'next.txt', 'next work\n');
      await pc('add', 'next.txt');
      await pc('commit', '-qm', 'advance next');
      await pc('switch', '-q', 'topic');
      await g.confirmed();

      const overlap = async (target: string) => {
        const before = snapshot();
        const ready = join(g.pair.rootDir, `rebase-${target}-ready`);
        const release = join(g.pair.rootDir, `rebase-${target}-release`);
        const script = join(g.pair.rootDir, `rebase-${target}.sh`);
        writeFileSync(
          script,
          `touch "${ready}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\n`,
        );
        const git = g.start('home', ['rebase', '--exec', `sh "${script}"`, target]);
        rebases.push({ git, release });
        await waitForValue(async () => existsSync(ready), 15_000);
        const [longId] = Object.keys(g.vm().homeWrites);
        expect(longId).toBeDefined();

        await pc('config', '--local', 'test.checkpoint', target);
        const shortId = Object.keys(g.vm().homeWrites).find((id) => id !== longId)!;
        expect(shortId).toBeDefined();
        await waitForValue(
          async () => writes.lastError(g.projectId) || g.vm().checkpoint?.writeId === shortId,
          30_000,
        );
        expect(g.vm().homeWrites).toHaveProperty(longId);
        expect(g.vm().homeWrites).toHaveProperty(shortId);
        expect(snapshot()).toEqual(before);
        expect(writes.lastError(g.projectId)).toBe(
          'another Git command on the PC is still running',
        );
        return { git, release, before, shortId, longId };
      };

      const online = await overlap('main');
      writeFileSync(online.release, '');
      expect(await online.git.result).toMatchObject({ code: 0 });
      await g.confirmed();
      expect(g.vm().confirmedWrites).toHaveProperty(online.longId);
      expect(g.vm().confirmedWrites).toHaveProperty(online.shortId);
      const baseline = await indexes.readBaseline(g.projectId);
      expect(baseline.refsDigest).not.toBe(online.before.identity?.refsDigest);
      expect(baseline.sequencer).toEqual([]);
      const refs = g.real('vm', 'for-each-ref', '--format=%(refname) %(objectname)');

      const offline = await overlap('next');
      const root = g.root('home');
      const digest = await refsDigest(home.app.get(ProcessExecutor), root);
      const vmExecutor = host.app.get(ProcessExecutor);
      await homeFiles.rescan(projectFolderId(g.projectId, 'git'));
      await waitForValue(
        async () =>
          existsSync(join(g.root('vm'), '.git', 'rebase-merge')) &&
          (await refsDigest(vmExecutor, g.root('vm'))) === digest,
        30_000,
      );
      const fence = { expectedGeneration: g.vm().generation, transitionId: null };
      await expect(
        client.homeWriteEnd(g.remote.id, g.projectId, {
          ...fence,
          writeId: offline.shortId,
          refsDigest: digest,
          indexBase64: readFileSync(join(root, '.git', 'index')).toString('base64'),
        }),
      ).rejects.toMatchObject({ status: 409, hostCode: 'GIT_CHECKPOINT_INCOMPLETE' });
      expect(snapshot()).toEqual(offline.before);
      const device = homeFiles.device().deviceId;
      await client.homeRenew(g.remote.id, g.projectId, fence);
      const expires = Date.now() + graceMs;
      await home.close();
      await waitForValue(async () => !(await vmFiles.isConnected(device)), 15_000);
      await waitForValue(async () => Date.now() >= expires, graceMs);

      g.write('vm', 'after-reclaim.txt', 'VM work after the PC disappeared\n');
      expect(await g.run('vm', 'add', 'after-reclaim.txt')).toMatchObject({
        code: 0,
        stderr: expect.stringContaining('this VM took Git back'),
      });
      expect(g.vm()).toMatchObject({
        owner: 'vm',
        forcedReclaim: { fromGeneration: fence.expectedGeneration },
      });
      expect(g.real('vm', 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs);
    } finally {
      for (const { release } of rebases) writeFileSync(release, '');
      await Promise.all(rebases.map(({ git }) => git.result));
      await g.close();
    }
  });

  it.each(['before confirm', 'in home-sending', 'in published'] as const)(
    'waits for the lease and restores the VM baseline when the PC powers off %s',
    async (outage) => {
      const graceMs = 10_000;
      const g = await startGitOwnership({ vmAcquireMs: 2_500, vmGraceMs: graceMs });
      try {
        const { home, host } = g.pair;
        const client = home.app.get(RemoteHostClient);
        const homeFiles = home.app.get(FileSyncService);
        const vmFiles = host.app.get(FileSyncService);
        const gitId = projectFolderId(g.projectId, 'git');
        const pc = homeFiles.device().deviceId;
        let unconfirmedHead: string | undefined;
        let stagedEntries: string | undefined;
        if (outage === 'before confirm') {
          expect(
            await g.run('home', 'commit', '--allow-empty', '-qm', 'confirmed PC state'),
          ).toMatchObject({ code: 0 });
          await g.confirmed();
          jest
            .spyOn(client, 'homeWriteEnd')
            .mockRejectedValue(new Error('confirmation answer lost'));
          expect(
            await g.run('home', 'commit', '--allow-empty', '-qm', 'unconfirmed PC state'),
          ).toMatchObject({ code: 0 });
          unconfirmedHead = g.real('home', 'rev-parse', 'HEAD');
          await homeFiles.rescan(gitId);
          await waitForValue(
            async () => g.real('vm', 'rev-parse', 'HEAD') === unconfirmedHead,
            30_000,
          );
          g.write('home', 'staged-only.txt', 'PC staging before reclaim\n');
          g.real('home', 'update-index', '--split-index');
          g.real('home', 'add', 'staged-only.txt');
          stagedEntries = g.real('home', 'ls-files', '--stage');
          expect(stagedEntries).toContain('\tstaged-only.txt');
          g.real('home', 'branch', 'pc-only', unconfirmedHead);
          g.real(
            'home',
            '-c',
            'core.preferSymlinkRefs=true',
            'symbolic-ref',
            'refs/heads/pc-alias',
            'refs/heads/pc-only',
          );
          expect(readlinkSync(join(g.root('home'), '.git', 'refs', 'heads', 'pc-alias'))).toBe(
            'refs/heads/pc-only',
          );
          expect(g.real('home', 'rev-parse', 'refs/heads/pc-alias')).toBe(unconfirmedHead);
        } else {
          const phase = client.handoverPhase.bind(client);
          jest.spyOn(client, 'handoverPhase').mockImplementation(async (...args) => {
            const publishing = args[2].phase === 'published';
            if (publishing && outage === 'in home-sending') throw new Error('PC went offline');
            const record = await phase(...args);
            if (publishing) throw new Error('PC went offline before receiving publication');
            return record;
          });
          expect(
            await g.run('home', 'commit', '--allow-empty', '-qm', 'interrupted handover'),
          ).toMatchObject({ code: 1 });
          expect(g.vm().transition?.phase).toBe(
            outage === 'in home-sending' ? 'home-sending' : 'published',
          );
          expect(g.homeCache().owner).toBe('vm');
          expect(await folderType(g, 'home', 'git')).toBe('sendonly');
          if (outage === 'in home-sending') {
            g.real(
              'home',
              '-c',
              'core.preferSymlinkRefs=true',
              'symbolic-ref',
              'HEAD',
              'refs/heads/pc-unborn',
            );
            expect(readlinkSync(join(g.root('home'), '.git', 'HEAD'))).toBe('refs/heads/pc-unborn');
          }
        }

        const before = g.vm();
        const baseline = await host.app.get(GitCoordinatorIndexService).readBaseline(g.projectId);
        const expectedRefs = new Map(baseline.refs.map(({ name, oid }) => [name, oid]));
        const confirmedHead = expectedRefs.get('refs/heads/main');
        if (!confirmedHead) throw new Error('The fixture baseline has no main branch');
        if (unconfirmedHead) expect(unconfirmedHead).not.toBe(confirmedHead);
        const fence = {
          expectedGeneration: before.generation,
          transitionId: before.transition?.id ?? null,
        };
        expect(await vmFiles.isConnected(pc)).toBe(true);
        // Start a known grace window while the PC is still online so shutdown time is included.
        const earliestExpiry = Date.now() + graceMs;
        if (before.transition) await client.handoverRenew(g.remote.id, g.projectId, fence);
        else await client.homeRenew(g.remote.id, g.projectId, fence);
        const latestExpiry = Date.now() + graceMs;
        await home.close();
        await waitForValue(async () => !(await vmFiles.isConnected(pc)), 15_000);

        g.write('vm', 'offline.txt', 'VM work while the PC is gone\n');
        const blocked = await g.run('vm', 'add', 'offline.txt');
        const reason = before.transition
          ? 'a home handover is pending'
          : 'a home Git write is unconfirmed';
        expect(blocked.code).toBe(1);
        expect(blocked.stderr.trim().split('\n')).toEqual([
          expect.stringMatching(
            /takes Git back at \d{2}:\d{2}:\d{2} \(in [1-9]\d* s\).*Wait until then and run the same command again\. Do not stop your task\.$/,
          ),
        ]);
        expect(blocked.stderr).toContain(
          `git: Git is on PC '${before.homeName}': ${reason}. This is temporary:`,
        );
        expect(g.vm().generation).toBe(before.generation);

        if (outage === 'in home-sending') {
          await waitForValue(async () => Date.now() >= earliestExpiry - 1_000, graceMs);
          let waitedInsideGrace = false;
          const isConnected = vmFiles.isConnected.bind(vmFiles);
          const probe = jest.spyOn(vmFiles, 'isConnected').mockImplementation(async (device) => {
            if (Date.now() < earliestExpiry) waitedInsideGrace = true;
            return isConnected(device);
          });
          const lane = await host.app
            .get(WorktreesService)
            .create(g.projectId, g.seed.leadAgentId, { name: 'offline-lane' });
          probe.mockRestore();
          expect(waitedInsideGrace).toBe(true);
          expect(g.real('vm', 'rev-parse', lane.branch)).toBe(confirmedHead);
          expectedRefs.set(`refs/heads/${lane.branch}`, confirmedHead);
        } else {
          await waitForValue(async () => Date.now() >= latestExpiry, graceMs);
        }
        expect(await g.run('vm', 'add', 'offline.txt')).toMatchObject({ code: 0 });
        expect(g.real('vm', 'rev-parse', 'HEAD')).toBe(confirmedHead);
        expect(await g.run('vm', 'commit', '-qm', 'VM work after reclaim')).toMatchObject({
          code: 0,
        });
        expect(g.real('vm', 'rev-parse', 'HEAD^')).toBe(confirmedHead);
        expectedRefs.set('refs/heads/main', g.real('vm', 'rev-parse', 'HEAD'));
        const refs = g.real('vm', 'for-each-ref', '--format=%(refname) %(objectname)').split('\n');
        expect(new Map(refs.map((line) => line.split(' ', 2) as [string, string]))).toEqual(
          expectedRefs,
        );

        const reclaimed = g.vm();
        expect(reclaimed).toMatchObject({
          owner: 'vm',
          generation: before.generation + 1,
          transition: null,
          homeWrites: {},
          forcedReclaim: {
            fromGeneration: before.generation,
            homeName: before.homeName,
            at: expect.any(Number),
          },
        });
        for (const writeId of Object.keys(before.homeWrites))
          expect(reclaimed.supersededWrites?.[writeId]).toMatchObject({
            generation: before.generation,
          });
        if (before.transition)
          expect(reclaimed.supersededHandovers).toContain(before.transition.id);
        expect(home.isClosed()).toBe(true);

        await g.restartHome();
        await waitForValue(async () => g.homeCache().generation === reclaimed.generation, 30_000);
        expect(g.homeCache().owner).toBe('vm');
        expect(await folderType(g, 'home', 'git')).toBe('receiveonly');
        const homeApp = g.pair.home.app;
        const executor = homeApp.get(ProcessExecutor);
        expect(await refsDigest(executor, g.root('home'))).toBe(
          await refsDigest(host.app.get(ProcessExecutor), g.root('vm')),
        );
        const savedWrites = homeApp.get(HomeGitWriteStore).list();
        expect(savedWrites.filter((write) => write.projectId === g.projectId)).toEqual([]);

        const paths = homeApp.get<FileSyncPaths>(FILE_SYNC_PATHS);
        const backups = join(dirname(paths.syncthingHome()), 'backups', 'git', g.projectId);
        const entries = readdirSync(backups);
        expect(entries).toHaveLength(1);
        const backup = join(backups, entries[0]);
        expect(readdirSync(backup)).toEqual(
          expect.arrayContaining(['HEAD', 'refs', 'objects', 'config', 'index', 'recovery.json']),
        );
        expect(JSON.parse(readFileSync(join(backup, 'recovery.json'), 'utf8'))).toEqual({
          projectId: g.projectId,
          remoteId: g.remote.id,
          pcName: before.homeName,
          createdAt: expect.any(Number),
          state: 'pending',
        });
        if (stagedEntries) {
          expect(g.real('home', 'for-each-ref', 'refs/heads/pc-only', 'refs/heads/pc-alias')).toBe(
            '',
          );
          expect(g.real('home', '--git-dir', backup, 'rev-parse', 'refs/heads/pc-alias')).toBe(
            unconfirmedHead,
          );
          expect(g.real('home', '--git-dir', backup, 'symbolic-ref', 'refs/heads/pc-alias')).toBe(
            'refs/heads/pc-only',
          );
          const indexEntries = execFileSync('git', ['--git-dir', backup, 'ls-files', '--stage'], {
            cwd: g.root('home'),
            encoding: 'utf8',
            env: {
              ...process.env,
              DEVCHAIN_GIT_BYPASS: '1',
              GIT_INDEX_FILE: join(backup, 'index'),
            },
          });
          expect(indexEntries.trim()).toBe(stagedEntries);
        }
        if (outage === 'in home-sending') {
          expect(g.real('home', 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
          expect(g.real('home', '--git-dir', backup, 'symbolic-ref', 'HEAD')).toBe(
            'refs/heads/pc-unborn',
          );
          expect(g.real('home', '--git-dir', backup, 'for-each-ref', 'refs/heads/pc-unborn')).toBe(
            '',
          );
        }
      } finally {
        jest.restoreAllMocks();
        await g.close();
      }
    },
  );
});

real('Git step-down after the PC and VM diverge', () => {
  it('backs up the PC-only branch and settles on the VM refs and commit', async () => {
    const settleMs = 30_000;
    // Keep the PC send-only until both Syncthing indexes have seen the divergent writes.
    const g = await startGitOwnership({
      homeWrites: { stepDownPollMs: 5 * 60_000 },
      stepDownSettleMs: settleMs,
    });
    try {
      expect(await g.run('home', 'commit', '--allow-empty', '-qm', 'PC checkpoint')).toMatchObject({
        code: 0,
      });
      await g.confirmed();
      const homeRecord = g.vm();
      expect(homeRecord.owner).toBe('home');

      expect(await g.run('vm', 'commit', '--allow-empty', '-qm', 'VM-only commit')).toMatchObject({
        code: 0,
      });
      const reclaimed = g.vm();
      expect(reclaimed).toMatchObject({ owner: 'vm', generation: homeRecord.generation + 1 });
      expect(g.homeCache()).toEqual({ owner: 'home', generation: homeRecord.generation });
      expect(await folderType(g, 'vm', 'git')).toBe('sendonly');
      expect(await folderType(g, 'home', 'git')).toBe('sendonly');

      g.real('home', 'commit', '--allow-empty', '-qm', 'PC-only commit');
      const pcCommit = g.real('home', 'rev-parse', 'HEAD');
      g.real('home', 'branch', 'pc-only');
      const vmCommit = g.real('vm', 'rev-parse', 'HEAD');
      expect(() => g.real('home', 'cat-file', '-e', vmCommit)).toThrow();
      expect(() => g.real('vm', 'cat-file', '-e', pcCommit)).toThrow();
      expect(g.real('vm', 'branch', '--list', 'pc-only')).toBe('');

      const gitId = projectFolderId(g.projectId, 'git');
      const home = g.pair.home.app;
      const vm = g.pair.host.app;
      const homeFiles = home.get(FileSyncService);
      const vmFiles = vm.get(FileSyncService);
      await Promise.all([homeFiles.rescan(gitId), vmFiles.rescan(gitId)]);
      // A real Syncthing peer must receive the PC's extra index entries to exercise the settle check.
      await waitForValue(async () => {
        const status = await vmFiles.status(gitId);
        return status.globalFiles > status.localFiles;
      }, 30_000);

      const started = Date.now();
      await home.get(HomeGitWriteService).stepDownIfReclaimed(g.projectId, g.remote.id);
      expect(Date.now() - started).toBeLessThan(settleMs);
      expect(g.homeCache()).toEqual({ owner: 'vm', generation: reclaimed.generation });
      expect(await folderType(g, 'home', 'git')).toBe('receiveonly');
      expect(await refsDigest(home.get(ProcessExecutor), g.root('home'))).toBe(
        await refsDigest(vm.get(ProcessExecutor), g.root('vm')),
      );
      expect(g.real('home', 'branch', '--list', 'pc-only')).toBe('');
      const backups = join(
        dirname(home.get<FileSyncPaths>(FILE_SYNC_PATHS).syncthingHome()),
        'backups',
        'git',
        g.projectId,
      );
      const [backup] = readdirSync(backups);
      expect(
        g.real(
          'home',
          '--git-dir',
          join(backups, backup),
          'rev-parse',
          'refs/heads/pc-only^{commit}',
        ),
      ).toBe(pcCommit);
      expect(g.real('home', 'cat-file', '-t', vmCommit)).toBe('commit');
    } finally {
      await g.close();
    }
  });
});

real('Disconnect after a forced Git reclaim', () => {
  it('saves a staged deletion before Disconnect can rebuild the index', async () => {
    const graceMs = 5_000;
    const g = await startGitOwnership({
      vmGraceMs: graceMs,
      recoverBackups: true,
      homeWrites: { stepDownPollMs: 60_000, homeRenewMs: 60_000 },
    });
    try {
      const { home, host } = g.pair;
      const client = home.app.get(RemoteHostClient);
      const withheld = jest
        .spyOn(client, 'homeWriteEnd')
        .mockRejectedValue(new Error('confirmation withheld'));
      expect(await g.run('home', 'rm', '--cached', 'a.txt')).toMatchObject({ code: 0 });
      expect(g.real('home', 'diff', '--cached', '--name-status')).toBe('D\ta.txt');
      const before = g.vm();
      const writes = Object.keys(before.homeWrites);
      expect(writes).toHaveLength(1);
      const bindings = home.app.get(RemoteBindingsService);
      const pc = home.app.get(FileSyncService).device().deviceId;
      const vmFiles = host.app.get(FileSyncService);
      const syncthing = host.app.get(SyncthingManager).getConnection()!.client;
      const pausePeer = (paused: boolean) =>
        syncthing.request('PATCH', `/rest/config/devices/${encodeURIComponent(pc)}`, { paused });
      await client.homeRenew(g.remote.id, g.projectId, {
        expectedGeneration: before.generation,
        transitionId: null,
      });
      const expires = Date.now() + graceMs;
      await pausePeer(true);
      await waitForValue(async () => !(await vmFiles.isConnected(pc)), 15_000);
      await waitForValue(async () => Date.now() >= expires, graceMs + 1_000);
      expect(
        await g.run('vm', 'commit', '--allow-empty', '-qm', 'VM work after reclaim'),
      ).toMatchObject({ code: 0 });
      expect(g.vm().supersededWrites?.[writes[0]]).toMatchObject({
        generation: before.generation,
      });
      await pausePeer(false);
      await waitForValue(() => vmFiles.isConnected(pc), 15_000);
      expect(g.homeCache()).toEqual({ owner: 'home', generation: before.generation });

      const started = await fetch(`${home.url}/api/remotes/${g.remote.id}/detach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: g.projectId }),
      });
      expect(started.status).toBe(202);
      const { id } = (await started.json()) as RemoteOperation;
      const operationUrl = `${home.url}/api/remotes/operations/${id}`;
      const terminal = () =>
        waitForValue(async () => {
          const operation = (await (await fetch(operationUrl)).json()) as RemoteOperation;
          return operation.state === 'failed' || operation.state === 'done' ? operation : null;
        }, 45_000);
      const refused = await terminal();
      expect(refused).toMatchObject({
        state: 'failed',
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'preflight',
            error: {
              code: 'GIT_RECOVERY_PENDING',
              message: expect.stringContaining('Run the Disconnect again'),
            },
          }),
        ]),
      });
      expect(await bindings.get(g.projectId)).toMatchObject({
        remoteId: g.remote.id,
        state: 'remote',
      });
      const list = () => home.app.get(HomeGitRecoveryService).list(g.projectId);
      const [saved] = await list();
      const paths = home.app.get<FileSyncPaths>(FILE_SYNC_PATHS);
      const backup = join(
        dirname(paths.syncthingHome()),
        'backups',
        'git',
        g.projectId,
        saved.time,
      );
      expect(readdirSync(backup)).toContain('recovery.json');
      expect(readdirSync(backup)).toContain('index');

      withheld.mockRestore();
      await waitForValue(
        async () =>
          (await list()).some(({ state }) => state === 'fetched' || state === 'recovered'),
        30_000,
      );
      await g.confirmed();
      // Run the next ownership check without waiting for the deliberately long poll interval.
      await home.app.get(HomeGitWriteService).stepDownIfReclaimed(g.projectId, g.remote.id);
      const recovered = await waitForValue(
        async () => (await list()).find(({ state }) => state === 'recovered'),
        30_000,
      );
      expect(recovered.refs).toEqual([
        expect.stringMatching(/^refs\/heads\/devchain-recovered\/.+\/staged$/),
      ]);
      const [staged] = recovered.refs;
      expect(g.real('vm', 'diff-tree', '--no-commit-id', '--name-status', '-r', staged)).toBe(
        'D\ta.txt',
      );

      expect((await fetch(`${operationUrl}/retry`, { method: 'POST' })).status).toBe(202);
      expect(await terminal()).toMatchObject({ state: 'done' });
      expect(await bindings.get(g.projectId)).toBeNull();
      expect(g.real('home', 'diff-tree', '--no-commit-id', '--name-status', '-r', staged)).toBe(
        'D\ta.txt',
      );
    } finally {
      jest.restoreAllMocks();
      await g.close();
    }
  });
});

real('Git backup recovery after a PC restart', () => {
  // Reboot both before the fetch and while its exact write is still waiting for the VM.
  it('recovers the original branch tips and staged tree through one home write', async () => {
    const graceMs = 5_000;
    const g = await startGitOwnership({
      vmGraceMs: graceMs,
      recoverBackups: true,
      homeWrites: { batchQuietMs: 1_000 },
    });
    try {
      const { home } = g.pair;
      expect(await g.run('home', 'commit', '--allow-empty', '-qm', 'saved PC work')).toMatchObject({
        code: 0,
      });
      await g.confirmed();
      const saved = g.real('home', 'rev-parse', 'HEAD');
      const client = home.app.get(RemoteHostClient);
      jest.spyOn(client, 'homeWriteEnd').mockRejectedValue(new Error('confirmation lost'));
      expect(
        await g.run('home', 'commit', '--allow-empty', '-qm', 'offline PC work'),
      ).toMatchObject({
        code: 0,
      });
      const pcTip = g.real('home', 'rev-parse', 'HEAD');
      g.real('home', 'branch', 'new-topic', saved);
      g.write('home', 'staged.txt', 'only staged on the PC\n');
      g.real('home', 'add', 'staged.txt');

      const before = g.vm();
      await client.homeRenew(g.remote.id, g.projectId, {
        expectedGeneration: before.generation,
        transitionId: null,
      });
      const expires = Date.now() + graceMs;
      await home.close();
      await waitForValue(async () => Date.now() >= expires, graceMs + 1_000);
      expect(
        await g.run('vm', 'commit', '--allow-empty', '-qm', 'work after reclaim'),
      ).toMatchObject({
        code: 0,
      });
      const vmTip = g.real('vm', 'rev-parse', 'HEAD');

      const pause = jest
        .spyOn(HomeGitRecoveryService.prototype, 'schedule')
        .mockImplementation(() => undefined);
      await g.restartHome();
      await waitForValue(
        () => Promise.resolve(g.homeCache().generation === g.vm().generation),
        30_000,
      );
      expect(g.homeCache().owner).toBe('vm');
      const app = () => g.pair.home.app;
      const recoveries = () => app().get(HomeGitRecoveryService).list(g.projectId);
      const [pending] = await recoveries();
      expect(pending.state).toBe('pending');
      const paths = app().get<FileSyncPaths>(FILE_SYNC_PATHS);
      const backups = join(dirname(paths.syncthingHome()), 'backups', 'git', g.projectId);
      const markerFile = join(backups, pending.time, 'recovery.json');
      const marker = () =>
        JSON.parse(readFileSync(markerFile, 'utf8')) as {
          writeId: string;
          state: string;
          refs: string[];
        };
      const superseded = join(backups, '1999-01-01T00-00-00-000Z');
      mkdirSync(superseded);
      writeFileSync(
        join(superseded, 'recovery.json'),
        JSON.stringify({
          projectId: g.projectId,
          remoteId: g.remote.id,
          pcName: pending.pcName,
          createdAt: Date.UTC(1999, 0, 1),
          state: 'fetched',
          refs: ['refs/heads/devchain-recovered/earlier/main'],
          writeId: Object.keys(before.homeWrites)[0],
        }),
      );
      const empty = join(backups, '2000-01-01T00-00-00-000Z');
      g.real('home', 'clone', '--quiet', '--bare', g.root('home'), empty);
      const blob = g.real('home', 'rev-parse', 'HEAD:a.txt');
      execFileSync('git', ['--git-dir', empty, 'update-index', '--index-info'], {
        input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ta.txt\n`).join(''),
        env: { ...process.env, GIT_INDEX_FILE: join(empty, 'index') },
      });
      writeFileSync(
        join(empty, 'recovery.json'),
        JSON.stringify({
          projectId: g.projectId,
          remoteId: g.remote.id,
          pcName: pending.pcName,
          createdAt: 946684800000,
          state: 'pending',
        }),
      );
      pause.mockRestore();

      await g.restartHome();
      jest
        .spyOn(app().get(RemoteHostClient), 'homeWriteEnd')
        .mockRejectedValue(new Error('confirmation paused for restart'));
      await waitForValue(async () => marker().state === 'fetched', 40_000);
      const fetched = marker();
      expect(app().get(HomeGitWriteStore).get(fetched.writeId)).toMatchObject({
        projectId: g.projectId,
        remoteId: g.remote.id,
      });
      const knownWrites = Object.keys(g.vm().confirmedWrites ?? {});
      expect(
        (await recoveries()).find(({ time }) => time === '2000-01-01T00-00-00-000Z'),
      ).toMatchObject({
        state: 'nothing',
        refs: [],
        stagedSkipped: 'conflicts',
      });

      await g.restartHome();
      await waitForValue(async () => marker().state === 'recovered', 40_000);
      expect(marker()).toEqual({ ...fetched, state: 'recovered' });
      expect(
        (await recoveries()).find(({ time }) => time === '1999-01-01T00-00-00-000Z')?.state,
      ).toBe('fetched');
      expect(Object.keys(g.vm().confirmedWrites ?? {}).sort()).toEqual(
        [...knownWrites, fetched.writeId].sort(),
      );
      const ns = `refs/heads/devchain-recovered/${pending.pcName}-${pending.time}/`;
      expect(fetched.refs).toEqual([`${ns}main`, `${ns}new-topic`, `${ns}staged`]);
      expect(
        g.real('vm', 'for-each-ref', '--format=%(refname)', 'refs/heads/devchain-recovered'),
      ).toBe(fetched.refs.join('\n'));
      expect(g.real('vm', 'rev-parse', `${ns}main`)).toBe(pcTip);
      expect(g.real('vm', 'rev-parse', `${ns}new-topic`)).toBe(saved);
      expect(g.real('vm', 'rev-parse', `${ns}staged^`)).toBe(pcTip);
      expect(g.real('vm', 'show', `${ns}staged:staged.txt`)).toBe('only staged on the PC');
      expect(g.real('vm', 'rev-parse', 'refs/heads/main')).toBe(vmTip);
    } finally {
      jest.restoreAllMocks();
      await g.close();
    }
  });

  // The stash object can survive locally without its recovery ref or a confirmed write.
  it.each(['marker publication is interrupted', 'the fetched write is superseded'] as const)(
    'recovers the same saved stash ref when %s',
    async (scenario) => {
      const graceMs = 5_000;
      const g = await startGitOwnership({ vmGraceMs: graceMs, recoverBackups: true });
      try {
        const { home } = g.pair;
        const client = home.app.get(RemoteHostClient);
        jest.spyOn(client, 'homeWriteEnd').mockRejectedValue(new Error('confirmation paused'));
        const seed = join(g.pair.rootDir, 'saved-project');
        g.real('home', 'clone', '--quiet', g.root('home'), seed);
        writeFileSync(join(seed, 'a.txt'), 'only in the saved stash\n');
        g.real(
          'home',
          '-C',
          seed,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.test',
          'stash',
          'push',
          '-qm',
          'saved stash',
        );
        const stash = g.real('home', '-C', seed, 'rev-parse', 'refs/stash');
        const paths = home.app.get<FileSyncPaths>(FILE_SYNC_PATHS);
        const time = '2026-11-21T17-00-00-000Z';
        const backups = join(dirname(paths.syncthingHome()), 'backups', 'git', g.projectId);
        const backup = join(backups, time);
        mkdirSync(backups, { recursive: true });
        renameSync(join(seed, '.git'), backup);
        const file = join(backup, 'recovery.json');
        const marker = () =>
          JSON.parse(readFileSync(file, 'utf8')) as {
            state: string;
            writeId: string;
            refs: string[];
          };
        const ref = `refs/heads/devchain-recovered/PC-${time}/stash`;
        let interrupted = false;
        const journal = HomeGitRecoveryService.prototype as unknown as {
          save(directory: string, marker: { state: string }): Promise<void>;
        };
        const save = journal.save;
        const publication = jest.spyOn(journal, 'save').mockImplementation(function (
          this: HomeGitRecoveryService,
          directory,
          marker,
        ) {
          if (
            scenario === 'marker publication is interrupted' &&
            directory === backup &&
            marker.state === 'fetched'
          ) {
            interrupted = true;
            return Promise.reject(new Error('interrupted after Git exited successfully'));
          }
          return save.call(this, directory, marker);
        });
        writeFileSync(
          file,
          JSON.stringify({
            projectId: g.projectId,
            remoteId: g.remote.id,
            pcName: 'PC',
            createdAt: Date.parse('2026-11-21T17:00:00.000Z'),
            state: 'pending',
          }),
        );
        await waitForValue(
          async () =>
            scenario === 'marker publication is interrupted'
              ? interrupted
              : marker().state === 'fetched',
          40_000,
        );
        const first = marker();
        expect(first).toMatchObject({
          state: interrupted ? 'pending' : 'fetched',
          writeId: expect.any(String),
          refs: [ref],
        });
        expect(g.real('home', 'rev-parse', ref)).toBe(stash);

        if (scenario === 'the fetched write is superseded') {
          await waitForValue(
            async () =>
              g.real('vm', 'for-each-ref', '--format=%(objectname)', ref) === stash &&
              (await g.run('vm', 'cat-file', '-t', stash)).stdout.trim() === 'commit',
            30_000,
          );
          await client.homeRenew(g.remote.id, g.projectId, {
            expectedGeneration: g.vm().generation,
            transitionId: null,
          });
          const expires = Date.now() + graceMs;
          await home.close();
          await waitForValue(async () => Date.now() >= expires, graceMs + 1_000);
          expect(
            await g.run('vm', 'commit', '--allow-empty', '-qm', 'VM took recovery back'),
          ).toMatchObject({ code: 0 });
          expect(g.vm().supersededWrites?.[first.writeId]).toBeDefined();
          expect(g.real('vm', 'for-each-ref', ref)).toBe('');
          expect(g.real('vm', 'cat-file', '-t', stash)).toBe('commit');
        }
        await home.close();
        publication.mockRestore();
        await g.restartHome();
        await waitForValue(async () => marker().state === 'recovered', 45_000);
        const recovered = marker();
        expect(recovered.refs).toEqual([ref]);
        if (interrupted) expect(recovered.writeId).toBe(first.writeId);
        else expect(recovered.writeId).not.toBe(first.writeId);
        expect(Object.keys(g.vm().confirmedWrites ?? {})).toEqual([recovered.writeId]);
        expect(
          g.real('vm', 'for-each-ref', '--format=%(refname)', 'refs/heads/devchain-recovered'),
        ).toBe(ref);
        expect(g.real('vm', 'rev-parse', ref)).toBe(stash);
        expect(g.real('vm', 'show', `${ref}:a.txt`)).toBe('only in the saved stash');
      } finally {
        jest.restoreAllMocks();
        await g.close();
      }
    },
  );
});
