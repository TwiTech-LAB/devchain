import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { GitHubSkillSourceBase, ParsedSkillMarkdown } from './github-skill-source.base';
import { SkillManifest, SkillSourceAdapter, SkillSourceSyncContext } from './skill-source.adapter';

const logger = createLogger('VercelSkillSource');
const SKILLS_DIRECTORY = 'skills';

@Injectable()
export class VercelSkillSource extends GitHubSkillSourceBase implements SkillSourceAdapter {
  constructor() {
    super({
      sourceName: 'vercel',
      repoOwner: 'vercel-labs',
      repoName: 'agent-skills',
    });
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
          manifests.set(
            skillName,
            this.toSkillManifest(
              skillName,
              parsedSkill,
              this.getSourcePathFromDirectory(
                repoContext.extractedRepoRoot,
                skillDirectory,
                skillName,
              ),
            ),
          );
        } catch (error) {
          logger.warn(
            {
              sourceName: this.sourceName,
              skillName,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed processing Vercel skill. Skipping.',
          );
        }
      }

      return {
        manifests,
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
    try {
      return await super.resolveSkillDirectory(extractedRepoRoot, skillName);
    } catch (error) {
      const nestedSkillDirectory = await this.findNestedSkillDirectory(
        extractedRepoRoot,
        skillName,
      );
      if (nestedSkillDirectory) {
        return nestedSkillDirectory;
      }
      throw error;
    }
  }

  private async listSkillNamesFromExtractedRepo(extractedRepoRoot: string): Promise<string[]> {
    const skillsRoot = join(extractedRepoRoot, SKILLS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Vercel skills directory not found in repository archive.', {
          sourceName: this.sourceName,
          skillsRoot,
        });
      }
      throw new StorageError('Failed reading Vercel skills directory in archive.', {
        sourceName: this.sourceName,
        skillsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const skillNames = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const topLevelSkillDirectory = join(skillsRoot, entry.name);
      if (await this.hasSkillMarkdown(topLevelSkillDirectory)) {
        skillNames.add(entry.name);
        continue;
      }

      const nestedSkillNames = await this.listNestedSkillNames(topLevelSkillDirectory);
      for (const nestedSkillName of nestedSkillNames) {
        skillNames.add(nestedSkillName);
      }
    }

    return [...skillNames].sort((left, right) => left.localeCompare(right));
  }

  private async listNestedSkillNames(parentDirectory: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(parentDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new StorageError('Failed reading nested Vercel skill directories in archive.', {
        sourceName: this.sourceName,
        parentDirectory,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const skillNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const nestedSkillDirectory = join(parentDirectory, entry.name);
      if (await this.hasSkillMarkdown(nestedSkillDirectory)) {
        skillNames.push(entry.name);
      }
    }
    return skillNames;
  }

  private async hasSkillMarkdown(skillDirectory: string): Promise<boolean> {
    const skillMarkdownPath = join(skillDirectory, 'SKILL.md');
    try {
      const stats = await fs.stat(skillMarkdownPath);
      return stats.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw new StorageError('Failed checking Vercel SKILL.md path in archive.', {
        sourceName: this.sourceName,
        skillDirectory,
        skillMarkdownPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async findNestedSkillDirectory(
    extractedRepoRoot: string,
    skillName: string,
  ): Promise<string | null> {
    const skillsRoot = join(extractedRepoRoot, SKILLS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new StorageError('Failed reading Vercel skills root for nested lookup.', {
        sourceName: this.sourceName,
        skillsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const nestedSkillDirectory = join(skillsRoot, entry.name, skillName);
      try {
        const stats = await fs.stat(nestedSkillDirectory);
        if (stats.isDirectory() && (await this.hasSkillMarkdown(nestedSkillDirectory))) {
          return nestedSkillDirectory;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new StorageError('Failed checking nested Vercel skill directory in archive.', {
            sourceName: this.sourceName,
            skillName,
            nestedSkillDirectory,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return null;
  }

  private getSourcePathFromDirectory(
    extractedRepoRoot: string,
    skillDirectory: string,
    skillName: string,
  ): string {
    const repoRelativePath = relative(extractedRepoRoot, skillDirectory).split('\\').join('/');
    if (!repoRelativePath || repoRelativePath.startsWith('..')) {
      return `${SKILLS_DIRECTORY}/${skillName}`;
    }
    return repoRelativePath;
  }

  private encodePathSegments(pathValue: string): string {
    return pathValue
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private toSkillManifest(
    skillName: string,
    parsedSkill: ParsedSkillMarkdown,
    sourcePath: string,
  ): SkillManifest {
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
      sourceUrl: `${this.repoUrl}/tree/${encodeURIComponent(this.branch)}/${this.encodePathSegments(sourcePath)}`,
    };
  }
}
