import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  GitHubSkillSourceBase,
  type GitHubSkillSourceBaseConfig,
  type ParsedSkillMarkdown,
} from './github-skill-source.base';
import { validateRepositoryRelativePath } from './skill-parsing.utils';
import type {
  SkillDiscoveryError,
  SkillManifest,
  SkillSourceAdapter,
  SkillSourceSyncContext,
} from './skill-source.adapter';

const logger = createLogger('GitHubDirectorySkillSourceAdapter');

export interface GitHubDirectorySkillSourceConfig extends GitHubSkillSourceBaseConfig {
  sourceName: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  skillsRoot: string;
}

export class GitHubDirectorySkillSourceAdapter
  extends GitHubSkillSourceBase
  implements SkillSourceAdapter
{
  readonly skillsRoot: string;

  private readonly skillsRootSegments: readonly string[];

  constructor(config: GitHubDirectorySkillSourceConfig) {
    super(config);
    this.skillsRootSegments = validateRepositoryRelativePath(config.skillsRoot, 'skillsRoot');
    this.skillsRoot = this.skillsRootSegments.join('/');
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
    const repoContext = await this.prepareExtractedRepository();
    const manifests = new Map<string, SkillManifest>();
    const discoveryErrors: SkillDiscoveryError[] = [];
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      await repoContext.dispose();
    };

    try {
      const skillNames = await this.listSkillNamesFromExtractedRepo(repoContext.extractedRepoRoot);
      for (const skillName of skillNames) {
        try {
          const skillDirectory = await this.resolveSkillDirectory(
            repoContext.extractedRepoRoot,
            skillName,
          );
          const parsedSkill = await this.parseSkillMarkdown(skillDirectory);
          if (!parsedSkill) {
            continue;
          }
          manifests.set(skillName, this.toSkillManifest(skillName, parsedSkill));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          discoveryErrors.push({ skillName, message });
          logger.warn(
            { sourceName: this.sourceName, skillName, error: message },
            'Failed processing GitHub directory skill. Skipping.',
          );
        }
      }

      return {
        manifests,
        discoveryErrors,
        downloadSkill: async (skillName: string, targetPath: string) =>
          this.downloadSkillFromExtractedRepo(skillName, targetPath, repoContext.extractedRepoRoot),
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  protected override async resolveSkillDirectory(
    extractedRepoRoot: string,
    skillName: string,
  ): Promise<string> {
    const skillsRoot = await this.resolveSkillsRoot(extractedRepoRoot);
    const strictSkillPath = resolve(skillsRoot, skillName);
    this.assertContainedPath(skillsRoot, strictSkillPath, 'skillName');

    try {
      const stats = await fs.stat(strictSkillPath);
      if (!stats.isDirectory()) {
        throw new StorageError('Skill path in repository archive is not a directory.', {
          sourceName: this.sourceName,
          skillName,
          candidate: strictSkillPath,
        });
      }
      const realSkillPath = await fs.realpath(strictSkillPath);
      this.assertContainedPath(await fs.realpath(skillsRoot), realSkillPath, 'skillName');
      return strictSkillPath;
    } catch (error) {
      if (error instanceof StorageError || error instanceof ValidationError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Skill directory was not found in extracted repository tarball.', {
          sourceName: this.sourceName,
          skillName,
          extractedRepoRoot: resolve(extractedRepoRoot),
          candidate: strictSkillPath,
        });
      }
      throw new StorageError('Failed checking extracted GitHub skill directory.', {
        sourceName: this.sourceName,
        skillName,
        candidate: strictSkillPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async listSkillNamesFromExtractedRepo(extractedRepoRoot: string): Promise<string[]> {
    const skillsRoot = await this.resolveSkillsRoot(extractedRepoRoot);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      throw new StorageError('Failed reading configured skills directory in repository archive.', {
        sourceName: this.sourceName,
        skillsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async resolveSkillsRoot(extractedRepoRoot: string): Promise<string> {
    const safeExtractedRepoRoot = resolve(extractedRepoRoot);
    const skillsRoot = resolve(safeExtractedRepoRoot, ...this.skillsRootSegments);
    this.assertContainedPath(safeExtractedRepoRoot, skillsRoot, 'skillsRoot');

    try {
      const realExtractedRepoRoot = await fs.realpath(safeExtractedRepoRoot);
      const realSkillsRoot = await fs.realpath(skillsRoot);
      this.assertContainedPath(realExtractedRepoRoot, realSkillsRoot, 'skillsRoot');
      const stats = await fs.stat(realSkillsRoot);
      if (!stats.isDirectory()) {
        throw new StorageError('Configured skills root in repository archive is not a directory.', {
          sourceName: this.sourceName,
          skillsRoot,
        });
      }
      return skillsRoot;
    } catch (error) {
      if (error instanceof StorageError || error instanceof ValidationError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Configured skills root was not found in repository archive.', {
          sourceName: this.sourceName,
          skillsRoot,
        });
      }
      throw new StorageError('Failed checking configured skills root in repository archive.', {
        sourceName: this.sourceName,
        skillsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private assertContainedPath(rootPath: string, candidatePath: string, fieldName: string): void {
    const relativePath = relative(rootPath, candidatePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new ValidationError(`Invalid ${fieldName}: resolved path escapes its allowed root.`, {
        fieldName,
        rootPath,
        candidatePath,
      });
    }
  }

  private toSkillManifest(skillName: string, parsedSkill: ParsedSkillMarkdown): SkillManifest {
    const frontmatter = parsedSkill.frontmatter;
    const manifestName = this.pickString(frontmatter, ['name']) ?? skillName;
    const displayName = this.pickString(frontmatter, ['displayName', 'display_name', 'title']);
    const description =
      this.pickString(frontmatter, ['description', 'summary', 'shortDescription']) ??
      `Skill instructions for ${skillName}`;
    const shortDescription = this.pickString(frontmatter, [
      'shortDescription',
      'short_description',
      'summary',
    ]);
    const license = this.pickString(frontmatter, ['license']);
    const compatibility = this.pickString(frontmatter, ['compatibility']);
    const resources = this.pickStringArray(frontmatter, ['resources', 'references']);
    const encodedSkillsRoot = this.skillsRootSegments.map(encodeURIComponent).join('/');

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
      sourceUrl: `https://github.com/${this.repoOwner}/${this.repoName}/tree/${encodeURIComponent(this.branch)}/${encodedSkillsRoot}/${encodeURIComponent(skillName)}`,
    };
  }
}
