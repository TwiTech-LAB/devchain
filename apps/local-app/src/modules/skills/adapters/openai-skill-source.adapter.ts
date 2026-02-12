import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { GitHubSkillSourceBase, ParsedSkillMarkdown } from './github-skill-source.base';
import { SkillManifest, SkillSourceSyncContext } from './skill-source.adapter';

const logger = createLogger('OpenAISkillSource');
const SKILLS_DIRECTORY = 'skills/.curated';

interface OpenAIAgentMetadata {
  displayName?: string;
  shortDescription?: string;
}

@Injectable()
export class OpenAISkillSource extends GitHubSkillSourceBase {
  constructor() {
    super({
      sourceName: 'openai',
      repoOwner: 'openai',
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

  protected override async resolveSkillDirectory(
    extractedRepoRoot: string,
    skillName: string,
  ): Promise<string> {
    const curatedSkillPath = join(extractedRepoRoot, 'skills', '.curated', skillName);
    try {
      const stats = await fs.stat(curatedSkillPath);
      if (stats.isDirectory()) {
        return curatedSkillPath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('Failed checking extracted OpenAI curated skill directory.', {
          sourceName: this.sourceName,
          skillName,
          curatedSkillPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return super.resolveSkillDirectory(extractedRepoRoot, skillName);
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
          const agentMetadata = await this.parseOpenAIAgentMetadata(skillDirectory);
          manifests.set(skillName, this.toSkillManifest(skillName, parsedSkill, agentMetadata));
        } catch (error) {
          logger.warn(
            {
              sourceName: this.sourceName,
              skillName,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed processing OpenAI skill. Skipping.',
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
    const curatedRoot = join(extractedRepoRoot, SKILLS_DIRECTORY);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(curatedRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('OpenAI curated skills directory not found in repository archive.', {
          sourceName: this.sourceName,
          curatedRoot,
        });
      }
      throw new StorageError('Failed reading OpenAI curated skills directory in archive.', {
        sourceName: this.sourceName,
        curatedRoot,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async parseOpenAIAgentMetadata(skillDirectory: string): Promise<OpenAIAgentMetadata> {
    const agentYamlPath = join(skillDirectory, 'agents', 'openai.yaml');

    let yamlContent: string;
    try {
      yamlContent = await fs.readFile(agentYamlPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw new StorageError('Failed reading OpenAI agent metadata file.', {
        sourceName: this.sourceName,
        agentYamlPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return this.extractOpenAIInterfaceFields(yamlContent);
  }

  private extractOpenAIInterfaceFields(yamlContent: string): OpenAIAgentMetadata {
    const lines = yamlContent.split(/\r?\n/);
    let insideInterface = false;
    let interfaceIndent = 0;
    let displayName: string | undefined;
    let shortDescription: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!insideInterface) {
        if (trimmed === 'interface:') {
          insideInterface = true;
          interfaceIndent = line.search(/\S|$/);
        }
        continue;
      }

      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }

      const currentIndent = line.search(/\S|$/);
      if (currentIndent <= interfaceIndent) {
        break;
      }

      const displayMatch = line.match(/^\s*display_name:\s*(.+)\s*$/);
      if (displayMatch) {
        displayName = this.normalizeYamlScalar(displayMatch[1]);
        continue;
      }

      const shortDescriptionMatch = line.match(/^\s*short_description:\s*(.+)\s*$/);
      if (shortDescriptionMatch) {
        shortDescription = this.normalizeYamlScalar(shortDescriptionMatch[1]);
      }
    }

    return { displayName, shortDescription };
  }

  private normalizeYamlScalar(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      const unwrapped = trimmed.slice(1, -1).trim();
      return unwrapped.length > 0 ? unwrapped : undefined;
    }
    return trimmed;
  }

  private toSkillManifest(
    skillName: string,
    parsedSkill: ParsedSkillMarkdown,
    agentMetadata: OpenAIAgentMetadata,
  ): SkillManifest {
    const frontmatter = parsedSkill.frontmatter;
    const manifestName = this.pickString(frontmatter, ['name']) ?? skillName;
    const displayName =
      agentMetadata.displayName ??
      this.pickString(frontmatter, ['displayName', 'display_name', 'title']);
    const shortDescription =
      agentMetadata.shortDescription ??
      this.pickString(frontmatter, ['shortDescription', 'short_description', 'summary']);
    const description =
      this.pickString(frontmatter, ['description']) ??
      shortDescription ??
      `Skill instructions for ${skillName}`;
    const license = this.pickString(frontmatter, ['license']);
    const compatibility = this.pickString(frontmatter, ['compatibility']);
    const resources = this.pickStringArray(frontmatter, ['resources', 'references']);
    const mergedFrontmatter: Record<string, unknown> = {
      ...frontmatter,
      openaiAgent: {
        display_name: agentMetadata.displayName,
        short_description: agentMetadata.shortDescription,
      },
    };

    return {
      name: manifestName,
      displayName,
      description,
      shortDescription,
      license,
      compatibility,
      frontmatter: mergedFrontmatter,
      instructionContent: parsedSkill.instructionContent,
      resources,
      sourceUrl: `${this.repoUrl}/tree/${encodeURIComponent(this.branch)}/${SKILLS_DIRECTORY}/${encodeURIComponent(skillName)}`,
    };
  }
}
