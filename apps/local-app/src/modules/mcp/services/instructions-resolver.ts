import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Document, Prompt } from '../../storage/models/domain.models';
import type { DocumentInlineResolution, InstructionsResolved } from '../dtos/mcp.dto';
import { renderTemplate } from '../../../common/template/handlebars-renderer';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('InstructionsResolver');

export interface InstructionsResolverOptions {
  maxDepth?: number;
  maxBytes?: number;
  maxDocuments?: number;
  render?: {
    vars: Record<string, unknown>;
    legacyVariables?: string[];
  };
}

interface ResolveConfig {
  maxDepth: number;
  maxBytes: number;
  maxDocuments: number;
}

type InlineResolver = (
  document: Document,
  cache: Map<string, Document | null>,
  maxDepth: number,
  maxBytes: number,
) => Promise<DocumentInlineResolution>;

const REFERENCE_PATTERN = /\[\[([^[\]]+)\]\]/g;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_DOCUMENTS = 10;

interface Reference {
  raw: string;
  value: string;
  type: 'slug' | 'tag' | 'prompt';
}

export class InstructionsResolver {
  constructor(
    private readonly storage: StorageService,
    private readonly inlineResolver: InlineResolver,
  ) {}

  async resolve(
    projectId: string,
    instructions: string | null | undefined,
    options: InstructionsResolverOptions = {},
  ): Promise<InstructionsResolved | null> {
    if (!instructions || !instructions.trim()) {
      return null;
    }

    const config: ResolveConfig = {
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxDocuments: options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS,
    };

    const docs = new Map<string, { id: string; slug: string; title: string }>();
    const prompts = new Map<string, { id: string; title: string }>();
    let refContent = '';
    let truncated = false;

    if (instructions.includes('[[')) {
      const references = this.extractReferences(instructions);
      if (references.length > 0) {
        const result = await this.resolveReferences(projectId, references, config, docs, prompts);
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
      docs: Array.from(docs.values()),
      prompts: Array.from(prompts.values()),
    };
  }

  private async resolveReferences(
    projectId: string,
    references: Reference[],
    config: ResolveConfig,
    docs: Map<string, { id: string; slug: string; title: string }>,
    prompts: Map<string, { id: string; title: string }>,
  ): Promise<{ content: string; truncated: boolean }> {
    const processedSlugs = new Set<string>();
    const processedKeys = new Set<string>();
    const processedPromptTitles = new Set<string>();
    let content = '';
    let truncated = false;

    const totalResolvedCount = () => docs.size + prompts.size;

    for (const reference of references) {
      if (totalResolvedCount() >= config.maxDocuments) {
        truncated = true;
        break;
      }

      if (reference.type === 'slug') {
        if (processedSlugs.has(reference.value)) {
          continue;
        }
        processedSlugs.add(reference.value);

        const expansion = await this.expandSlugReference(
          projectId,
          reference.value,
          config,
          new Map(),
          docs,
        );
        if (!expansion) {
          continue;
        }

        const { snippet, truncated: snippetTruncated } = expansion;
        if (!snippet) {
          continue;
        }

        const appended = this.appendWithLimit(content, snippet, config.maxBytes);
        content = appended.content;
        truncated = truncated || appended.truncated || snippetTruncated;
        if (appended.truncated) {
          break;
        }
      } else if (reference.type === 'prompt') {
        const titleLower = reference.value.toLowerCase();
        if (processedPromptTitles.has(titleLower)) {
          continue;
        }
        processedPromptTitles.add(titleLower);

        const expansion = await this.expandPromptReference(projectId, reference.value, prompts);
        if (!expansion) {
          continue;
        }

        const { snippet } = expansion;
        if (!snippet) {
          continue;
        }

        const appended = this.appendWithLimit(content, snippet, config.maxBytes);
        content = appended.content;
        truncated = truncated || appended.truncated;
        if (appended.truncated) {
          break;
        }
      } else {
        if (processedKeys.has(reference.value)) {
          continue;
        }
        processedKeys.add(reference.value);

        const { snippets, truncated: keyTruncated } = await this.expandTagReference(
          projectId,
          reference.value,
          config,
          new Map(),
          docs,
        );

        for (const snippet of snippets) {
          if (totalResolvedCount() >= config.maxDocuments) {
            truncated = true;
            break;
          }

          const appended = this.appendWithLimit(content, snippet, config.maxBytes);
          content = appended.content;
          truncated = truncated || appended.truncated;
          if (appended.truncated) {
            break;
          }
        }

        truncated = truncated || keyTruncated;
        if (truncated) {
          break;
        }
      }
    }

    return { content, truncated };
  }

  private extractReferences(instructions: string): Reference[] {
    const matches = instructions.matchAll(REFERENCE_PATTERN);
    const references: Reference[] = [];

    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw) {
        continue;
      }

      if (raw.startsWith('#')) {
        const key = raw.slice(1).trim();
        if (key) {
          references.push({ raw, value: key, type: 'tag' });
        }
      } else if (raw.startsWith('prompt:')) {
        const title = raw.slice('prompt:'.length).trim();
        if (title) {
          references.push({ raw, value: title, type: 'prompt' });
        }
      } else {
        references.push({ raw, value: raw, type: 'slug' });
      }
    }

