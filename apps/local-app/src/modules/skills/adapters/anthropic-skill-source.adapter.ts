import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { GitHubSkillSourceBase, ParsedSkillMarkdown } from './github-skill-source.base';
import { SkillManifest, SkillSourceSyncContext } from './skill-source.adapter';

const logger = createLogger('AnthropicSkillSource');
const SKILLS_DIRECTORY = 'skills';

@Injectable()
export class AnthropicSkillSource extends GitHubSkillSourceBase {
  constructor() {
    super({
      sourceName: 'anthropic',
      repoOwner: 'anthropics',
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
            'Failed processing Anthropic skill. Skipping.',
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

  private async listSkillNamesFromExtractedRepo(extractedRepoRoot: string): Promise<string[]> {
    const skillsRoot = join(extractedRepoRoot, SKILLS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Anthropic skills directory not found in repository archive.', {
          sourceName: this.sourceName,
          skillsRoot,
        });
      }
      throw new StorageError('Failed reading Anthropic skills directory in archive.', {
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
      sourceUrl: `${this.repoUrl}/tree/${encodeURIComponent(this.branch)}/${SKILLS_DIRECTORY}/${encodeURIComponent(skillName)}`,
    };
  }
}
