import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { LocalSkillSource } from '../../storage/models/domain.models';
import {
  parseSkillMarkdown,
  pickString,
  pickStringArray,
  resolveSkillDirectory,
  type ParsedSkillMarkdown,
  SkillDirectoryNotFoundError,
  validatePathSegment,
} from './skill-parsing.utils';
import type {
  SkillManifest,
  SkillSourceAdapter,
  SkillSourceSyncContext,
} from './skill-source.adapter';

const logger = createLogger('LocalSkillSourceAdapter');
const SKILLS_DIRECTORY = 'skills';
const DEFAULT_SKILLS_ROOT = join(homedir(), '.devchain', 'skills');

export class LocalSkillSourceAdapter implements SkillSourceAdapter {
  readonly sourceName: string;
  readonly repoUrl: string;

  private readonly folderPath: string;

  constructor(source: LocalSkillSource) {
    this.sourceName = source.name.trim().toLowerCase();
    this.folderPath = resolve(source.folderPath);
    this.repoUrl = pathToFileURL(this.folderPath).toString();
  }

  async listSkills(): Promise<Map<string, SkillManifest>> {
    const context = await this.createSyncContext();
    try {
      return new Map(context.manifests);
    } finally {
      await context.dispose();
    }
  }

  async createSyncContext(): Promise<SkillSourceSyncContext> {
    const manifests = new Map<string, SkillManifest>();
    const skillNames = await this.listSkillNamesFromLocalFolder();

    for (const skillName of skillNames) {
      try {
        const skillDirectory = await this.resolveStrictLocalSkillDirectory(skillName);
        const parsedSkill = await parseSkillMarkdown(skillDirectory, {
          onMissingFile: ({ skillMdPath }) => {
            logger.warn(
              { sourceName: this.sourceName, skillMdPath },
              'SKILL.md not found for skill',
            );
          },
          onParseError: ({ skillMdPath, error }) => {
            logger.warn(
              {
                sourceName: this.sourceName,
                skillMdPath,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to parse SKILL.md frontmatter for skill. Skipping malformed file.',
            );
          },
        });
        if (!parsedSkill) {
          continue;
        }

        manifests.set(skillName, this.toSkillManifest(skillName, parsedSkill));
      } catch (error) {
        logger.warn(
          {
            sourceName: this.sourceName,
            skillName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed processing local skill. Skipping.',
        );
      }
    }

    return {
      manifests,
      downloadSkill: (skillName: string, targetPath: string) =>
        this.downloadSkill(skillName, targetPath),
      dispose: async () => undefined,
    };
  }

  async downloadSkill(skillName: string, targetPath: string): Promise<string> {
    const safeSourceName = validatePathSegment(this.sourceName, 'sourceName');
    const safeSkillName = validatePathSegment(skillName, 'skillName');
    const storageRoot =
      typeof targetPath === 'string' && targetPath.trim().length > 0
        ? resolve(targetPath)
        : DEFAULT_SKILLS_ROOT;
    const sourceRoot = resolve(storageRoot, safeSourceName);
    const destinationPath = resolve(sourceRoot, safeSkillName);

    if (!destinationPath.startsWith(`${sourceRoot}${sep}`)) {
      throw new ValidationError(
        'Resolved skill destination path is outside the source directory.',
        { sourceRoot, destinationPath },
      );
    }

    try {
      const resolvedSkillPath = await this.resolveStrictLocalSkillDirectory(safeSkillName);
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.rm(destinationPath, { recursive: true, force: true });
      await fs.cp(resolvedSkillPath, destinationPath, { recursive: true, force: true });
      return destinationPath;
    } catch (error) {
      throw this.wrapStorageError('Failed to copy skill from local source.', error, {
        sourceName: safeSourceName,
        skillName: safeSkillName,
      });
    }
  }

  async getLatestCommit(): Promise<string> {
    const skillsRoot = join(this.folderPath, SKILLS_DIRECTORY);
    let rootStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      rootStats = await fs.stat(skillsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Local skills directory not found in source folder.', {
          sourceName: this.sourceName,
          folderPath: this.folderPath,
          skillsRoot,
        });
      }
      throw this.wrapStorageError('Failed to read local skills directory metadata.', error, {
        sourceName: this.sourceName,
        skillsRoot,
      });
    }

    if (!rootStats.isDirectory()) {
      throw new StorageError('Local skills path is not a directory.', {
        sourceName: this.sourceName,
        folderPath: this.folderPath,
        skillsRoot,
      });
    }

    const hashParts: string[] = [`root:${skillsRoot}`];
    const skillNames = await this.listSkillNamesFromLocalFolder();

    for (const skillName of skillNames) {
      hashParts.push(`dir:${skillName}`);
      const skillMdPath = join(skillsRoot, skillName, 'SKILL.md');
      try {
        const skillMdStats = await fs.stat(skillMdPath);
        hashParts.push(`skill:${skillName}:${skillMdStats.mtimeMs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          hashParts.push(`skill:${skillName}:missing`);
          continue;
        }

        throw this.wrapStorageError('Failed to read local skill metadata for commit hash.', error, {
          sourceName: this.sourceName,
          skillsRoot,
          skillName,
          skillMdPath,
        });
      }
    }

    return createHash('sha1').update(hashParts.join('|')).digest('hex');
  }

  private async listSkillNamesFromLocalFolder(): Promise<string[]> {
    const skillsRoot = join(this.folderPath, SKILLS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Local skills directory not found in source folder.', {
          sourceName: this.sourceName,
          folderPath: this.folderPath,
          skillsRoot,
        });
      }
      throw this.wrapStorageError('Failed reading local skills directory.', error, {
        sourceName: this.sourceName,
        skillsRoot,
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async resolveStrictLocalSkillDirectory(skillName: string): Promise<string> {
    try {
      return await resolveSkillDirectory(this.folderPath, skillName, {
        candidates: [SKILLS_DIRECTORY],
        onCandidateError: ({ candidate, error }) => {
          throw this.wrapStorageError('Failed checking local skill directory.', error, {
            sourceName: this.sourceName,
            skillName,
            candidate,
          });
        },
      });
    } catch (error) {
      if (error instanceof SkillDirectoryNotFoundError) {
        throw new StorageError('Skill directory was not found in local source folder.', {
          sourceName: this.sourceName,
          skillName,
          folderPath: this.folderPath,
          skillsRoot: join(this.folderPath, SKILLS_DIRECTORY),
        });
      }
      throw error;
    }
  }

  private toSkillManifest(skillName: string, parsedSkill: ParsedSkillMarkdown): SkillManifest {
    const frontmatter = parsedSkill.frontmatter;
    const manifestName = pickString(frontmatter, ['name']) ?? skillName;
    const displayName = pickString(frontmatter, ['displayName', 'display_name', 'title']);
    const description =
      pickString(frontmatter, ['description', 'summary', 'shortDescription']) ??
      `Skill instructions for ${skillName}`;
    const shortDescription = pickString(frontmatter, [
      'shortDescription',
      'short_description',
      'summary',
    ]);
    const license = pickString(frontmatter, ['license']);
    const compatibility = pickString(frontmatter, ['compatibility']);
    const resources = pickStringArray(frontmatter, ['resources', 'references']);

    return {
      name: manifestName,
      displayName,
      description,
      shortDescription,
      license,
      compatibility,
      frontmatter,
      instructionContent: parsedSkill.instructionContent,
      resources,
      sourceUrl: pathToFileURL(join(this.folderPath, SKILLS_DIRECTORY, skillName)).toString(),
    };
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

    return new StorageError(message, {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
