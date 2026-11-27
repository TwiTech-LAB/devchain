import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const GITLINK_MODE = '160000';
/** What Git writes to the `HEAD` file of a reftable repository. */
const REFTABLE_HEAD_PLACEHOLDER = 'refs/heads/.invalid';
const logger = createLogger('GitCheckpoint');
const warnedUnsupportedStorage = new Set<string>();

/** Root sequencer markers, in check order, and the unfinished operation each stands for. */
export const SEQUENCER_MARKERS: ReadonlyMap<string, string> = new Map([
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['sequencer', 'a cherry-pick or revert sequence'],
]);

const ObjectIdSchema = z
  .string()
  .refine((id) => (id.length === 40 || id.length === 64) && !/[^a-f0-9]/.test(id));
const RefNameSchema = z
  .string()
  .refine((name) => name.startsWith('refs/') && name.length > 5 && !/[\x00-\x20\x7f]/.test(name));
const RefTargetSchema = z.union([RefNameSchema, z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)]);
const GitBaselineSchema = z.object({
  generation: z.number().int().nonnegative(),
  /** Symbolic ref name (including for an unborn branch) or detached object id. */
  head: z.union([RefNameSchema, ObjectIdSchema]),
  refs: z.array(z.object({ name: RefNameSchema, oid: ObjectIdSchema })),
  symbolicRefs: z.record(RefNameSchema, RefTargetSchema, {
    required_error: 'Git baseline is missing symbolic ref targets',
  }),
  sequencer: z.array(z.string().refine((marker) => SEQUENCER_MARKERS.has(marker))),
  refsDigest: z.string(),
});
export type GitBaseline = z.infer<typeof GitBaselineSchema>;

export function parseGitBaseline(json: string): GitBaseline {
  const baseline = GitBaselineSchema.parse(JSON.parse(json));
  const head = baseline.head.startsWith('refs/') ? `ref: ${baseline.head}` : baseline.head;
  if (digestRefs(head, formatRefList(baseline.refs)) !== baseline.refsDigest)
    throw new Error('Git baseline contents do not match their digest');
  return baseline;
}

/**
 * The environment of Git that DevChain runs itself. The executor replaces the environment, so
 * PATH must come along to find git; the bypass lets it past the shim.
 */
export function internalGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', DEVCHAIN_GIT_BYPASS: '1', ...extra };
}

/** HEAD and the resolved ref listing used by the home-write protocol. */
export async function refsDigest(executor: ProcessExecutor, root: string): Promise<string> {
  const { head, refList } = await readRefState(executor, root);
  return digestRefs(head, refList);
}

/** The configured `extensions.refStorage`; undefined for the default loose and packed refs. */
async function refStorage(executor: ProcessExecutor, root: string): Promise<string | undefined> {
  // Read the file directly so Git can report the setting even when it cannot open the ref store.
  // --list fails when Git cannot read the file. --get exits 1 for that and for an absent setting,
  // and a failed read must not look like the default storage.
  const listing = await git(executor, root, [
    'config',
    '--file',
    '.git/config',
    '--null',
    '--list',
  ]);
  let storage: string | undefined;
  for (const entry of listing.split('\0')) {
    const [key, ...value] = entry.split('\n');
    // Git prints section and variable names in lower case. The last value wins, as in Git.
    if (key === 'extensions.refstorage') storage = value.join('\n');
  }
  return storage;
}

/** A ref store that the Git backup cannot copy. */
export async function unsupportedRefStorage(
  executor: ProcessExecutor,
  root: string,
): Promise<string | undefined> {
  const storage = await refStorage(executor, root);
  return storage === 'reftable' ? undefined : storage;
}

/**
 * Refuses a rollback in a repository that does not use loose and packed refs. The PC can change
 * the ref storage in a write that the VM did not confirm, after the VM saved its baseline.
 */
export async function assertRollbackRefStorage(
  executor: ProcessExecutor,
  root: string,
): Promise<void> {
  const storage = await refStorage(executor, root);
  if (storage !== undefined)
    throw new Error(`Git ref storage ${storage} does not support a rollback`);
}

