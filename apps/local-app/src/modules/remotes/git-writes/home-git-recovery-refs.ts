import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileSyncPaths } from '../../file-sync/file-sync-paths';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { internalGitEnv } from '../git-coordinator/git-checkpoint';

const HEADS = 'refs/heads/';
const TAGS = 'refs/tags/';
const RECOVERED = 'devchain-recovered/';
const STAGED = 'refs/devchain/staged';

/** The file in each Git backup folder that records its recovery state. */
export const RECOVERY_MARKER = 'recovery.json';

/** The folder that holds a project's Git backups, one subfolder for each step-down. */
export function gitBackupRoot(paths: FileSyncPaths, projectId: string): string {
  return join(dirname(paths.syncthingHome()), 'backups', 'git', projectId);
}

type Git = (
  args: string[],
  allowed?: number[],
  extraEnv?: Record<string, string>,
) => Promise<{ stdout: string; success: boolean }>;

export interface RecoveryRef {
  source: string;
  destination: string;
  oid: string;
}

/** Compare the saved refs to the mirrored project and give each recovered ref its stable name. */
export async function prepareRecoveryRefs(
  executor: ProcessExecutor,
  options: RecoveryOptions,
  signal?: AbortSignal,
): Promise<{ refs: RecoveryRef[]; stagedSkipped?: 'conflicts' }> {
  const { root, backup, pcName, time, createdAt } = options;
  const source = gitAt(executor, backup, signal, {
    GIT_DIR: backup,
    GIT_INDEX_FILE: join(backup, 'index'),
  });
  const project = gitAt(executor, root, signal);
  const prefix = recoveryPrefix(pcName, time);
  const [saved, live, { stdout: head }, { success: symbolic }] = await Promise.all([
    readRefs(source),
    readRefs(project),
    source(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [1]),
    source(['symbolic-ref', '--quiet', 'HEAD'], [1]),
  ]);
  const refs: RecoveryRef[] = [];
  const recover = (source: string, destination: string, oid: string) =>
    refs.push({ source, destination, oid });
  for (const [ref, oid] of saved) {
    if (ref.startsWith(HEADS)) {
      const name = ref.slice(HEADS.length);
      if (!name.startsWith(RECOVERED) && !(await contains(project, oid, live.get(ref))))
        recover(ref, HEADS + prefix + name, oid);
    } else if (ref.startsWith(TAGS)) {
      const name = ref.slice(TAGS.length);
      if (!name.startsWith(RECOVERED) && oid !== live.get(ref))
        recover(ref, TAGS + prefix + name, oid);
    }
  }
  const generated = (source: string, name: string, oid: string) => {
    const preferred = HEADS + prefix + name;
    let destination = preferred;
    for (let suffix = 2; refs.some((ref) => conflicts(ref.destination, destination)); suffix++)
      destination = `${preferred}-${suffix}`;
    recover(source, destination, oid);
  };
  if (head && !symbolic && !(await contains(project, head, 'HEAD')))
    generated('HEAD', 'detached-head', head);
  const stash = saved.get('refs/stash');
  // A rollback can leave the stash commit in the project with no ref that names it, so only a
  // live stash ref at the same commit keeps the saved stash.
  if (stash && live.get('refs/stash') !== stash) generated('refs/stash', 'stash', stash);
  const staged = await buildStaged(source, backup, head, pcName, time, createdAt);
  if (staged === 'conflicts') return { refs, stagedSkipped: 'conflicts' };
  if (staged) generated(STAGED, 'staged', staged);
  return { refs };
}

type RecoveryOptions = {
  root: string;
  backup: string;
  pcName: string;
  time: string;
  createdAt: number;
};

function recoveryPrefix(pcName: string, time: string): string {
  const pc = pcName
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.\./g, '--')
    .replace(/^\./, '-');
  return `${RECOVERED}${pc}-${time}/`;
}

function conflicts(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

export async function hasRecoveryRefs(
  executor: ProcessExecutor,
  root: string,
  plan: readonly RecoveryRef[],
  signal?: AbortSignal,
): Promise<boolean> {
  const live = await readRefs(gitAt(executor, root, signal));
  return plan.every(({ destination, oid }) => live.get(destination) === oid);
}

export async function listRecoveredRefs(
  executor: ProcessExecutor,
  root: string,
): Promise<string[]> {
  const git = gitAt(executor, root);
  const { stdout } = await git([
    'for-each-ref',
    '--format=%(refname)',
    HEADS + RECOVERED,
    TAGS + RECOVERED,
  ]);
  return stdout ? stdout.split('\n') : [];
}

async function buildStaged(
  git: Git,
  backup: string,
  head: string,
  pcName: string,
  time: string,
  createdAt: number,
): Promise<string | null> {
  const size = await stat(join(backup, 'index'))
    .then(({ size }) => size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
  if (!size) return null;
  if ((await git(['ls-files', '--unmerged'])).stdout) return 'conflicts';
  const { stdout: tree } = await git(['write-tree']);
  if (head && tree === (await git(['rev-parse', `${head}^{tree}`])).stdout) return null;
  // The same backup should produce the same commit even if the process died before fetch.
  const date = `@${Math.floor(createdAt / 1000)} +0000`;
  const { stdout: commit } = await git(
    [
      '-c',
      'user.name=DevChain',
      '-c',
      'user.email=devchain@localhost',
      'commit-tree',
      tree,
      '--no-gpg-sign',
      ...(head ? ['-p', head] : []),
      '-m',
      `Staged changes on ${pcName} at ${time}`,
    ],
    [],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  await git(['update-ref', STAGED, commit]);
  return commit;
}

async function readRefs(git: Git): Promise<Map<string, string>> {
  const { stdout: listing } = await git(['for-each-ref', '--format=%(refname) %(objectname)']);
  return new Map(
    listing
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, oid] = line.split(' ');
        return [ref, oid] as const;
      }),
  );
}

async function hasCommit(git: Git, oid: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], [1])).success;
}

async function contains(git: Git, oid: string, tip: string | undefined): Promise<boolean> {
  if (oid === tip) return true;
  if (!tip || !(await hasCommit(git, oid))) return false;
  if (tip === 'HEAD' && !(await hasCommit(git, tip))) return false;
  return (await git(['merge-base', '--is-ancestor', oid, tip], [1])).success;
}

function gitAt(
  executor: ProcessExecutor,
  cwd: string,
  signal?: AbortSignal,
  env: Record<string, string> = {},
): Git {
  return async (args, allowed = [], extraEnv = {}) => {
    const result = await executor.run({
      argv: ['git', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', ...args],
      mode: 'pipe',
      cwd,
      env: internalGitEnv({ GIT_OPTIONAL_LOCKS: '0', ...env, ...extraEnv }),
      signal,
      timeout: 60_000,
    });
    signal?.throwIfAborted();
    if (result.success || (result.exitCode !== null && allowed.includes(result.exitCode)))
      return { stdout: result.stdout.trim(), success: result.success };
    throw new Error(`Git recovery could not run ${args[0]} (exit ${result.exitCode})`);
  };
}
