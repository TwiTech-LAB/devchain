import { Injectable, Optional } from '@nestjs/common';
import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { promisify } from 'util';
import { createLogger } from '../../../../common/logging/logger';
import { isValidGitBranchName, isValidWorktreeName } from '../../worktrees/worktree-validation';
import { getEnvConfig } from '../../../../common/config/env.config';

const execFileAsync = promisify(execFile);
const logger = createLogger('GitWorktreeService');
const MAX_GIT_BUFFER = 10 * 1024 * 1024;
const REFS_HEADS_PREFIX = 'refs/heads/';

export interface CreateWorktreeOptions {
  name: string;
  branchName: string;
  baseBranch: string;
  repoPath?: string;
  worktreePath?: string;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  head?: string;
  detached?: boolean;
}

export interface BranchStatus {
  baseBranch: string;
  branchName: string;
  commitsBehind: number;
  commitsAhead: number;
}

export interface ChangeSummary {
  raw: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface MergePreview {
  mergeBase: string;
  sourceBranch: string;
  targetBranch: string;
  hasConflicts: boolean;
  conflicts: string[];
  output: string;
}

export interface MergeResult {
  sourceBranch: string;
  targetBranch: string;
  success: boolean;
  mergeCommit?: string;
  conflicts?: string[];
  output: string;
}

export interface RebaseResult {
  sourceBranch: string;
  targetBranch: string;
  success: boolean;
  conflicts: string[];
  output: string;
}

export interface WorkingTreeStatus {
  clean: boolean;
  output: string;
}

type GitCommandRunner = (
  cwd: string,
  args: string[],
) => Promise<{
  stdout: string;
  stderr: string;
}>;

@Injectable()
export class GitWorktreeService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(@Optional() private readonly gitRunner: GitCommandRunner = runGitCommand) {}

  async createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
    this.assertValidCreateOptions(opts);

