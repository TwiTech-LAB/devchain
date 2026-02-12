import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { GitHubSkillSourceBase, ParsedSkillMarkdown } from './github-skill-source.base';
import { SkillManifest, SkillSourceAdapter, SkillSourceSyncContext } from './skill-source.adapter';

const logger = createLogger('TrailOfBitsSkillSource');
const PLUGINS_DIRECTORY = 'plugins';
const SKILLS_DIRECTORY = 'skills';

@Injectable()
export class TrailOfBitsSkillSource extends GitHubSkillSourceBase implements SkillSourceAdapter {
  constructor() {
    super({
      sourceName: 'trailofbits',
      repoOwner: 'trailofbits',
      repoName: 'skills',
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
            logger.warn({ sourceName: this.sourceName, skillName }, 'Missing SKILL.md. Skipping.');
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
            'Failed processing Trail of Bits skill. Skipping.',
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
    const pluginRoot = join(extractedRepoRoot, PLUGINS_DIRECTORY, skillName);
    const primaryPath = join(pluginRoot, SKILLS_DIRECTORY, skillName);
    if (await this.hasSkillMarkdown(primaryPath)) {
      return primaryPath;
    }

    if (await this.hasSkillMarkdown(pluginRoot)) {
      return pluginRoot;
    }

    const flatSkillsPath = join(pluginRoot, SKILLS_DIRECTORY);
    if (await this.hasSkillMarkdown(flatSkillsPath)) {
      return flatSkillsPath;
    }

    const nestedSkillDirectories = await this.listNestedSkillDirectories(flatSkillsPath);
    if (nestedSkillDirectories.length > 0) {
      return nestedSkillDirectories[0];
    }

    throw new StorageError('Trail of Bits skill directory not found in repository archive.', {
      sourceName: this.sourceName,
      skillName,
      pluginRoot,
    });
  }

  private async listSkillNamesFromExtractedRepo(extractedRepoRoot: string): Promise<string[]> {
    const pluginsRoot = join(extractedRepoRoot, PLUGINS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Trail of Bits plugins directory not found in repository archive.', {
          sourceName: this.sourceName,
          pluginsRoot,
        });
      }
      throw new StorageError('Failed reading Trail of Bits plugins directory in archive.', {
        sourceName: this.sourceName,
        pluginsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
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
      throw new StorageError('Failed checking Trail of Bits SKILL.md path in archive.', {
        sourceName: this.sourceName,
        skillDirectory,
        skillMarkdownPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async listNestedSkillDirectories(skillsRoot: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new StorageError('Failed reading nested Trail of Bits skill directories in archive.', {
        sourceName: this.sourceName,
        skillsRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const skillDirectories: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const candidate = join(skillsRoot, entry.name);
      if (await this.hasSkillMarkdown(candidate)) {
        skillDirectories.push(candidate);
      }
    }
    return skillDirectories.sort((left, right) => left.localeCompare(right));
  }

  private getSourcePathFromDirectory(
    extractedRepoRoot: string,
    skillDirectory: string,
    skillName: string,
  ): string {
    const repoRelativePath = relative(extractedRepoRoot, skillDirectory).split('\\').join('/');
    if (!repoRelativePath || repoRelativePath.startsWith('..')) {
      return `${PLUGINS_DIRECTORY}/${skillName}`;
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