export async function captureGitBaseline(
  executor: ProcessExecutor,
  root: string,
  generation: number,
): Promise<GitBaseline | undefined> {
  // A rollback is supported for loose and packed refs only. Reftable also keeps operation state
  // such as CHERRY_PICK_HEAD in its ref store, where the marker files below do not show it. With
  // no baseline, the project keeps the reclaim rules that do not roll back.
  const storage = await refStorage(executor, root);
  if (storage !== undefined) {
    if (!warnedUnsupportedStorage.has(root)) {
      warnedUnsupportedStorage.add(root);
      logger.warn({ root, storage }, 'Skipping Git rollback baseline for unsupported ref storage');
    }
    return;
  }
  const { head, refs, symbolicRefs, refsDigest } = await readBaselineRefState(executor, root);
  const sequencer: string[] = [];
  for (const marker of SEQUENCER_MARKERS.keys()) {
    try {
      await stat(join(root, '.git', marker));
      sequencer.push(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {
    generation,
    head: head.replace(/^ref: /, ''),
    refs,
    symbolicRefs,
    sequencer,
    refsDigest,
  };
}

export async function missingBaselineObjects(
  executor: ProcessExecutor,
  root: string,
  baseline: GitBaseline,
): Promise<string[]> {
  return missingObjectIds(executor, root, new Set(baselineObjectIds(baseline)), {
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  });
}

/** Restores Git metadata only. A replay must leave the same refs and HEAD. */
export async function restoreGitBaseline(
  executor: ProcessExecutor,
  root: string,
  baseline: GitBaseline,
): Promise<void> {
  if (baseline.sequencer.length || (await missingBaselineObjects(executor, root, baseline)).length)
    throw new Error('Git baseline has an unfinished operation or missing objects');

  const aliases = Object.entries(baseline.symbolicRefs);
  const saved = new Set([
    ...baseline.refs.map(({ name }) => name),
    ...Object.keys(baseline.symbolicRefs),
  ]);
  const current = await readRefNames(executor, root);
  // Git cannot create a parent ref in the same transaction that deletes its nested refs.
  await updateRefs(
    executor,
    root,
    [...current].filter((name) => !saved.has(name)).map((name) => `delete ${name}`),
  );
  await updateRefs(
    executor,
    root,
    baseline.refs
      .filter(({ name }) => !Object.hasOwn(baseline.symbolicRefs, name))
      .map(({ name, oid }) => `update ${name} ${oid}`),
  );
  if (baseline.head.startsWith('refs/'))
    await git(executor, root, ['symbolic-ref', 'HEAD', baseline.head]);
  else await git(executor, root, ['update-ref', '--no-deref', 'HEAD', baseline.head]);
  for (const [name, target] of aliases) await git(executor, root, ['symbolic-ref', name, target]);

  await Promise.all(
    [...SEQUENCER_MARKERS.keys()].map((name) =>
      rm(join(root, '.git', name), { recursive: true, force: true }),
    ),
  );
  const restored = await readBaselineRefState(executor, root);
  if (restored.refsDigest !== baseline.refsDigest)
    throw new Error('Restored Git refs do not match the baseline');
  if (
    Object.keys(restored.symbolicRefs).length !== aliases.length ||
    aliases.some(([name, target]) => restored.symbolicRefs[name] !== target)
  )
    throw new Error('Restored Git symbolic refs do not match the baseline');
}

/**
 * A copy of the root index that another checkout can read alone: no split index, untracked
 * cache or fsmonitor data. Stages, including partial staging and conflicts, are kept. An empty
 * buffer means the repository has no index yet.
 */
export async function exportIndexSnapshot(
  executor: ProcessExecutor,
  root: string,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'devchain-index-'));
  const snapshot = join(directory, 'index');
  try {
    try {
      // Git replaces the index by rename, so one copy reads one complete version.
      await copyFile(join(root, '.git', 'index'), snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
    await git(
      executor,
      root,
      [
        '-c',
        'core.splitIndex=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.fsmonitor=false',
        'update-index',
        '--no-split-index',
        '--no-untracked-cache',
        '--no-fsmonitor',
      ],
      { env: { GIT_INDEX_FILE: snapshot } },
    );
    return await readFile(snapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Objects that refs, a detached HEAD or the index file name and this repository lacks. */
export async function missingObjects(
  executor: ProcessExecutor,
  root: string,
  indexFile: string,
  baseline?: Pick<GitBaseline, 'head' | 'refs'>,
): Promise<string[]> {
  const ids = new Set<string>();
  const staged = await git(executor, root, ['ls-files', '--stage', '-z'], {
    env: { GIT_INDEX_FILE: indexFile },
  });
  for (const entry of staged.split('\0')) {
    const [mode, id] = entry.split(' ', 2);
    // A gitlink names a submodule commit, which lives in the submodule's repository.
    if (id && mode !== GITLINK_MODE) ids.add(id);
  }
  if (baseline) for (const id of baselineObjectIds(baseline)) ids.add(id);
  else {
    const { head, refList } = await readRefState(executor, root);
    for (const { oid } of parseRefs(refList)) ids.add(oid);
    if (!head.startsWith('ref: ')) ids.add(head);
  }
  return missingObjectIds(executor, root, ids);
}

function baselineObjectIds(baseline: Pick<GitBaseline, 'head' | 'refs'>): string[] {
  const ids = baseline.refs.map(({ oid }) => oid);
  if (!baseline.head.startsWith('refs/')) ids.push(baseline.head);
  return ids;
}

async function missingObjectIds(
  executor: ProcessExecutor,
  root: string,
  ids: Set<string>,
  env: Record<string, string> = {},
) {
  if (ids.size === 0) return [];
  const checked = await git(executor, root, ['cat-file', '--batch-check=%(objectname)'], {
    env,
    input: `${[...ids].join('\n')}\n`,
  });
  return checked
    .split('\n')
    .filter((line) => line.endsWith(' missing'))
    .map((line) => line.slice(0, -' missing'.length));
}

async function updateRefs(executor: ProcessExecutor, root: string, commands: string[]) {
  if (commands.length)
    await git(executor, root, ['update-ref', '--stdin'], {
      input: commands.map((command) => `option no-deref\n${command}\n`).join(''),
    });
}

async function readRefNames(executor: ProcessExecutor, root: string): Promise<Set<string>> {
  const { refList } = await readRefState(executor, root);
  const names = new Set(parseRefs(refList).map(({ name }) => name));
  for (const name of Object.keys(await readUnlistedSymbolicRefs(root, names))) names.add(name);
  return names;
}

async function readUnlistedSymbolicRefs(
  root: string,
  known: Set<string>,
): Promise<Record<string, string>> {
  const gitDir = join(root, '.git');
  // for-each-ref omits loose symbolic refs whose targets have disappeared.
  const loose = await readdir(join(gitDir, 'refs'), { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const aliases: Record<string, string> = {};
  for (const entry of loose) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(gitDir, path);
    if (
      known.has(name) ||
      !RefNameSchema.safeParse(name).success ||
      name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
    )
      continue;
    const target = await readLooseSymbolicTarget(path);
    if (target) aliases[name] = target;
  }
  return aliases;
}

async function readLooseSymbolicTarget(path: string): Promise<string | null> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (entry?.isSymbolicLink()) {
    const target = await readlink(path);
    return RefNameSchema.safeParse(target).success ? target : null;
  }
  if (!entry?.isFile()) return null;
  const contents = await readFile(path, 'utf8');
  return contents.startsWith('ref:') ? contents.slice('ref:'.length).trim() : null;
}

async function readRefState(executor: ProcessExecutor, root: string) {
  const head = await readHead(executor, root);
  const refList = await git(executor, root, ['for-each-ref', '--format=%(objectname) %(refname)']);
  return { head, refList };
}

async function readBaselineRefState(executor: ProcessExecutor, root: string) {
  const head = await readHead(executor, root);
  const listing = await git(executor, root, [
    'for-each-ref',
    '--format=%(objectname) %(refname) %(symref)',
  ]);
  const entries = parseRefs(listing);
  const refs = entries.map(({ name, oid }) => ({ name, oid }));
  const symbolicRefs = await readUnlistedSymbolicRefs(root, new Set(refs.map(({ name }) => name)));
  // The symref atom follows chains. The loose file has the immediate target, and reading it works
  // with every supported Git. A baseline is for loose and packed refs only, so the file exists.
  for (const { name } of entries.filter(({ symref }) => symref)) {
    const target = await readLooseSymbolicTarget(join(root, '.git', name));
    if (!target) throw new Error(`Git symbolic ref ${name} changed during the baseline capture`);
    symbolicRefs[name] = target;
  }
  return { head, refs, symbolicRefs, refsDigest: digestRefs(head, formatRefList(refs)) };
}

async function readHead(executor: ProcessExecutor, root: string): Promise<string> {
  const path = join(root, '.git', 'HEAD');
  const target = await readLooseSymbolicTarget(path);
  // The file is HEAD for loose refs, and reading it works with every supported Git: --no-recurse
  // needs Git 2.39. Reftable leaves a placeholder in the file and keeps HEAD in its ref store;
  // every Git that reads reftable has --no-recurse.
  if (target !== REFTABLE_HEAD_PLACEHOLDER)
    return target ? `ref: ${target}` : (await readFile(path, 'utf8')).trim();
  // Preserve the immediate target in the digest if HEAD names another symbolic ref.
  const logical = await git(executor, root, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], {
    allowExitCode: 1,
  });
  if (logical) return `ref: ${logical.trim()}`;
  return (await git(executor, root, ['rev-parse', '--verify', 'HEAD'])).trim();
}

function formatRefList(refs: GitBaseline['refs']): string {
  return refs.map(({ name, oid }) => `${oid} ${name}\n`).join('');
}

function digestRefs(head: string, refList: string): string {
  return createHash('sha256').update(`HEAD ${head}\n${refList}`).digest('hex');
}

function parseRefs(refList: string) {
  return refList
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oid, name, symref] = line.split(' ');
      return { name, oid, symref };
    });
}

async function git(
  executor: ProcessExecutor,
  root: string,
  args: string[],
  {
    env = {},
    input,
    allowExitCode,
  }: { env?: Record<string, string>; input?: string; allowExitCode?: number } = {},
): Promise<string> {
  const result = await executor.run({
    argv: ['git', '-c', 'gc.auto=0', ...args],
    mode: 'pipe',
    cwd: root,
    // The executor replaces the environment, so user config such as fsmonitor hooks stays out.
    env: internalGitEnv({ GIT_OPTIONAL_LOCKS: '0', ...env }),
    timeout: 60_000,
    ...(input !== undefined && { input }),
  });
  if (!result.success && (allowExitCode === undefined || result.exitCode !== allowExitCode)) {
    const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
    throw new Error(`git ${command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
