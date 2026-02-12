import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import { GitHubSkillSourceBase, type ParsedSkillMarkdown } from './github-skill-source.base';
import type {
  SkillManifest,
  SkillSourceAdapter,
  SkillSourceSyncContext,
} from './skill-source.adapter';

const logger = createLogger('CommunitySkillSourceAdapter');
const SKILLS_DIRECTORY = 'skills';

export class CommunitySkillSourceAdapter
  extends GitHubSkillSourceBase
  implements SkillSourceAdapter
{
  constructor(source: CommunitySkillSource) {
    super({
      sourceName: source.name,
      repoOwner: source.repoOwner,
      repoName: source.repoName,
      branch: source.branch,
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
            'Failed processing community skill. Skipping.',
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
        throw new StorageError('Community skills directory not found in repository archive.', {
          sourceName: this.sourceName,
          skillsRoot,
        });
      }
      throw new StorageError('Failed reading community skills directory in archive.', {
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

  protected async resolveSkillDirectory(
    extractedRepoRoot: string,
    skillName: string,
  ): Promise<string> {
    const strictSkillsPath = join(extractedRepoRoot, SKILLS_DIRECTORY, skillName);
    try {
      const stats = await fs.stat(strictSkillsPath);
      if (stats.isDirectory()) {
        return strictSkillsPath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('Failed checking extracted community skill directory.', {
          sourceName: this.sourceName,
          skillName,
          candidate: strictSkillsPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw new StorageError('Skill directory was not found in extracted repository tarball.', {
      sourceName: this.sourceName,
      skillName,
      extractedRepoRoot,
      candidate: strictSkillsPath,
    });
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
