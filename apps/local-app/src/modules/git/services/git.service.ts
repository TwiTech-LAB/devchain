import { Injectable, Inject } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';
import { NotFoundError, ValidationError, IOError } from '../../../common/errors/error-types';

const execFileAsync = promisify(execFile);
const logger = createLogger('GitService');

// 10MB buffer for large diffs
const MAX_BUFFER = 10 * 1024 * 1024;

// 1MB max file size for untracked file diffs
const MAX_UNTRACKED_FILE_SIZE = 1 * 1024 * 1024;

// Max number of untracked files to generate diffs for (performance cap)
const MAX_UNTRACKED_DIFFS = 50;

export interface Commit {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
}

export interface Branch {
  name: string;
  sha: string;
  isCurrent: boolean;
}

export interface Tag {
  name: string;
  sha: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  oldPath?: string; // For renamed/copied files
}

/** Filter for working tree changes */
export type WorkingTreeFilter = 'all' | 'staged' | 'unstaged';

/** Working tree changes grouped by type */
export interface WorkingTreeChanges {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: string[];
}

/** Result from getWorkingTreeDiff including performance cap indicator */
export interface WorkingTreeDiffResult {
  diff: string;
  /** True if untracked file diffs were capped for performance (more than MAX_UNTRACKED_DIFFS files) */
  untrackedDiffsCapped: boolean;
  /** Total number of untracked files */
  untrackedTotal: number;
  /** Number of untracked files with diffs included */
  untrackedProcessed: number;
}

/** Combined result from getWorkingTreeData - changes and diff in single call */
export interface WorkingTreeData {
  changes: WorkingTreeChanges;
  diff: string;
  /** True if untracked file diffs were capped for performance */
  untrackedDiffsCapped: boolean;
  /** Total number of untracked files */
  untrackedTotal: number;
  /** Number of untracked files with diffs included */
  untrackedProcessed: number;
}

