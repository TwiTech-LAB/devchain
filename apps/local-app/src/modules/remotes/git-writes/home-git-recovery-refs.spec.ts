import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { prepareRecoveryRefs } from './home-git-recovery-refs';

function git(root: string, args: string[], input?: string): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
    { encoding: 'utf8', input },
  ).trim();
}

// Ref reachability, the index's unmerged stages and Git's ref-name rules all need real Git.
describe('Git backup selection', () => {
  const time = '2026-11-21T17-00-00-000Z';
  const prefix = `devchain-recovered/My-PC-Desk-${time}/`;
  it.each([
    ['contained branch', []],
    ['absent branch', ['heads/topic']],
    ['diverged branch', ['heads/main']],
    ['detached HEAD', ['heads/detached-head']],
    ['stash', ['heads/stash']],
    ['stash whose commit synced before the rollback', ['heads/stash']],
    ['new tag', ['tags/v1']],
    ['changed tag', ['tags/v1']],
    ['conflicted index', []],
    ['no changes', []],
    ['previously recovered refs', []],
    ['unborn HEAD with staged changes', ['heads/staged']],
    ['branch with the staged name', ['heads/staged', 'heads/staged-2']],
    ['branch under the staged name', ['heads/staged/topic', 'heads/staged-2']],
  ] as const)('selects the right refs for %s', async (scenario, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'devchain-git-recovery-refs-'));
    try {
      git(directory, ['init', '-q', '-b', 'main', 'pc']);
      const pc = join(directory, 'pc');
      await writeFile(join(pc, 'a.txt'), 'baseline\n');
      git(pc, ['add', 'a.txt']);
      git(pc, ['commit', '-qm', 'baseline']);
      git(directory, ['clone', '-q', pc, 'live']);
      const live = join(directory, 'live');
      const commit = (root: string, message: string) =>
        git(root, ['commit', '-qm', message, '--allow-empty']);

      switch (scenario) {
        case 'contained branch':
          commit(live, 'VM advanced');
          break;
        case 'absent branch':
          git(pc, ['branch', 'topic']);
          break;
        case 'diverged branch':
          commit(pc, 'PC diverged');
          commit(live, 'VM diverged');
          git(live, ['fetch', '-q', '--no-tags', pc, 'refs/heads/main:refs/tags/pc-tip']);
          break;
        case 'detached HEAD':
          git(pc, ['switch', '-q', '--detach']);
          commit(pc, 'PC detached');
          break;
        case 'stash':
        case 'stash whose commit synced before the rollback':
          await writeFile(join(pc, 'a.txt'), 'stashed\n');
          git(pc, ['stash', 'push', '-qm', 'PC stash']);
          // The rollback restores the refs, not the objects: the commit stays without a ref.
          if (scenario !== 'stash')
            git(live, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', pc, 'refs/stash']);
          break;
        case 'changed tag':
          commit(live, 'VM tag tip');
          git(live, ['tag', 'v1']);
          // Both repositories have a tag of the same name, pointing at different commits.
          git(pc, ['tag', 'v1']);
          break;
        case 'new tag':
          git(pc, ['tag', 'v1']);
          break;
        case 'conflicted index': {
          const oid = git(pc, ['rev-parse', 'HEAD:a.txt']);
          git(pc, ['read-tree', '--empty']);
          git(
            pc,
            ['update-index', '--index-info'],
            [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\ta.txt\n`).join(''),
          );
          break;
        }
        case 'previously recovered refs':
          git(pc, ['branch', 'devchain-recovered/old/main']);
          git(pc, ['tag', 'devchain-recovered/old/v1']);
          break;
        case 'unborn HEAD with staged changes':
          git(pc, ['symbolic-ref', 'HEAD', 'refs/heads/unborn']);
          break;
        case 'branch with the staged name':
        case 'branch under the staged name':
          git(pc, [
            'branch',
            scenario === 'branch with the staged name' ? 'staged' : 'staged/topic',
          ]);
          await writeFile(join(pc, 'a.txt'), 'staged snapshot\n');
          git(pc, ['add', 'a.txt']);
          break;
      }

      const options = {
        root: live,
        backup: join(pc, '.git'),
        pcName: 'My PC/Desk',
        time,
        createdAt: Date.parse('2026-11-21T17:00:00.000Z'),
      };
      const prepared = await prepareRecoveryRefs(new ChildProcessExecutor(), options);
      expect(prepared.refs.map(({ destination }) => destination)).toEqual(
        expected.map((ref) =>
          ref.replace(/^(heads|tags)\//, (_, kind: string) => `refs/${kind}/${prefix}`),
        ),
      );
      expect(prepared.stagedSkipped).toBe(
        scenario === 'conflicted index' ? 'conflicts' : undefined,
      );
      for (const { destination } of prepared.refs)
        expect(git(pc, ['check-ref-format', destination])).toBe('');
      if (
        scenario === 'branch with the staged name' ||
        scenario === 'branch under the staged name'
      ) {
        expect(await prepareRecoveryRefs(new ChildProcessExecutor(), options)).toEqual(prepared);
        git(live, [
          'fetch',
          '--quiet',
          '--no-tags',
          '--atomic',
          options.backup,
          ...prepared.refs.map(({ oid, destination }) => `${oid}:${destination}`),
        ]);
        const [branch, staged] = prepared.refs;
        expect(git(live, ['rev-parse', branch.destination])).toBe(git(pc, ['rev-parse', 'HEAD']));
        expect(git(live, ['show', `${staged.destination}:a.txt`])).toBe('staged snapshot');
      }
      if (scenario === 'unborn HEAD with staged changes') {
        const commit = git(pc, ['rev-list', '--parents', '-n1', 'refs/devchain/staged']);
        expect(commit.split(' ')).toHaveLength(1);
        expect(git(pc, ['show', 'refs/devchain/staged:a.txt'])).toBe('baseline');
        await prepareRecoveryRefs(new ChildProcessExecutor(), options);
        expect(git(pc, ['rev-parse', 'refs/devchain/staged'])).toBe(commit);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