    return references;
  }

  private async expandSlugReference(
    projectId: string,
    slug: string,
    config: ResolveConfig,
    cache: Map<string, Document | null>,
    docs: Map<string, { id: string; slug: string; title: string }>,
  ): Promise<{ snippet: string | null; truncated: boolean } | null> {
    const document = await this.loadDocument(projectId, slug, cache);
    if (!document) {
      return null;
    }

    if (docs.has(document.id)) {
      return { snippet: null, truncated: false };
    }

    const inline = await this.inlineResolver(document, cache, config.maxDepth, config.maxBytes);
    docs.set(document.id, {
      id: document.id,
      slug: document.slug,
      title: document.title ?? document.slug,
    });

    const snippet = this.buildSnippet(document, inline.contentMd);

    return {
      snippet,
      truncated: inline.truncated,
    };
  }

  private async expandTagReference(
    projectId: string,
    key: string,
    config: ResolveConfig,
    cache: Map<string, Document | null>,
    docs: Map<string, { id: string; slug: string; title: string }>,
  ): Promise<{ snippets: string[]; truncated: boolean }> {
    const results = await this.storage.listDocuments({
      projectId,
      tagKeys: [key],
      limit: config.maxDocuments,
      offset: 0,
    });

    const snippets: string[] = [];
    let truncated = false;

    for (const document of results.items) {
      if (docs.size >= config.maxDocuments) {
        truncated = true;
        break;
      }
      if (docs.has(document.id)) {
        continue;
      }

      const inline = await this.inlineResolver(document, cache, config.maxDepth, config.maxBytes);
      docs.set(document.id, {
        id: document.id,
        slug: document.slug,
        title: document.title ?? document.slug,
      });
      snippets.push(this.buildSnippet(document, inline.contentMd));
      truncated = truncated || inline.truncated;
    }

    return { snippets, truncated };
  }

  private async expandPromptReference(
    projectId: string,
    title: string,
    prompts: Map<string, { id: string; title: string }>,
  ): Promise<{ snippet: string | null } | null> {
    const prompt = await this.loadPromptByTitle(projectId, title);
    if (!prompt) {
      logger.debug(`Prompt not found for title: ${title}`);
      return null;
    }

    if (prompts.has(prompt.id)) {
      return { snippet: null };
    }

    prompts.set(prompt.id, {
      id: prompt.id,
      title: prompt.title,
    });

    const snippet = this.buildPromptSnippet(prompt.title, prompt.content);
    return { snippet };
  }

  private async loadPromptByTitle(projectId: string, title: string): Promise<Prompt | null> {
    const titleLower = title.toLowerCase();

    // Try project-scoped first
    const projectResults = await this.storage.listPrompts({
      projectId,
      q: title,
      limit: 10,
    });

    const projectMatch = projectResults.items.find((p) => p.title.toLowerCase() === titleLower);

    if (projectMatch) {
      if (projectResults.items.filter((p) => p.title.toLowerCase() === titleLower).length > 1) {
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
      limit: 10,
    });

    const globalMatch = globalResults.items.find((p) => p.title.toLowerCase() === titleLower);

    if (globalMatch) {
      if (globalResults.items.filter((p) => p.title.toLowerCase() === titleLower).length > 1) {
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

  private buildSnippet(document: Document, content: string): string {
    const heading = `## ${document.title || document.slug}`;
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

  private async loadDocument(
    projectId: string,
    slug: string,
    cache: Map<string, Document | null>,
  ): Promise<Document | null> {
    if (cache.has(slug)) {
      return cache.get(slug) ?? null;
    }

    try {
      const document = await this.storage.getDocument({ projectId, slug });
      cache.set(slug, document);
      return document;
    } catch (error) {
      // Attempt fallback to global document scope
      try {
        const document = await this.storage.getDocument({ projectId: null, slug });
        cache.set(slug, document);
        return document;
      } catch {
        cache.set(slug, null);
        return null;
      }
    }
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
