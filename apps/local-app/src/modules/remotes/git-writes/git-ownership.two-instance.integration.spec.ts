import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { WorktreesService } from '../../worktrees/worktrees.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { HomeGitWriteStore } from './home-git-write.store';
import {
  folderType,
  startGitOwnership,
  syncthingBinary,
  type GitOwnershipPair,
  type GitResult,
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

  it('power-off before confirm: a VM write fails with one line until the PC returns', async () => {
    const client = g.pair.home.app.get(RemoteHostClient);
    jest.spyOn(client, 'homeWriteEnd').mockRejectedValue(new Error('the VM is unreachable'));
    expect(await g.run('home', 'commit', '--allow-empty', '-qm', 'before confirm')).toMatchObject({
      code: 0,
      stderr: '',
    });
    await g.pair.home.close();
    g.write('vm', 'j.txt', 'agent\n');
    const blocked = await g.run('vm', 'add', 'j.txt');
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.trim().split('\n')).toEqual([
      `git: Git is on PC '${g.vm().homeName}': a home Git write is unconfirmed.`,
    ]);
    await g.restartHome();
    await g.confirmed(60_000);
    expect(await g.run('vm', 'add', 'j.txt')).toMatchObject({ code: 0, stderr: '' });
    expect(g.real('vm', 'log', '-1', '--format=%s')).toBe('before confirm');
    await stepsDown();
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
