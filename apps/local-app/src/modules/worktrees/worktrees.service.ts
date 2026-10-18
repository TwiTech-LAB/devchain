import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  WorktreeCapReachedError,
} from '../../common/errors/error-types';
import {
  validatePathWithinRoot,
  validateResolvedPathWithinRoot,
} from '../../common/validation/path-validation';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type EpicStorage,
  type ProjectStorage,
  type WorktreeStorage,
} from '../storage/interfaces/storage.interface';
import type { Epic, Project, Worktree } from '../storage/models/domain.models';
import { ProjectWriteGate } from '../storage/write-gate/project-write-gate';
import { TeamsStore } from '../teams/storage/teams.store';
import type { ExecutorResult } from '../terminal/services/process-executor/process-executor.port';
import { quoteShellArg } from '../terminal/services/terminal-io/quote-shell-arg';
import {
  conflictMarkerFiles,
  parseMergeTreeConflicts,
  parsePorcelain,
  parseUnmergedFiles,
} from './git-output';
import { ProjectGitMutex } from './project-git-mutex';
import { gitFailed, WorktreeGitRunner } from './worktree-git-runner';
import { WorktreeAdmissionService } from './worktree-admission.service';
import { WorktreeError } from './worktrees.errors';
import type {
  ConflictPreview,
  CreateLaneOptions,
  CreatedLane,
  DirtyFile,
  LaneList,
  LaneState,
  RemovedLane,
  CommittedLane,
  MergedLane,
} from './worktrees.types';

const LANE_LIMIT = 5;
const IGNORED_PATH_LIMIT = 50;

