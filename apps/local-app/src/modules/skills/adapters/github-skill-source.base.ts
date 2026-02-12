import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import matter from 'gray-matter';
import * as tar from 'tar';
import { StorageError, TimeoutError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('GitHubSkillSourceBase');

const DEFAULT_BRANCH = 'main';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'devchain-skills-sync';
const DEFAULT_SKILLS_ROOT = join(homedir(), '.devchain', 'skills');
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const SAFE_SKILL_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

export interface GitHubSkillSourceBaseConfig {
  sourceName?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  timeoutMs?: number;
  userAgent?: string;
  storageRootDir?: string;
  githubToken?: string;
}

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  instructionContent: string;
}

export interface ExtractedRepositoryContext {
  extractedRepoRoot: string;
  dispose(): Promise<void>;
}

export abstract class GitHubSkillSourceBase {
  readonly sourceName: string;
  readonly repoUrl: string;

  protected readonly repoOwner: string;
  protected readonly repoName: string;
  protected readonly branch: string;
  protected readonly timeoutMs: number;
  protected readonly userAgent: string;
  protected readonly storageRootDir: string;
  protected readonly githubToken: string | null;

  constructor(config: GitHubSkillSourceBaseConfig = {}) {
    this.sourceName = config.sourceName ?? 'unknown';
    this.repoOwner = config.repoOwner ?? '';
    this.repoName = config.repoName ?? '';
    this.branch = config.branch ?? DEFAULT_BRANCH;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.storageRootDir = config.storageRootDir ?? DEFAULT_SKILLS_ROOT;
    this.githubToken = config.githubToken ?? process.env.GITHUB_TOKEN ?? null;
    this.repoUrl =
      this.repoOwner && this.repoName
        ? `https://github.com/${this.repoOwner}/${this.repoName}`
        : 'https://github.com';
  }

  async downloadSkill(skillName: string, targetPath: string): Promise<string> {
    const context = await this.prepareExtractedRepository();
    try {
      return await this.downloadSkillFromExtractedRepo(
        skillName,
        targetPath,
        context.extractedRepoRoot,
      );
    } finally {
      await context.dispose();
    }
  }