    return this.enqueue(async () => {
      const repoPath = this.resolveRepoPath(opts.repoPath);
      const worktreePath =
        opts.worktreePath ?? join(this.resolveWorktreesRoot(repoPath), opts.name);
      await mkdir(dirname(worktreePath), { recursive: true });

      await this.runGit(repoPath, [
        'worktree',
        'add',
        worktreePath,
        '-b',
        opts.branchName,
        opts.baseBranch,
      ]);

      return {
        name: opts.name,
        path: worktreePath,
        branch: opts.branchName,
      };
    });
  }

  private assertValidCreateOptions(opts: CreateWorktreeOptions): void {
    if (!isValidWorktreeName(opts.name)) {
      throw new Error('Invalid worktree name');
    }
    if (!isValidGitBranchName(opts.branchName)) {
      throw new Error('Invalid branch name');
    }
    if (!isValidGitBranchName(opts.baseBranch)) {
      throw new Error('Invalid base branch name');
    }
  }

  async removeWorktree(nameOrPath: string, repoPath: string, force = false): Promise<void> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const worktreePath =
        isAbsolute(nameOrPath) || nameOrPath.startsWith('.')
          ? nameOrPath
          : join(this.resolveWorktreesRoot(resolvedRepoPath), nameOrPath);
      const args = ['worktree', 'remove', worktreePath];
      if (force) {
        args.push('--force');
      }
      await this.runGit(resolvedRepoPath, args);
    });
  }

  async deleteBranch(branchName: string, repoPath?: string, force = false): Promise<void> {
    if (!isValidGitBranchName(branchName)) {
      throw new Error('Invalid branch name');
    }

    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      await this.runGit(resolvedRepoPath, ['branch', force ? '-D' : '-d', '--', branchName]);
    });
  }

  async listWorktrees(repoPath?: string): Promise<WorktreeInfo[]> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout } = await this.runGit(resolvedRepoPath, ['worktree', 'list', '--porcelain']);
      return parseWorktreeList(stdout);
    });
  }

  async listBranches(repoPath?: string): Promise<string[]> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout } = await this.runGit(resolvedRepoPath, [
        'branch',
        '--list',
        '--format=%(refname:short)',
      ]);
      return stdout
        .split('\n')
        .map((branch) => branch.trim())
        .filter(Boolean);
    });
  }

  async getBranchStatus(
    repoPath: string | undefined,
    baseBranch: string,
    branchName: string,
  ): Promise<BranchStatus> {
    return this.enqueue(async () =>
      this.computeBranchStatus(this.resolveRepoPath(repoPath), baseBranch, branchName),
    );
  }

  async getChangeSummary(worktreePath: string, baseRef = 'HEAD'): Promise<ChangeSummary> {
    return this.enqueue(async () => {
      const { stdout } = await this.runGit(worktreePath, ['diff', '--stat', baseRef]);
      return parseChangeSummary(stdout);
    });
  }

  async getBranchChangeSummary(
    repoPath: string | undefined,
    baseBranch: string,
    branchName: string,
  ): Promise<ChangeSummary> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout } = await this.runGit(resolvedRepoPath, [
        'diff',
        '--stat',
        `${baseBranch}...${branchName}`,
      ]);
      return parseChangeSummary(stdout);
    });
  }

  async getWorkingTreeStatus(repoPath: string | undefined): Promise<WorkingTreeStatus> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout } = await this.runGit(resolvedRepoPath, ['status', '--porcelain']);
      const output = stdout.trim();
      return {
        clean: output.length === 0,
        output,
      };
    });
  }

  async previewMerge(
    repoPath: string | undefined,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<MergePreview> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout: mergeBaseOut } = await this.runGit(resolvedRepoPath, [
        'merge-base',
        targetBranch,
        sourceBranch,
      ]);
      const mergeBase = mergeBaseOut.trim();
      const { stdout } = await this.runGit(resolvedRepoPath, [
        'merge-tree',
        mergeBase,
        targetBranch,
        sourceBranch,
      ]);

      return {
        mergeBase,
        sourceBranch,
        targetBranch,
        hasConflicts: hasMergeConflicts(stdout),
        conflicts: parseMergeTreeConflicts(stdout),
        output: stdout.trim(),
      };
    });
  }

  async executeMerge(
    repoPath: string | undefined,
    sourceBranch: string,
    targetBranch: string,
    options?: { message?: string },
  ): Promise<MergeResult> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout: currentBranchOut } = await this.runGit(resolvedRepoPath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      const previousBranch = currentBranchOut.trim();
      let switchedBranch = false;

      try {
        if (previousBranch !== targetBranch) {
          await this.runGit(resolvedRepoPath, ['checkout', targetBranch]);
          switchedBranch = true;
        }

        const { stdout: mergeOut, stderr: mergeErr } = await this.runGit(resolvedRepoPath, [
          'merge',
          sourceBranch,
          '--no-ff',
          '-m',
          options?.message?.trim() || `Merge ${sourceBranch}`,
        ]);
        const { stdout: commitOut } = await this.runGit(resolvedRepoPath, ['rev-parse', 'HEAD']);

        return {
          sourceBranch,
          targetBranch,
          success: true,
          mergeCommit: commitOut.trim(),
          output: `${mergeOut}${mergeErr}`.trim(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let conflicts: string[] = [];
        try {
          const { stdout: conflictsOut } = await this.runGit(resolvedRepoPath, [
            'diff',
            '--name-only',
            '--diff-filter=U',
          ]);
          conflicts = parseConflictFileList(conflictsOut);
        } catch {
          conflicts = [];
        }

        try {
          await this.runGit(resolvedRepoPath, ['merge', '--abort']);
        } catch {
          // No active merge to abort or abort failed; leave original error context intact.
        }

        return {
          sourceBranch,
          targetBranch,
          success: false,
          conflicts,
          output: message,
        };
      } finally {
        if (switchedBranch) {
          try {
            await this.runGit(resolvedRepoPath, ['checkout', previousBranch]);
          } catch (error) {
            logger.warn(
              { error, repoPath: resolvedRepoPath, previousBranch },
              'Failed to restore previous branch after merge operation',
            );
          }
        }
      }
    });
  }

  async executeRebase(
    repoPath: string | undefined,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<RebaseResult> {
    return this.enqueue(async () => {
      const resolvedRepoPath = this.resolveRepoPath(repoPath);
      const { stdout: currentBranchOut } = await this.runGit(resolvedRepoPath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      const previousBranch = currentBranchOut.trim();
      let switchedBranch = false;

      try {
        if (previousBranch !== sourceBranch) {
          await this.runGit(resolvedRepoPath, ['checkout', sourceBranch]);
          switchedBranch = true;
        }

        const { stdout: rebaseOut, stderr: rebaseErr } = await this.runGit(resolvedRepoPath, [
          'rebase',
          targetBranch,
        ]);

        return {
          sourceBranch,
          targetBranch,
          success: true,
          conflicts: [],
          output: `${rebaseOut}${rebaseErr}`.trim(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let conflicts: string[] = [];
        try {
          const { stdout: conflictsOut } = await this.runGit(resolvedRepoPath, [
            'diff',
            '--name-only',
            '--diff-filter=U',
          ]);
          conflicts = parseConflictFileList(conflictsOut);
        } catch {
          conflicts = [];
        }

        try {
          await this.runGit(resolvedRepoPath, ['rebase', '--abort']);
        } catch {
          // No active rebase to abort or abort failed; leave original error context intact.
        }

        return {
          sourceBranch,
          targetBranch,
          success: false,
          conflicts,
          output: message,
        };
      } finally {
        if (switchedBranch) {
          try {
            await this.runGit(resolvedRepoPath, ['checkout', previousBranch]);
          } catch (error) {
            logger.warn(
              { error, repoPath: resolvedRepoPath, previousBranch },
              'Failed to restore previous branch after rebase operation',
            );
          }
        }
      }
    });
  }

  private async computeBranchStatus(
    repoPath: string,
    baseBranch: string,
    branchName: string,
  ): Promise<BranchStatus> {
    const { stdout } = await this.runGit(repoPath, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseBranch}...${branchName}`,
    ]);
    const [behindRaw = '0', aheadRaw = '0'] = stdout.trim().split(/\s+/);

    return {
      baseBranch,
      branchName,
      commitsBehind: Number.parseInt(behindRaw, 10) || 0,
      commitsAhead: Number.parseInt(aheadRaw, 10) || 0,
    };
  }

  private async runGit(
    repoPath: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return this.gitRunner(repoPath, args);
  }

  private resolveRepoPath(repoPath?: string): string {
    if (repoPath) {
      return resolve(repoPath);
    }

    const env = getEnvConfig();
    if (env.DEVCHAIN_MODE !== 'normal' && env.REPO_ROOT) {
      return resolve(env.REPO_ROOT);
    }

    return resolve(process.cwd());
  }

  private resolveWorktreesRoot(repoPath: string): string {
    const env = getEnvConfig();
    const root = env.WORKTREES_ROOT ?? join(repoPath, '.devchain', 'worktrees');
    return resolve(root);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<{
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return {
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    };
  } catch (error) {
    const command = `git ${args.join(' ')}`;
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    const message = `Git command failed (${command}) in ${cwd}: ${stderr || stdout || String(error)}`;
    throw new Error(message);
  }
}

function parseWorktreeList(rawOutput: string): WorktreeInfo[] {
  if (!rawOutput.trim()) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  const flush = () => {
    if (!current.path) {
      current = {};
      return;
    }
    worktrees.push({
      name: current.name ?? basename(current.path),
      path: current.path,
      branch: current.branch ?? '',
      head: current.head,
      detached: current.detached ?? false,
    });
    current = {};
  };

  for (const line of rawOutput.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }

    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
      current.name = basename(current.path);
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith(REFS_HEADS_PREFIX)
        ? ref.slice(REFS_HEADS_PREFIX.length)
        : ref;
      continue;
    }

    if (line === 'detached') {
      current.detached = true;
    }
  }

  flush();
  return worktrees;
}

function parseChangeSummary(rawOutput: string): ChangeSummary {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return {
      raw: '',
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
  }

  const lines = trimmed.split('\n');
  const totals = lines[lines.length - 1];
  const match = totals.match(
    /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  );

  if (!match) {
    return {
      raw: trimmed,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
  }

  return {
    raw: trimmed,
    filesChanged: Number.parseInt(match[1], 10) || 0,
    insertions: Number.parseInt(match[2] ?? '0', 10) || 0,
    deletions: Number.parseInt(match[3] ?? '0', 10) || 0,
  };
}

function hasMergeConflicts(mergeTreeOutput: string): boolean {
  return /(changed in both|CONFLICT|<<<<<<<|>>>>>>>)/m.test(mergeTreeOutput);
}

function parseConflictFileList(rawOutput: string): string[] {
  return [
    ...new Set(
      rawOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function parseMergeTreeConflicts(rawOutput: string): string[] {
  const conflicts = new Set<string>();
  const lines = rawOutput.split('\n');
  let inConflictBlock = false;

  for (const line of lines) {
    if (/changed in both|CONFLICT/m.test(line)) {
      inConflictBlock = true;
      continue;
    }
    if (!inConflictBlock) {
      continue;
    }

    const match = line.match(/^\s*(?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+?)\s*$/i);
    if (match?.[1]) {
      conflicts.add(match[1].trim());
      continue;
    }

    if (!line.trim()) {
      inConflictBlock = false;
    }
  }

  return [...conflicts];
}
