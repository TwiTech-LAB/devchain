import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import {
  assertRollbackRefStorage,
  captureGitBaseline,
  parseGitBaseline,
  refsDigest,
  restoreGitBaseline,
} from './git-checkpoint';

// Real Git resolves each HEAD format while a fixed ref listing pins the digest encoding.
describe('captureGitBaseline', () => {
  const oid = 'a'.repeat(40);
  const ref = 'refs/heads/main';
  const branch = { name: ref, oid };

  it.each([
    { label: 'symbolic HEAD', rawHead: `ref: ${ref}`, head: ref, refs: [branch], sequencer: [] },
    { label: 'detached HEAD', rawHead: oid, head: oid, refs: [branch], sequencer: [] },
    { label: 'unborn HEAD', rawHead: `ref: ${ref}`, head: ref, refs: [], sequencer: [] },
    {
      label: 'an unborn symlink-form HEAD',
      rawHead: `ref: ${ref}`,
      head: ref,
      refs: [],
      sequencer: [],
      link: true,
    },
    {
      label: 'open root sequencer markers',
      rawHead: `ref: ${ref}`,
      head: ref,
      refs: [branch],
      sequencer: ['MERGE_HEAD', 'rebase-merge'],
    },
  ])(
    'captures $label with the checkpoint digest',
    async ({ rawHead, head, refs, sequencer, link }) => {
      const root = await mkdtemp(join(tmpdir(), 'git-baseline-'));
      try {
        execFileSync('git', ['init', '-q', '-b', 'main', root]);
        const gitDir = join(root, '.git');
        if (link) {
          await unlink(join(gitDir, 'HEAD'));
          await symlink(head, join(gitDir, 'HEAD'));
        } else await writeFile(join(gitDir, 'HEAD'), `${rawHead}\n`);
        if (sequencer.length) {
          await writeFile(join(gitDir, 'MERGE_HEAD'), `${oid}\n`);
          await mkdir(join(gitDir, 'rebase-merge'));
        }
        const stdout = refs.map(({ name, oid }) => `${oid} ${name}\n`).join('');
        const annotated = refs.map(({ name, oid }) => `${oid} ${name} \n`).join('');
        const executor = new ChildProcessExecutor();
        const runGit = executor.run.bind(executor);
        const run = jest.spyOn(executor, 'run').mockImplementation(async (options) => {
          const result = await runGit(options);
          return options.argv.includes('for-each-ref') ? { ...result, stdout: annotated } : result;
        });

        await expect(captureGitBaseline(executor, root, 7)).resolves.toEqual({
          generation: 7,
          head,
          refs,
          symbolicRefs: {},
          sequencer,
          refsDigest: createHash('sha256').update(`HEAD ${rawHead}\n${stdout}`).digest('hex'),
        });
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            argv: [
              'git',
              '-c',
              'gc.auto=0',
              'for-each-ref',
              '--format=%(objectname) %(refname) %(symref)',
            ],
            cwd: root,
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('reads HEAD of a loose-ref repository with a Git that has no --no-recurse (before 2.39)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-baseline-old-git-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      const executor = new ChildProcessExecutor();
      const runGit = executor.run.bind(executor);
      // An old Git refuses the option with exit 129, as it does any option it does not know.
      jest.spyOn(executor, 'run').mockImplementation((options) =>
        runGit({
          ...options,
          argv: options.argv.map((arg) => (arg === '--no-recurse' ? '--not-in-this-git' : arg)),
        }),
      );

      expect(await refsDigest(executor, root)).toBe(
        createHash('sha256').update(`HEAD ref: ${ref}\n`).digest('hex'),
      );
      expect(await captureGitBaseline(executor, root, 0)).toMatchObject({ head: ref, refs: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Root reads a file of mode 000, so the case cannot fail the read there.
  (process.getuid?.() === 0 ? it.skip : it)(
    'refuses a rollback, with an empty baseline too, when Git cannot read the config file',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'git-baseline-unreadable-'));
      try {
        execFileSync('git', ['init', '-q', '-b', 'main', root]);
        const executor = new ChildProcessExecutor();
        expect(await captureGitBaseline(executor, root, 0)).toMatchObject({ refs: [] });
        await assertRollbackRefStorage(executor, root);
        await chmod(join(root, '.git', 'config'), 0o000);
        await expect(assertRollbackRefStorage(executor, root)).rejects.toThrow('git config failed');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses a legacy baseline that cannot show whether a saved ref was symbolic', () => {
    const snapshot = {
      generation: 7,
      head: ref,
      refs: [branch],
      sequencer: [],
      refsDigest: createHash('sha256').update(`HEAD ref: ${ref}\n${oid} ${ref}\n`).digest('hex'),
    };
    expect(() => parseGitBaseline(JSON.stringify(snapshot))).toThrow('symbolic ref targets');
  });
});

// Git's ref transactions, HEAD forms and broken refs need a real repository to exercise them.
describe('restoreGitBaseline', () => {
  it.each([
    'a new ref',
    'a moved ref',
    'a deleted ref',
    'a ref with a missing object',
    'a removed symbolic origin/HEAD',
    'a retargeted symbolic origin/HEAD',
    'a symbolic ref chain',
    'a saved dangling symbolic ref',
    'a dangling symbolic ref',
    'a ref replaced by a nested ref',
    'a detached HEAD',
    'an unborn HEAD',
    'root sequencer markers',
  ])('restores the saved Git state with %s', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'git-baseline-restore-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
        { encoding: 'utf8' },
      ).trim();
    const commit = () => git('commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'test');
    const gitDir = join(root, '.git');
    const executor = new ChildProcessExecutor();
    const alias = 'refs/remotes/origin/HEAD';
    const target = 'refs/remotes/origin/main';
    const upstream = 'refs/remotes/upstream/HEAD';
    const looseRef = (name: string) => readFile(join(gitDir, name), 'utf8');
    const savesAlias =
      change === 'a removed symbolic origin/HEAD' ||
      change === 'a retargeted symbolic origin/HEAD' ||
      change === 'a symbolic ref chain';
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'core.preferSymlinkRefs', 'false');
      if (change !== 'an unborn HEAD') {
        commit();
        git('branch', 'saved');
      }
      if (change === 'a detached HEAD') git('switch', '-q', '--detach');
      if (savesAlias) {
        git('update-ref', target, 'HEAD');
        git('symbolic-ref', alias, target);
      }
      if (change === 'a symbolic ref chain') git('symbolic-ref', upstream, alias);
      if (change === 'a saved dangling symbolic ref')
        git('-c', 'core.preferSymlinkRefs=true', 'symbolic-ref', alias, target);
      const baseline = parseGitBaseline(
        JSON.stringify(await captureGitBaseline(executor, root, 0)),
      );

      switch (change) {
        case 'a new ref':
          git('tag', 'unconfirmed');
          break;
        case 'a moved ref':
        case 'an unborn HEAD':
          commit();
          break;
        case 'a deleted ref':
          git('branch', '-D', 'saved');
          break;
        case 'a ref with a missing object':
          await writeFile(join(gitDir, 'refs', 'heads', 'missing'), `${'c'.repeat(40)}\n`);
          break;
        case 'a removed symbolic origin/HEAD':
          git('symbolic-ref', '--delete', alias);
          break;
        case 'a retargeted symbolic origin/HEAD':
          git('symbolic-ref', alias, 'refs/heads/saved');
          expect(await refsDigest(executor, root)).toBe(baseline.refsDigest);
          break;
        case 'a symbolic ref chain':
          git('symbolic-ref', upstream, target);
          expect(await refsDigest(executor, root)).toBe(baseline.refsDigest);
          break;
        case 'a saved dangling symbolic ref':
          git('symbolic-ref', '--delete', alias);
          expect(await refsDigest(executor, root)).toBe(baseline.refsDigest);
          break;
        case 'a dangling symbolic ref':
          git('symbolic-ref', 'refs/heads/dangling', 'refs/heads/absent');
          break;
        case 'a ref replaced by a nested ref':
          git('branch', '-D', 'saved');
          git('branch', 'saved/nested');
          break;
        case 'a detached HEAD':
          git('switch', '-q', 'main');
          break;
        case 'root sequencer markers':
          await writeFile(join(gitDir, 'MERGE_HEAD'), `${git('rev-parse', 'HEAD')}\n`);
          await mkdir(join(gitDir, 'rebase-merge'));
          break;
      }

      await restoreGitBaseline(executor, root, baseline);
      await restoreGitBaseline(executor, root, baseline);
      expect(await captureGitBaseline(executor, root, 0)).toEqual(baseline);
      if (change === 'a dangling symbolic ref')
        await expect(lstat(join(gitDir, 'refs', 'heads', 'dangling'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      if (change === 'an unborn HEAD') expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(await refsDigest(executor, root)).toBe(baseline.refsDigest);
      if (change === 'a saved dangling symbolic ref')
        expect(await looseRef(alias)).toBe(`ref: ${target}\n`);
      if (savesAlias) {
        expect(await looseRef(alias)).toBe(`ref: ${target}\n`);
        if (change === 'a symbolic ref chain')
          expect(await looseRef(upstream)).toBe(`ref: ${alias}\n`);
        const previous = git('rev-parse', target);
        commit();
        git('update-ref', target, 'HEAD');
        expect(git('rev-parse', target)).not.toBe(previous);
        expect(git('rev-parse', alias)).toBe(git('rev-parse', target));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
