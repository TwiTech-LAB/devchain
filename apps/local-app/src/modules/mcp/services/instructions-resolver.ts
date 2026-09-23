import type { PromptStorage } from '../../storage/interfaces/storage.interface';
import type { Prompt } from '../../storage/models/domain.models';
import type { InstructionsResolved } from '../dtos/mcp.dto';
import { renderTemplate } from '../../../common/template/handlebars-renderer';
import { createLogger } from '../../../common/logging/logger';
import {
  INSTRUCTION_REFERENCE_PATTERN,
  PROMPT_REFERENCE_PREFIX,
  rankPromptCandidatesSystemFirst,
} from '../../../common/prompt-references';

const logger = createLogger('InstructionsResolver');

export interface InstructionsResolverOptions {
  maxBytes?: number;
  maxPrompts?: number;
  render?: {
    vars: Record<string, unknown>;
    legacyVariables?: string[];
  };
}

interface ResolveConfig {
  maxBytes: number;
  maxPrompts: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_PROMPTS = 10;

interface Reference {
  raw: string;
  value: string;
}

export class InstructionsResolver {
  constructor(private readonly storage: PromptStorage) {}

  async resolve(
    projectId: string,
    instructions: string | null | undefined,
    options: InstructionsResolverOptions = {},
  ): Promise<InstructionsResolved | null> {
    if (!instructions || !instructions.trim()) {
      return null;
    }

    const config: ResolveConfig = {
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxPrompts: options.maxPrompts ?? DEFAULT_MAX_PROMPTS,
    };

    const prompts = new Map<string, { id: string; title: string }>();
    let refContent = '';
    let truncated = false;

    if (instructions.includes('[[')) {
      const references = this.extractReferences(instructions);
      if (references.length > 0) {
        const result = await this.resolveReferences(projectId, references, config, prompts);
        refContent = result.content;
        truncated = result.truncated;
      }
    }

    let contentMd = refContent.trim() ? refContent : instructions;

    if (options.render) {
      contentMd = renderTemplate(contentMd, options.render.vars, options.render.legacyVariables);
    }

    let finalBytes = Buffer.byteLength(contentMd, 'utf8');
    if (finalBytes > config.maxBytes) {
      contentMd = InstructionsResolver.truncateUtf8(contentMd, config.maxBytes);
      finalBytes = Buffer.byteLength(contentMd, 'utf8');
      truncated = true;
    }

    return {
      contentMd,
      bytes: finalBytes,
      truncated,
      prompts: Array.from(prompts.values()),
    };
  }

  private async resolveReferences(
    projectId: string,
    references: Reference[],
    config: ResolveConfig,
    prompts: Map<string, { id: string; title: string }>,
  ): Promise<{ content: string; truncated: boolean }> {
    const processedTitles = new Set<string>();
    let content = '';
    let truncated = false;

    for (const reference of references) {
      if (prompts.size >= config.maxPrompts) {
        truncated = true;
        break;
      }

      const titleLower = reference.value.toLowerCase();
      if (processedTitles.has(titleLower)) {
        continue;
      }
      processedTitles.add(titleLower);

      const snippet = await this.expandPromptReference(projectId, reference.value, prompts);
      if (!snippet) {
        continue;
      }

      const appended = this.appendWithLimit(content, snippet, config.maxBytes);
      content = appended.content;
      truncated = truncated || appended.truncated;
      if (appended.truncated) {
        break;
      }
    }

    return { content, truncated };
  }

  private extractReferences(instructions: string): Reference[] {
    const matches = instructions.matchAll(INSTRUCTION_REFERENCE_PATTERN);
    const references: Reference[] = [];

    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw) {
        continue;
      }

      if (!raw.startsWith(PROMPT_REFERENCE_PREFIX)) {
        continue;
      }

      const title = raw.slice(PROMPT_REFERENCE_PREFIX.length).trim();
      if (title) {
        references.push({ raw, value: title });
      }
    }

    return references;
  }

  private async expandPromptReference(
    projectId: string,
    title: string,
    prompts: Map<string, { id: string; title: string }>,
  ): Promise<string | null> {
    const prompt = await this.loadPromptByTitle(projectId, title);
    if (!prompt) {
      logger.debug(`Prompt not found for title: ${title}`);
      return null;
    }

    if (prompts.has(prompt.id)) {
      return null;
    }

    prompts.set(prompt.id, {
      id: prompt.id,
      title: prompt.title,
    });

    return this.buildPromptSnippet(prompt.title, prompt.content);
  }

  private async loadPromptByTitle(projectId: string, title: string): Promise<Prompt | null> {
    const titleLower = title.toLowerCase();

    // Try project-scoped first
    const projectResults = await this.storage.listPrompts({
      projectId,
      q: title,
      limit: 10000,
      offset: 0,
    });

    const projectMatches = rankPromptCandidatesSystemFirst(
      projectResults.items.filter((p) => p.title.toLowerCase() === titleLower),
    );
    const projectMatch = projectMatches[0];

    if (projectMatch) {
      if (projectMatches.length > 1) {
        logger.warn(
          `Multiple prompts found with title "${title}" in project ${projectId}, using first match`,
        );
      }
      return this.storage.getPrompt(projectMatch.id);
    }

    // Fall back to global scope
    const globalResults = await this.storage.listPrompts({
      projectId: null,
      q: title,
      limit: 10000,
      offset: 0,
    });

    const globalMatches = rankPromptCandidatesSystemFirst(
      globalResults.items.filter((p) => p.title.toLowerCase() === titleLower),
    );
    const globalMatch = globalMatches[0];

    if (globalMatch) {
      if (globalMatches.length > 1) {
        logger.warn(
          `Multiple prompts found with title "${title}" in global scope, using first match`,
        );
      }
      return this.storage.getPrompt(globalMatch.id);
    }

    return null;
  }

  private buildPromptSnippet(title: string, content: string): string {
    const heading = `## Prompt: ${title}`;
    return `\n\n---\n${heading}\n\n${content}\n---\n`;
  }

  private appendWithLimit(
    existing: string,
    addition: string,
    maxBytes: number,
  ): { content: string; truncated: boolean } {
    if (!addition) {
      return { content: existing, truncated: false };
    }

    const combined = existing + addition;
    const bytes = Buffer.byteLength(combined, 'utf8');
    if (bytes <= maxBytes) {
      return { content: combined, truncated: false };
    }

    return { content: InstructionsResolver.truncateUtf8(combined, maxBytes), truncated: true };
  }

  // Iterates by code point (handles surrogate pairs) to avoid splitting multi-byte UTF-8 chars.
  private static truncateUtf8(input: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    let bytes = 0;
    let output = '';
    for (const ch of input) {
      const chBytes = Buffer.byteLength(ch, 'utf8');
      if (bytes + chBytes > maxBytes) break;
      bytes += chBytes;
      output += ch;
    }
    return output;
  }
}