  async getLatestCommit(): Promise<string> {
    this.ensureRepoConfigured();
    const endpoint = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/commits/${encodeURIComponent(this.branch)}`;
    const response = await this.fetchWithTimeout(endpoint);
    if (!response.ok) {
      throw new StorageError('Failed to fetch latest GitHub commit for skill source.', {
        sourceName: this.sourceName,
        repoOwner: this.repoOwner,
        repoName: this.repoName,
        branch: this.branch,
        status: response.status,
      });
    }

    const payload = (await response.json()) as { sha?: unknown };
    if (typeof payload.sha !== 'string' || payload.sha.length === 0) {
      throw new StorageError('GitHub commit response did not include a valid SHA.', {
        sourceName: this.sourceName,
        repoOwner: this.repoOwner,
        repoName: this.repoName,
        branch: this.branch,
      });
    }
    return payload.sha;
  }

  protected async parseSkillMarkdown(skillDirectory: string): Promise<ParsedSkillMarkdown | null> {
    const safeSkillDirectory = resolve(skillDirectory);
    const skillMdPath = join(safeSkillDirectory, 'SKILL.md');

    let markdown: string;
    try {
      markdown = await fs.readFile(skillMdPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn({ sourceName: this.sourceName, skillMdPath }, 'SKILL.md not found for skill');
        return null;
      }
      throw this.wrapStorageError('Failed reading SKILL.md for skill.', error, {
        sourceName: this.sourceName,
        skillMdPath,
      });
    }

    try {
      const parsed = matter(markdown);
      const frontmatter =
        parsed.data && typeof parsed.data === 'object'
          ? (parsed.data as Record<string, unknown>)
          : {};
      return {
        frontmatter,
        instructionContent: parsed.content,
      };
    } catch (error) {
      logger.warn(
        {
          sourceName: this.sourceName,
          skillMdPath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse SKILL.md frontmatter for skill. Skipping malformed file.',
      );
      return null;
    }
  }

  protected getSkillStorageRoot(): string {
    return resolve(this.storageRootDir);
  }

  protected validatePathSegment(segment: string, fieldName: string): string {
    const trimmed = segment.trim();
    if (!trimmed) {
      throw new ValidationError(`Invalid ${fieldName}: value cannot be empty.`, { fieldName });
    }
    if (
      trimmed.includes('..') ||
      trimmed.includes('/') ||
      trimmed.includes('\\') ||
      CONTROL_CHAR_REGEX.test(trimmed)
    ) {
      throw new ValidationError(
        `Invalid ${fieldName}: path traversal or control characters are not allowed.`,
        { fieldName, segment: trimmed },
      );
    }
    if (!SAFE_SKILL_SEGMENT_REGEX.test(trimmed)) {
      throw new ValidationError(
        `Invalid ${fieldName}: only alphanumeric characters, underscores, and hyphens are allowed.`,
        { fieldName, segment: trimmed },
      );
    }
    return trimmed;
  }

  protected pickString(
    frontmatter: Record<string, unknown>,
    keys: readonly string[],
  ): string | undefined {
    for (const key of keys) {
      const value = this.toStringValue(frontmatter[key]);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  protected pickStringArray(
    frontmatter: Record<string, unknown>,
    keys: readonly string[],
  ): string[] {
    for (const key of keys) {
      const value = frontmatter[key];
      if (!Array.isArray(value)) {
        continue;
      }

      const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (items.length > 0) {
        return items;
      }
    }

    return [];
  }

  protected toStringValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (items.length > 0) {
        return items.join(', ');
      }
    }

    return undefined;
  }

  protected async resolveSkillDirectory(
    extractedRepoRoot: string,
    skillName: string,
  ): Promise<string> {
    const candidates = [
      join(extractedRepoRoot, skillName),
      join(extractedRepoRoot, 'skills', skillName),
      join(extractedRepoRoot, 'library', skillName),
    ];

    for (const candidate of candidates) {
      try {
        const stats = await fs.stat(candidate);
        if (stats.isDirectory()) {
          return candidate;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw this.wrapStorageError('Failed checking extracted skill directory.', error, {
            candidate,
            sourceName: this.sourceName,
            skillName,
          });
        }
      }
    }

    throw new StorageError('Skill directory was not found in extracted repository tarball.', {
      sourceName: this.sourceName,
      skillName,
      extractedRepoRoot,
    });
  }

  protected async prepareExtractedRepository(): Promise<ExtractedRepositoryContext> {
    this.ensureRepoConfigured();
    const safeSourceName = this.validatePathSegment(this.sourceName, 'sourceName');
    const tempRoot = await fs.mkdtemp(join(tmpdir(), `skills-${safeSourceName}-`));
    const archivePath = join(tempRoot, 'repo.tar.gz');
    const extractPath = join(tempRoot, 'repo');
    let disposed = false;

    const dispose = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      await this.cleanupTempDirectory(tempRoot);
    };

    try {
      await fs.mkdir(extractPath, { recursive: true });
      await this.downloadTarball(archivePath);
      await tar.x({
        file: archivePath,
        cwd: extractPath,
        strip: 1,
        strict: true,
      });

      return {
        extractedRepoRoot: extractPath,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw this.wrapStorageError('Failed to download and extract skills repository.', error, {
        sourceName: safeSourceName,
      });
    }
  }

  protected async downloadSkillFromExtractedRepo(
    skillName: string,
    targetPath: string,
    extractedRepoRoot: string,
  ): Promise<string> {
    this.ensureRepoConfigured();
    const safeSourceName = this.validatePathSegment(this.sourceName, 'sourceName');
    const safeSkillName = this.validatePathSegment(skillName, 'skillName');
    const storageRoot =
      typeof targetPath === 'string' && targetPath.trim().length > 0
        ? resolve(targetPath)
        : resolve(this.storageRootDir);
    const sourceRoot = resolve(storageRoot, safeSourceName);
    const destinationPath = resolve(sourceRoot, safeSkillName);

    if (!destinationPath.startsWith(`${sourceRoot}${sep}`)) {
      throw new ValidationError(
        'Resolved skill destination path is outside the source directory.',
        {
          sourceRoot,
          destinationPath,
        },
      );
    }

    try {
      const resolvedSkillPath = await this.resolveSkillDirectory(
        resolve(extractedRepoRoot),
        safeSkillName,
      );
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.rm(destinationPath, { recursive: true, force: true });
      await fs.cp(resolvedSkillPath, destinationPath, { recursive: true, force: true });
      return destinationPath;
    } catch (error) {
      throw this.wrapStorageError('Failed to copy skill from extracted repository.', error, {
        sourceName: safeSourceName,
        skillName: safeSkillName,
      });
    }
  }

  private ensureRepoConfigured(): void {
    if (!this.repoOwner || !this.repoName) {
      throw new ValidationError(
        'GitHub skill source adapter is missing repository configuration.',
        { sourceName: this.sourceName },
      );
    }
  }

  private getTarballUrl(): string {
    return `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/tarball/${encodeURIComponent(this.branch)}`;
  }

  private buildGitHubHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.githubToken) {
      headers.Authorization = `Bearer ${this.githubToken}`;
    }
    return headers;
  }

  private async downloadTarball(destinationPath: string): Promise<void> {
    const response = await this.fetchWithTimeout(this.getTarballUrl());
    if (!response.ok || !response.body) {
      throw new StorageError('Failed to download GitHub tarball for skill source.', {
        sourceName: this.sourceName,
        repoOwner: this.repoOwner,
        repoName: this.repoName,
        branch: this.branch,
        status: response.status,
      });
    }

    await fs.mkdir(dirname(destinationPath), { recursive: true });
    const writeStream = createWriteStream(destinationPath);
    const bodyStream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    await pipeline(bodyStream, writeStream);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: this.buildGitHubHeaders(),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError('GitHub skill source request timed out.', {
          sourceName: this.sourceName,
          timeoutMs: this.timeoutMs,
          url,
        });
      }
      throw this.wrapStorageError('GitHub skill source request failed.', error, {
        sourceName: this.sourceName,
        url,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async cleanupTempDirectory(tempRoot: string): Promise<void> {
    try {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.warn(
        {
          tempRoot,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
        'Failed to cleanup temporary GitHub skill directory',
      );
    }
  }

  private wrapStorageError(
    message: string,
    error: unknown,
    details: Record<string, unknown>,
  ): StorageError {
    if (error instanceof StorageError) {
      return error;
    }
    if (error instanceof ValidationError) {
      throw error;
    }
    if (error instanceof TimeoutError) {
      throw error;
    }
    return new StorageError(message, {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