@Injectable()
export class GitService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  /**
   * Execute a git command in the project's root directory.
   * Ensures the project exists and has a .git directory.
   *
   * @param projectId - Project ID to execute command in
   * @param args - Git command arguments
   * @param options.maxBuffer - Max buffer size for output (default: MAX_BUFFER)
   * @param options.allowNonZero - If true, non-zero exit codes don't throw (useful for diff commands)
   * @param options.rootPath - Pre-resolved root path to skip storage lookup (performance optimization)
   * @returns stdout from the git command
   */
  private async execGit(
    projectId: string,
    args: string[],
    options?: { maxBuffer?: number; allowNonZero?: boolean; rootPath?: string },
  ): Promise<string> {
    // Use provided rootPath or resolve from storage
    const rootPath = options?.rootPath ?? (await this.storage.getProject(projectId)).rootPath;

    // Validate .git directory exists
    const gitDir = join(rootPath, '.git');
    if (!existsSync(gitDir)) {
      throw new ValidationError('Project is not a git repository', {
        projectId,
        rootPath,
      });
    }

    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: rootPath,
        maxBuffer: options?.maxBuffer ?? MAX_BUFFER,
      });
      return stdout;
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: number; stdout?: string };

      // If allowNonZero is set and exit code is 1, return stdout
      // This is useful for commands like `git diff --no-index` which exits with 1 when there are differences
      // Exit code 2+ indicates real errors (e.g., file not found) and should still throw
      if (options?.allowNonZero && err.code === 1 && err.stdout !== undefined) {
        return err.stdout;
      }

      logger.error({ error: err.message, args, projectId }, 'Git command failed');
      throw new IOError('Git command failed', {
        projectId,
        command: `git ${args.join(' ')}`,
        stderr: err.stderr,
        code: err.code,
      });
    }
  }

  /**
   * Validate that a file path is within the project root (security).
   */
  private validatePathWithinProject(rootPath: string, filePath: string): string {
    // Resolve the full path
    const fullPath = isAbsolute(filePath) ? filePath : join(rootPath, filePath);
    const resolvedPath = resolve(fullPath);
    const resolvedRoot = resolve(rootPath);

    // Ensure the path is within the project root
    const relativePath = relative(resolvedRoot, resolvedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new ValidationError('File path is outside project root', {
        filePath,
        rootPath,
      });
    }

    // Return the relative path from root
    return relativePath;
  }

  /**
   * Resolve a ref (branch, tag, or commit) to its SHA.
   */
  async resolveRef(projectId: string, ref: string): Promise<string> {
    const output = await this.execGit(projectId, ['rev-parse', ref]);
    return output.trim();
  }

  /**
   * List commits with pagination.
   */
  async listCommits(
    projectId: string,
    options?: { limit?: number; ref?: string },
  ): Promise<Commit[]> {
    const limit = options?.limit ?? 50;
    const ref = options?.ref ?? 'HEAD';

    // Use a custom format for easy parsing
    // %H = full hash, %s = subject, %an = author name, %ae = author email, %aI = ISO date
    const format = '%H%x00%s%x00%an%x00%ae%x00%aI';
    const output = await this.execGit(projectId, ['log', `--format=${format}`, `-n${limit}`, ref]);

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, message, author, authorEmail, date] = line.split('\x00');
        return { sha, message, author, authorEmail, date };
      });
  }

  /**
   * List all branches.
   */
  async listBranches(projectId: string): Promise<Branch[]> {
    // Format: refname:short, objectname, HEAD marker
    const output = await this.execGit(projectId, [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(HEAD)',
      'refs/heads/',
    ]);

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, sha, headMarker] = line.split('\x00');
        return {
          name,
          sha,
          isCurrent: headMarker === '*',
        };
      });
  }

  /**
   * List all tags.
   */
  async listTags(projectId: string): Promise<Tag[]> {
    const output = await this.execGit(projectId, [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)',
      'refs/tags/',
    ]);

    if (!output.trim()) {
      return [];
    }

    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, sha] = line.split('\x00');
        return { name, sha };
      });
  }

  /**
   * Get unified diff between two SHAs.
   */
  async getDiff(projectId: string, baseSha: string, headSha: string): Promise<string> {
    const output = await this.execGit(projectId, ['diff', baseSha, headSha]);
    return output;
  }

  /**
   * Get list of changed files between two SHAs with stats.
   */
  async getChangedFiles(
    projectId: string,
    baseSha: string,
    headSha: string,
  ): Promise<ChangedFile[]> {
    // Use --numstat for additions/deletions and --name-status for status
    const [numstatOutput, statusOutput] = await Promise.all([
      this.execGit(projectId, ['diff', '--numstat', baseSha, headSha]),
      this.execGit(projectId, ['diff', '--name-status', baseSha, headSha]),
    ]);

    // Parse numstat: additions, deletions, path (tab-separated)
    const stats = new Map<string, { additions: number; deletions: number }>();
    if (numstatOutput.trim()) {
      for (const line of numstatOutput.trim().split(/\r?\n/).filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t'); // Handle paths with tabs
        stats.set(path, {
          additions: add === '-' ? 0 : parseInt(add, 10),
          deletions: del === '-' ? 0 : parseInt(del, 10),
        });
      }
    }

    // Parse name-status: status, path (and optionally old path for renames)
    const files: ChangedFile[] = [];
    if (statusOutput.trim()) {
      for (const line of statusOutput.trim().split(/\r?\n/).filter(Boolean)) {
        const parts = line.split('\t');
        const statusCode = parts[0];
        const path = parts.length > 2 ? parts[2] : parts[1]; // New path for renames
        const oldPath = parts.length > 2 ? parts[1] : undefined;

        let status: ChangedFile['status'];
        switch (statusCode[0]) {
          case 'A':
            status = 'added';
            break;
          case 'M':
            status = 'modified';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'renamed';
            break;
          case 'C':
            status = 'copied';
            break;
          default:
            status = 'modified';
        }

        const fileStats = stats.get(path) ??
          stats.get(oldPath ?? '') ?? { additions: 0, deletions: 0 };

        files.push({
          path,
          status,
          additions: fileStats.additions,
          deletions: fileStats.deletions,
          ...(oldPath && { oldPath }),
        });
      }
    }

    return files;
  }

  /**
   * Get file content at a specific ref.
   */
  async getFileContent(projectId: string, ref: string, filePath: string): Promise<string> {
    const project = await this.storage.getProject(projectId);
    const relativePath = this.validatePathWithinProject(project.rootPath, filePath);

    try {
      const output = await this.execGit(projectId, ['show', `${ref}:${relativePath}`]);
      return output;
    } catch (error) {
      // Check if the file doesn't exist at that ref
      const err = error as Error & { stderr?: string };
      if (err.stderr?.includes('does not exist') || err.stderr?.includes('Path')) {
        throw new NotFoundError('File at ref', `${ref}:${relativePath}`);
      }
      throw error;
    }
  }

  /**
   * Check if a project is a git repository.
   */
  async isGitRepository(projectId: string): Promise<boolean> {
    try {
      const project = await this.storage.getProject(projectId);
      const gitDir = join(project.rootPath, '.git');
      return existsSync(gitDir);
    } catch {
      return false;
    }
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(projectId: string): Promise<string | null> {
    try {
      const output = await this.execGit(projectId, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = output.trim();
      return branch === 'HEAD' ? null : branch; // Detached HEAD returns 'HEAD'
    } catch {
      return null;
    }
  }

  /**
   * Parse git diff numstat and name-status output into ChangedFile array.
   * Helper for working tree and commit diff methods.
   */
  private parseChangedFiles(numstatOutput: string, statusOutput: string): ChangedFile[] {
    // Parse numstat: additions, deletions, path (tab-separated)
    const stats = new Map<string, { additions: number; deletions: number }>();
    if (numstatOutput.trim()) {
      for (const line of numstatOutput.trim().split(/\r?\n/).filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t'); // Handle paths with tabs
        stats.set(path, {
          additions: add === '-' ? 0 : parseInt(add, 10),
          deletions: del === '-' ? 0 : parseInt(del, 10),
        });
      }
    }

    // Parse name-status: status, path (and optionally old path for renames)
    const files: ChangedFile[] = [];
    if (statusOutput.trim()) {
      for (const line of statusOutput.trim().split(/\r?\n/).filter(Boolean)) {
        const parts = line.split('\t');
        const statusCode = parts[0];
        const path = parts.length > 2 ? parts[2] : parts[1]; // New path for renames
        const oldPath = parts.length > 2 ? parts[1] : undefined;

        let status: ChangedFile['status'];
        switch (statusCode[0]) {
          case 'A':
            status = 'added';
            break;
          case 'M':
            status = 'modified';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'renamed';
            break;
          case 'C':
            status = 'copied';
            break;
          default:
            status = 'modified';
        }

        const fileStats = stats.get(path) ??
          stats.get(oldPath ?? '') ?? { additions: 0, deletions: 0 };

        files.push({
          path,
          status,
          additions: fileStats.additions,
          deletions: fileStats.deletions,
          ...(oldPath && { oldPath }),
        });
      }
    }

    return files;
  }

  /**
   * Get working tree changes (staged, unstaged, untracked).
   * @param projectId - Project ID
   * @param filter - 'all' (default), 'staged', or 'unstaged'
   * @returns Working tree changes grouped by type
   */
  async getWorkingTreeChanges(
    projectId: string,
    filter: WorkingTreeFilter = 'all',
  ): Promise<WorkingTreeChanges> {
    // Resolve rootPath once to avoid repeated storage lookups
    const project = await this.storage.getProject(projectId);
    const rootPath = project.rootPath;

    const result: WorkingTreeChanges = {
      staged: [],
      unstaged: [],
      untracked: [],
    };

    // Get staged changes (--cached)
    if (filter === 'all' || filter === 'staged') {
      try {
        const [stagedNumstat, stagedStatus] = await Promise.all([
          this.execGit(projectId, ['diff', '--cached', '--numstat'], { rootPath }),
          this.execGit(projectId, ['diff', '--cached', '--name-status'], { rootPath }),
        ]);
        result.staged = this.parseChangedFiles(stagedNumstat, stagedStatus);
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get staged changes');
      }
    }

    // Get unstaged changes (working directory vs index)
    if (filter === 'all' || filter === 'unstaged') {
      try {
        const [unstagedNumstat, unstagedStatus] = await Promise.all([
          this.execGit(projectId, ['diff', '--numstat'], { rootPath }),
          this.execGit(projectId, ['diff', '--name-status'], { rootPath }),
        ]);
        result.unstaged = this.parseChangedFiles(unstagedNumstat, unstagedStatus);
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get unstaged changes');
      }
    }

    // Get untracked files
    if (filter === 'all') {
      try {
        const untrackedOutput = await this.execGit(
          projectId,
          ['ls-files', '--others', '--exclude-standard'],
          { rootPath },
        );
        result.untracked = untrackedOutput.trim()
          ? untrackedOutput.trim().split(/\r?\n/).filter(Boolean)
          : [];
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get untracked files');
      }
    }

    return result;
  }

  /**
   * Get working tree changes AND diff in a single call.
   * This method is more efficient than calling getWorkingTreeChanges and getWorkingTreeDiff
   * separately, as it only calls `git ls-files --others` once.
   *
   * @param projectId - Project ID
   * @param filter - 'all' (default), 'staged', or 'unstaged'
   * @returns Combined changes, diff, and cap metadata
   */
  async getWorkingTreeData(
    projectId: string,
    filter: WorkingTreeFilter = 'all',
  ): Promise<WorkingTreeData> {
    const project = await this.storage.getProject(projectId);
    const rootPath = project.rootPath;

    const changes: WorkingTreeChanges = {
      staged: [],
      unstaged: [],
      untracked: [],
    };
    const diffs: string[] = [];
    let untrackedDiffsCapped = false;
    let untrackedTotal = 0;
    let untrackedProcessed = 0;

    // Get staged changes and diff (pass rootPath to avoid storage lookups)
    if (filter === 'all' || filter === 'staged') {
      try {
        const [stagedNumstat, stagedStatus, stagedDiff] = await Promise.all([
          this.execGit(projectId, ['diff', '--cached', '--numstat'], { rootPath }),
          this.execGit(projectId, ['diff', '--cached', '--name-status'], { rootPath }),
          this.execGit(projectId, ['diff', '--cached'], { rootPath }),
        ]);
        changes.staged = this.parseChangedFiles(stagedNumstat, stagedStatus);
        if (stagedDiff.trim()) {
          diffs.push(stagedDiff);
        }
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get staged changes');
      }
    }

    // Get unstaged changes and diff (pass rootPath to avoid storage lookups)
    if (filter === 'all' || filter === 'unstaged') {
      try {
        const [unstagedNumstat, unstagedStatus, unstagedDiff] = await Promise.all([
          this.execGit(projectId, ['diff', '--numstat'], { rootPath }),
          this.execGit(projectId, ['diff', '--name-status'], { rootPath }),
          this.execGit(projectId, ['diff'], { rootPath }),
        ]);
        changes.unstaged = this.parseChangedFiles(unstagedNumstat, unstagedStatus);
        if (unstagedDiff.trim()) {
          diffs.push(unstagedDiff);
        }
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get unstaged changes');
      }
    }

    // Get untracked files and their diffs (single git ls-files call)
    if (filter === 'all') {
      try {
        const untrackedOutput = await this.execGit(
          projectId,
          ['ls-files', '--others', '--exclude-standard'],
          { rootPath },
        );
        const untrackedFiles = untrackedOutput.trim()
          ? untrackedOutput.trim().split(/\r?\n/).filter(Boolean)
          : [];

        // Set untracked file list for changes
        changes.untracked = untrackedFiles;

        // Generate diffs for untracked files (reusing the list)
        if (untrackedFiles.length > 0) {
          const untrackedResult = await this.getUntrackedFileDiffs(
            projectId,
            rootPath,
            untrackedFiles,
          );
          if (untrackedResult.diffs.length > 0) {
            diffs.push(...untrackedResult.diffs);
          }
          untrackedDiffsCapped = untrackedResult.capped;
          untrackedTotal = untrackedResult.total;
          untrackedProcessed = untrackedResult.processed;
        }
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get untracked files');
      }
    }

    return {
      changes,
      diff: diffs.join('\n'),
      untrackedDiffsCapped,
      untrackedTotal,
      untrackedProcessed,
    };
  }

  /**
   * Get unified diff for working tree changes.
   * @param projectId - Project ID
   * @param filter - 'all' (default), 'staged', or 'unstaged'
   * @returns WorkingTreeDiffResult with diff string and performance cap metadata
   */
  async getWorkingTreeDiff(
    projectId: string,
    filter: WorkingTreeFilter = 'all',
  ): Promise<WorkingTreeDiffResult> {
    const project = await this.storage.getProject(projectId);
    const rootPath = project.rootPath;
    const diffs: string[] = [];
    let untrackedDiffsCapped = false;
    let untrackedTotal = 0;
    let untrackedProcessed = 0;

    // Get staged diff (pass rootPath to avoid storage lookups)
    if (filter === 'all' || filter === 'staged') {
      try {
        const stagedDiff = await this.execGit(projectId, ['diff', '--cached'], { rootPath });
        if (stagedDiff.trim()) {
          diffs.push(stagedDiff);
        }
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get staged diff');
      }
    }

    // Get unstaged diff (pass rootPath to avoid storage lookups)
    if (filter === 'all' || filter === 'unstaged') {
      try {
        const unstagedDiff = await this.execGit(projectId, ['diff'], { rootPath });
        if (unstagedDiff.trim()) {
          diffs.push(unstagedDiff);
        }
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get unstaged diff');
      }
    }

    // Get untracked file diffs (only for 'all' filter)
    if (filter === 'all') {
      try {
        const untrackedResult = await this.getUntrackedFileDiffs(projectId, rootPath);
        if (untrackedResult.diffs.length > 0) {
          diffs.push(...untrackedResult.diffs);
        }
        untrackedDiffsCapped = untrackedResult.capped;
        untrackedTotal = untrackedResult.total;
        untrackedProcessed = untrackedResult.processed;
      } catch (error) {
        logger.warn({ error, projectId }, 'Failed to get untracked file diffs');
      }
    }

    return {
      diff: diffs.join('\n'),
      untrackedDiffsCapped,
      untrackedTotal,
      untrackedProcessed,
    };
  }

  /**
   * Generate diffs for untracked files.
   * Uses `git diff --no-index -- /dev/null <path>` to treat files as new.
   * Includes guardrails for binary files, large files, and max file count.
   *
   * @param projectId - Project ID
   * @param rootPath - Project root path
   * @param untrackedFiles - Optional pre-fetched list of untracked files (avoids duplicate git call)
   */
  private async getUntrackedFileDiffs(
    projectId: string,
    rootPath: string,
    untrackedFiles?: string[],
  ): Promise<{ diffs: string[]; capped: boolean; total: number; processed: number }> {
    // Use provided list or fetch from git
    if (!untrackedFiles) {
      const untrackedOutput = await this.execGit(
        projectId,
        ['ls-files', '--others', '--exclude-standard'],
        { rootPath },
      );

      if (!untrackedOutput.trim()) {
        return { diffs: [], capped: false, total: 0, processed: 0 };
      }

      untrackedFiles = untrackedOutput.trim().split(/\r?\n/).filter(Boolean);
    }

    if (untrackedFiles.length === 0) {
      return { diffs: [], capped: false, total: 0, processed: 0 };
    }
    const diffs: string[] = [];
    const total = untrackedFiles.length;
    const capped = total > MAX_UNTRACKED_DIFFS;

    // Cap the number of untracked files to process (performance)
    const filesToProcess = untrackedFiles.slice(0, MAX_UNTRACKED_DIFFS);
    if (capped) {
      logger.info(
        { projectId, total, processed: MAX_UNTRACKED_DIFFS },
        'Capping untracked file diffs for performance',
      );
    }

    for (const filePath of filesToProcess) {
      try {
        // Validate path is within project root (security)
        const relativePath = this.validatePathWithinProject(rootPath, filePath);
        const fullPath = join(rootPath, relativePath);

        // Check if file exists (might have been deleted since ls-files)
        if (!existsSync(fullPath)) {
          continue;
        }

        // Check file size (skip large files)
        const stats = statSync(fullPath);
        if (stats.size > MAX_UNTRACKED_FILE_SIZE) {
          // Generate a placeholder diff for large files
          diffs.push(this.generateLargeFilePlaceholderDiff(relativePath, stats.size));
          continue;
        }

        // Check if file is binary using git's detection (pass rootPath to avoid storage lookup)
        const isBinary = await this.isFileBinary(projectId, relativePath, rootPath);
        if (isBinary) {
          // Generate a placeholder diff for binary files
          diffs.push(this.generateBinaryFilePlaceholderDiff(relativePath));
          continue;
        }

        // Generate diff for this untracked file
        // git diff --no-index exits with code 1 when there are differences (which is expected)
        const diff = await this.execGit(
          projectId,
          ['diff', '--no-index', '--', '/dev/null', relativePath],
          { allowNonZero: true, rootPath },
        );

        if (diff.trim()) {
          diffs.push(diff);
        }
      } catch (error) {
        logger.warn({ error, projectId, filePath }, 'Failed to generate diff for untracked file');
      }
    }

    return { diffs, capped, total, processed: filesToProcess.length };
  }

  /**
   * Check if a file is binary using git's detection.
   * @param projectId - Project ID
   * @param relativePath - Relative path to the file
   * @param rootPath - Pre-resolved root path to avoid storage lookup in loops
   */
  private async isFileBinary(
    projectId: string,
    relativePath: string,
    rootPath: string,
  ): Promise<boolean> {
    try {
      // Use git diff to check - it will output "Binary files differ" for binary files
      const output = await this.execGit(
        projectId,
        ['diff', '--no-index', '--numstat', '--', '/dev/null', relativePath],
        { allowNonZero: true, rootPath },
      );
      // Binary files show as "-\t-\t" in numstat output
      return output.startsWith('-\t-\t');
    } catch {
      // If we can't determine, assume text
      return false;
    }
  }

  /**
   * Generate a placeholder diff for binary files.
   */
  private generateBinaryFilePlaceholderDiff(relativePath: string): string {
    return `diff --git a/${relativePath} b/${relativePath}
new file mode 100644
--- /dev/null
+++ b/${relativePath}
@@ -0,0 +1 @@
+Binary file (content not shown)
\\ No newline at end of file`;
  }

  /**
   * Generate a placeholder diff for large files.
   */
  private generateLargeFilePlaceholderDiff(relativePath: string, size: number): string {
    const sizeMB = (size / (1024 * 1024)).toFixed(2);
    return `diff --git a/${relativePath} b/${relativePath}
new file mode 100644
--- /dev/null
+++ b/${relativePath}
@@ -0,0 +1 @@
+File too large (${sizeMB}MB) - content not shown
\\ No newline at end of file`;
  }

  /**
   * Get the diff for a single commit.
   * @param projectId - Project ID
   * @param sha - Commit SHA
   * @returns Unified diff string compatible with react-diff-view
   */
  async getCommitDiff(projectId: string, sha: string): Promise<string> {
    // Validate SHA format (basic check)
    if (!/^[a-f0-9]{4,40}$/i.test(sha)) {
      throw new ValidationError('Invalid commit SHA', { sha });
    }

    // Use git show with --format= to suppress commit message, only get diff
    const output = await this.execGit(projectId, ['show', sha, '--format=']);
    return output;
  }

  /**
   * Get changed files for a single commit.
   * @param projectId - Project ID
   * @param sha - Commit SHA
   * @returns Array of changed files with stats
   */
  async getCommitChangedFiles(projectId: string, sha: string): Promise<ChangedFile[]> {
    // Validate SHA format (basic check)
    if (!/^[a-f0-9]{4,40}$/i.test(sha)) {
      throw new ValidationError('Invalid commit SHA', { sha });
    }

    const [numstatOutput, statusOutput] = await Promise.all([
      this.execGit(projectId, ['show', sha, '--format=', '--numstat']),
      this.execGit(projectId, ['show', sha, '--format=', '--name-status']),
    ]);

    return this.parseChangedFiles(numstatOutput, statusOutput);
  }
}