@Injectable()
export class WorktreesService {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: WorktreeStorage & ProjectStorage & EpicStorage & AgentStorage,
    private readonly teams: TeamsStore,
    private readonly gate: ProjectWriteGate,
    private readonly git: WorktreeGitRunner,
    private readonly mutex: ProjectGitMutex,
    private readonly admission: WorktreeAdmissionService,
  ) {}

  async create(
    projectId: string,
    leadAgentId: string,
    options: CreateLaneOptions = {},
  ): Promise<CreatedLane> {
    return this.mutate(projectId, leadAgentId, 'create', async (project) => {
      const epic = options.epicId ? await this.storage.getEpic(options.epicId) : null;
      if (epic && epic.projectId !== projectId) {
        throw new WorktreeError('WORKTREE_INVALID_EPIC', 'Epic must belong to this project.', 400);
      }
      const rows = await this.storage.listWorktrees(projectId);
      const name = options.name ?? this.defaultName(rows, epic);
      if (!/^[a-z0-9-]{1,40}$/.test(name)) {
        throw new WorktreeError(
          'WORKTREE_INVALID_NAME',
          'Lane name must be a lowercase slug of at most 40 characters.',
          400,
        );
      }
      if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
        throw new WorktreeError('WORKTREE_NAME_EXISTS', 'Lane name already exists.', 409, { name });
      }
      const { baseBranch, baseSha } = await this.resolveBase(project.rootPath, options.baseRef);
      const id = randomUUID();
      const branch = `devchain/${name}-${id.slice(0, 6)}`;
      await this.git.require(project.rootPath, ['check-ref-format', '--branch', branch]);
      const path = this.lanePath(projectId, name);
      if (await this.pathExists(path)) {
        throw new WorktreeError('WORKTREE_PATH_EXISTS', 'Lane path already exists.', 409, { path });
      }
      let row: Worktree;
      try {
        row = await this.storage.createWorktreeAtomicCapped(
          {
            id,
            projectId,
            name,
            path,
            branch,
            baseBranch,
            baseSha,
            epicId: epic?.id ?? null,
            createdByType: 'agent',
            createdByAgentId: leadAgentId,
          },
          LANE_LIMIT,
        );
      } catch (error) {
        if (error instanceof WorktreeCapReachedError) {
          throw new WorktreeError(
            'WORKTREE_LIMIT_REACHED',
            'Project has reached its five-lane limit.',
            409,
            error.details,
          );
        }
        if (error instanceof ConflictError) {
          throw new WorktreeError('WORKTREE_NAME_EXISTS', 'Lane name already exists.', 409, {
            name,
          });
        }
        throw error;
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await this.git.require(project.rootPath, [
          'worktree',
          'add',
          '-b',
          branch,
          '--',
          path,
          baseSha,
        ]);
      } catch (error) {
        // post-checkout can fail after Git has registered and populated the lane.
        const worktrees = await this.git.require(project.rootPath, [
          'worktree',
          'list',
          '--porcelain',
        ]);
        if (worktrees.split('\n').includes(`worktree ${path}`)) {
          throw new WorktreeError(
            'WORKTREE_SETUP_FAILED',
            'Git created the lane, but a checkout hook failed. Inspect the lane, or remove it with devchain_worktrees_remove.',
            409,
            {
              name,
              path,
              branch,
              stderr: error instanceof WorktreeError ? error.details?.stderr : undefined,
            },
          );
        }
        await this.storage.deleteWorktree(row.id);
        throw error;
      }
      return { ...row, projectRootPath: project.rootPath };
    });
  }

  async listOnHost(projectId: string) {
    await this.storage.getProject(projectId);
    return this.mutex.runExclusive(projectId, async () => {
      const lanes = [];
      for (const row of await this.storage.listWorktrees(projectId)) {
        // A failed Git/path inspection must not hide a tracked lane from handoff guards.
        let dirty = true;
        try {
          this.assertLanePath(row);
          dirty =
            (await this.directoryExists(row.path)) && (await this.dirtyFiles(row.path)).length > 0;
        } catch {
          // Unknown working-tree state is conservatively dirty; the lane is still present.
        }
        lanes.push({ name: row.name, path: row.path, branch: row.branch, dirty });
      }
      return { lanes };
    });
  }

  async list(projectId: string, leadAgentId: string, name?: string): Promise<LaneList> {
    const project = await this.authorize(projectId, leadAgentId);
    return this.mutex.runExclusive(projectId, async () => {
      this.gate.assertWritable(projectId);
      const rows =
        name === undefined
          ? await this.storage.listWorktrees(projectId)
          : [await this.requireLane(projectId, name)];
      const lanes: LaneState[] = [];
      for (const row of rows) lanes.push(await this.readLane(project.rootPath, row));
      const result: LaneList = {
        projectRootPath: project.rootPath,
        lanes,
        rootDirtyFiles: await this.dirtyFiles(project.rootPath),
      };
      if (name !== undefined) result.preview = await this.preview(project.rootPath, lanes[0]);
      return result;
    });
  }

  async remove(projectId: string, leadAgentId: string, name: string): Promise<RemovedLane> {
    return this.mutate(projectId, leadAgentId, 'change', async (project) => {
      const row = await this.requireLane(projectId, name);
      this.assertLanePath(row);
      if (!(await this.directoryExists(row.path))) {
        await this.git.require(project.rootPath, ['worktree', 'prune', '--expire=now']);
        await this.storage.deleteWorktree(row.id);
        return this.removed(row, 'pruned', []);
      }
      await this.assertClean(row.path);
      const ignored = (
        await this.git.require(row.path, [
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '-z',
        ])
      )
        .split('\0')
        .filter(Boolean);
      const localEnv: string[] = [];
      for (const file of ignored) {
        if (
          basename(file).startsWith('.env') &&
          !(await this.envMatchesRoot(row.path, project.rootPath, file))
        )
          localEnv.push(file);
      }
      if (localEnv.length > 0) {
        throw new WorktreeError(
          'WORKTREE_LOCAL_ENV',
          'Lane has environment files without identical root copies.',
          409,
          { files: localEnv },
        );
      }
      await this.git.require(project.rootPath, ['worktree', 'remove', '--force', '--', row.path]);
      await this.storage.deleteWorktree(row.id);
      return this.removed(row, 'removed', ignored);
    });
  }

  async commit(
    projectId: string,
    leadAgentId: string,
    name: string,
    message: string,
  ): Promise<CommittedLane> {
    return this.mutate(projectId, leadAgentId, 'change', async () => {
      const row = await this.requireLane(projectId, name);
      await this.requireLaneDirectory(row);
      const unmerged = await this.unmergedFiles(row.path);
      if (unmerged.length > 0) {
        throw new WorktreeError('UNMERGED_PATHS', 'Lane has unresolved merge paths.', 409, {
          files: unmerged,
        });
      }
      const gitDir = (await this.git.require(row.path, ['rev-parse', '--absolute-git-dir'])).trim();
      const hasChanges = await this.checkCommitIndex(row.path, gitDir);
      if (!hasChanges && !(await this.pathExists(join(gitDir, 'MERGE_HEAD')))) {
        throw new WorktreeError('NOTHING_TO_COMMIT', 'Lane has nothing to commit.');
      }
      const staged = await this.git.run(row.path, ['add', '-A']);
      this.assertCommitSucceeded(staged);
      const committed = await this.git.run(row.path, ['commit', '-m', message]);
      this.assertCommitSucceeded(committed);
      const sha = await this.headSha(row.path);
      const files = (
        await this.git.require(row.path, [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          '-z',
          `${sha}^1`,
          sha,
        ])
      )
        .split('\0')
        .filter(Boolean);
      return { sha, files };
    });
  }

  async merge(
    projectId: string,
    leadAgentId: string,
    name: string,
    expectedHead: string,
  ): Promise<MergedLane> {
    return this.mutate(projectId, leadAgentId, 'change', async (project) => {
      const row = await this.requireLane(projectId, name);
      await this.requireLaneDirectory(row);
      await this.assertClean(row.path);
      const gitDir = (await this.git.require(row.path, ['rev-parse', '--absolute-git-dir'])).trim();
      const unmerged = await this.unmergedFiles(row.path);
      if ((await this.pathExists(join(gitDir, 'MERGE_HEAD'))) || unmerged.length > 0) {
        throw new WorktreeError(
          'MERGE_IN_PROGRESS',
          'Finish the lane merge before landing it.',
          409,
          { files: unmerged },
        );
      }
      const head = await this.headSha(row.path);
      if (head !== expectedHead) {
        throw new WorktreeError(
          'HEAD_MISMATCH',
          'Lane head differs from the reviewed commit.',
          409,
          { currentHead: head, expectedHead },
        );
      }
      const rootRef = await this.rootBranchRef(project.rootPath);
      const rootBranch = rootRef?.replace(/^refs\/heads\//, '') ?? null;
      if (rootBranch !== row.baseBranch) {
        throw new WorktreeError(
          'TARGET_NOT_CHECKED_OUT',
          'Lane base branch must be checked out in the root.',
          409,
          { baseBranch: row.baseBranch, rootBranch },
        );
      }
      const oldSha = await this.headSha(project.rootPath);
      const ancestor = await this.git.run(project.rootPath, [
        'merge-base',
        '--is-ancestor',
        oldSha,
        expectedHead,
      ]);
      if (gitFailed(ancestor, [0, 1])) {
        throw new WorktreeError('WORKTREE_GIT_FAILED', 'Cannot check lane ancestry.', 500, {
          stderr: ancestor.stderr,
        });
      }
      if (ancestor.exitCode === 1) {
        const state = await this.readLane(project.rootPath, row);
        const preview = await this.preview(project.rootPath, state);
        const recovery = `Ask the lane's agent to run git -C ${quoteShellArg(row.path)} merge ${quoteShellArg(row.baseBranch)}, resolve any conflicts, and run the tests. Then commit with devchain_worktrees_commit and merge with the new head.`;
        throw new WorktreeError('BEHIND', recovery, 409, {
          ahead: state.ahead,
          behind: state.behind,
          preview,
          recovery,
        });
      }
      // merge.autostash would stash an overlapping root edit and reapply it as a root conflict.
      const merged = await this.git.run(project.rootPath, [
        'merge',
        '--ff-only',
        '--no-autostash',
        expectedHead,
      ]);
      if (gitFailed(merged)) {
        throw new WorktreeError('ROOT_REFUSED', 'Root refused the fast-forward.', 409, {
          stderr: merged.stderr,
          exitCode: merged.exitCode,
        });
      }
      const newSha = await this.headSha(project.rootPath);
      return { baseBranch: row.baseBranch, oldSha, newSha };
    });
  }

  // Admission order: the freeze check precedes authorization; one coordinator permit then covers
  // the whole operation, and ownership is checked under the Git lock taken inside it.
  private async mutate<T>(
    projectId: string,
    leadAgentId: string,
    admission: 'create' | 'change',
    work: (project: Project) => Promise<T>,
  ): Promise<T> {
    this.admission.assertUnfrozen(projectId);
    const project = await this.authorize(projectId, leadAgentId);
    return this.admission.withPermit(projectId, () =>
      this.mutex.runExclusive(projectId, async () => {
        this.gate.assertWritable(projectId);
        await this.admission.assertOwned(projectId, admission === 'create');
        return work(project);
      }),
    );
  }

  private async requireLaneDirectory(row: Worktree): Promise<void> {
    this.assertLanePath(row);
    if (!(await this.directoryExists(row.path))) {
      throw new WorktreeError('WORKTREE_NOT_FOUND', 'Lane directory is missing.', 404, {
        path: row.path,
      });
    }
  }

  private async unmergedFiles(path: string): Promise<string[]> {
    return parseUnmergedFiles(await this.git.require(path, ['ls-files', '-u', '-z']));
  }

  private assertCommitSucceeded(result: ExecutorResult): void {
    if (gitFailed(result)) {
      throw new WorktreeError('COMMIT_FAILED', 'Lane commit failed.', 500, {
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      });
    }
  }

  private async checkCommitIndex(path: string, gitDir: string): Promise<boolean> {
    const folder = await mkdtemp(join(tmpdir(), 'devchain-worktree-index-'));
    const index = join(folder, 'index');
    const options = { env: { GIT_INDEX_FILE: index, LC_ALL: 'C' } };
    try {
      // A reset would remove MERGE_HEAD; stage only into the copied index.
      await copyFile(join(gitDir, 'index'), index);
      await this.git.require(path, ['add', '-A'], options);
      const files = (
        await this.git.require(path, ['diff', '--cached', '--name-only', '-z'], options)
      )
        .split('\0')
        .filter(Boolean);
      const check = await this.git.run(
        path,
        ['diff', '--cached', '--check', '--no-color', '--no-ext-diff'],
        options,
      );
      if (gitFailed(check, [0, 2])) {
        throw new WorktreeError('WORKTREE_GIT_FAILED', 'Cannot check the lane index.', 500, {
          stderr: check.stderr,
        });
      }
      const markers = conflictMarkerFiles(check.stdout, files);
      if (markers.length > 0) {
        throw new WorktreeError('CONFLICT_MARKERS', 'Lane has leftover conflict markers.', 409, {
          files: markers,
        });
      }
      return files.length > 0;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async authorize(projectId: string, leadAgentId: string): Promise<Project> {
    // Admission precedes Git and filesystem effects.
    this.gate.assertWritable(projectId);
    const ledTeams = await this.teams.getTeamLeadTeams(leadAgentId);
    if (!ledTeams.some((team) => team.projectId === projectId)) {
      throw new WorktreeError(
        'FORBIDDEN_NOT_TEAM_LEAD',
        'You do not lead any teams in this project.',
        403,
      );
    }
    return this.storage.getProject(projectId);
  }

  private defaultName(rows: Worktree[], epic: Epic | null): string {
    const slug = epic?.title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    if (slug) return slug;
    const names = new Set(rows.map((row) => row.name.toLowerCase()));
    let n = 1;
    while (names.has(`lane-${n}`)) n++;
    return `lane-${n}`;
  }

  private lanePath(projectId: string, name: string): string {
    return validatePathWithinRoot(join(homedir(), '.devchain', 'worktrees'), `${projectId}/${name}`)
      .absolutePath;
  }

  private assertLanePath(row: Worktree): void {
    if (resolve(row.path) !== this.lanePath(row.projectId, row.name)) {
      throw new ValidationError('Lane path does not match its managed location.');
    }
  }

  private async requireLane(projectId: string, name: string): Promise<Worktree> {
    const row = await this.storage.getWorktreeByName(projectId, name);
    if (!row) throw new WorktreeError('WORKTREE_NOT_FOUND', 'Lane does not exist.', 404, { name });
    return row;
  }

  private async resolveBase(
    root: string,
    baseRef?: string,
  ): Promise<{ baseBranch: string; baseSha: string }> {
    let ref: string;
    if (baseRef === undefined) {
      const rootRef = await this.rootBranchRef(root);
      if (rootRef === null) {
        throw new WorktreeError(
          'BASE_REF_REQUIRED',
          'Detached HEAD requires an explicit base branch.',
          400,
        );
      }
      ref = rootRef;
    } else {
      const result = await this.git.run(root, [
        'rev-parse',
        '--verify',
        '--symbolic-full-name',
        '--end-of-options',
        baseRef,
      ]);
      if (gitFailed(result)) {
        throw new WorktreeError('BASE_MUST_BE_BRANCH', 'Base must resolve to a branch.', 400, {
          stderr: result.stderr,
        });
      }
      ref = result.stdout.trim();
    }
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) {
      throw new WorktreeError(
        'BASE_MUST_BE_BRANCH',
        'Base must be a branch rather than a tag or commit.',
        400,
      );
    }
    const baseSha = (
      await this.git.require(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    ).trim();
    return { baseBranch: ref.replace(/^refs\/(?:heads|remotes)\//, ''), baseSha };
  }

  private async headSha(path: string): Promise<string> {
    return (await this.git.require(path, ['rev-parse', '--verify', 'HEAD'])).trim();
  }

  private async assertClean(path: string): Promise<void> {
    const dirtyFiles = await this.dirtyFiles(path);
    if (dirtyFiles.length > 0) {
      throw new WorktreeError('WORKTREE_DIRTY', 'Lane has uncommitted files.', 409, {
        files: dirtyFiles,
      });
    }
  }

  /** The root's symbolic HEAD (`refs/heads/...`), or null when HEAD is detached. */
  private async rootBranchRef(root: string): Promise<string | null> {
    const result = await this.git.run(root, ['symbolic-ref', '--quiet', 'HEAD']);
    if (gitFailed(result, [0, 1])) {
      throw new WorktreeError('WORKTREE_GIT_FAILED', 'Cannot read the root branch.', 500, {
        stderr: result.stderr,
      });
    }
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private async dirtyFiles(path: string): Promise<DirtyFile[]> {
    return parsePorcelain(
      await this.git.require(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        env: { GIT_OPTIONAL_LOCKS: '0' },
      }),
    );
  }

  private async readLane(root: string, row: Worktree): Promise<LaneState> {
    this.assertLanePath(row);
    let epic: LaneState['epic'] = null;
    if (row.epicId) {
      try {
        const linked = await this.storage.getEpic(row.epicId);
        const assignee = linked.agentId ? await this.storage.getAgent(linked.agentId) : null;
        epic = { id: linked.id, title: linked.title, agentName: assignee?.name ?? null };
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    const state: LaneState = {
      ...row,
      status: 'missing',
      headSha: null,
      ahead: null,
      behind: null,
      dirtyFiles: [],
      epic,
    };
    if (!(await this.directoryExists(row.path))) return state;
    state.status = 'present';
    try {
      state.headSha = await this.headSha(row.path);
      state.dirtyFiles = await this.dirtyFiles(row.path);
      const counts = await this.git.require(root, [
        'rev-list',
        '--left-right',
        '--count',
        `${row.baseBranch}...${state.headSha}`,
      ]);
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead))
        throw new ValidationError('Invalid Git ahead/behind result.');
      state.behind = behind;
      state.ahead = ahead;
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      state.status = 'unavailable';
      state.stateError = String(error.details?.stderr ?? error.message);
    }
    return state;
  }

  private async preview(root: string, lane: LaneState): Promise<ConflictPreview> {
    if (!lane.headSha)
      return {
        status: 'unavailable',
        files: [],
        stderr: lane.stateError ?? 'Lane directory is missing.',
      };
    const result = await this.git.run(root, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '-z',
      lane.baseBranch,
      lane.headSha,
    ]);
    // Some Git versions also use exit 1 for invalid refs, without a tree result.
    const treeOid = result.stdout.split('\0', 1)[0];
    if (
      result.timedOut ||
      result.truncated ||
      (result.exitCode !== 0 && result.exitCode !== 1) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeOid)
    ) {
      return {
        status: 'unavailable',
        files: [],
        stderr: result.stderr || 'Git preview did not complete.',
      };
    }
    return {
      status: result.exitCode === 0 ? 'clean' : 'conflicts',
      files: result.exitCode === 1 ? parseMergeTreeConflicts(result.stdout) : [],
    };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ValidationError('Lane path must be a directory, not a symlink.');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async envMatchesRoot(lane: string, root: string, file: string): Promise<boolean> {
    try {
      const laneRoot = await realpath(lane);
      const projectRoot = await realpath(root);
      const safeLane = validatePathWithinRoot(laneRoot, file).absolutePath;
      const safeRoot = validatePathWithinRoot(projectRoot, file).absolutePath;
      const laneFile = await validateResolvedPathWithinRoot(safeLane, laneRoot);
      const rootFile = await validateResolvedPathWithinRoot(safeRoot, projectRoot);
      const [laneBytes, rootBytes] = await Promise.all([readFile(laneFile), readFile(rootFile)]);
      return laneBytes.equals(rootBytes);
    } catch {
      return false;
    }
  }

  private removed(row: Worktree, status: RemovedLane['status'], ignored: string[]): RemovedLane {
    const paths = [...new Set(ignored.map((file) => file.split('/')[0]))].sort();
    return {
      status,
      path: row.path,
      branch: row.branch,
      deletedIgnoredPaths: paths.slice(0, IGNORED_PATH_LIMIT),
      deletedIgnoredPathCount: paths.length,
      ignoredPathsTruncated: paths.length > IGNORED_PATH_LIMIT,
    };
  }
}
