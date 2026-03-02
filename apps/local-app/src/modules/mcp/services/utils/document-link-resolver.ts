import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { Document } from '../../../storage/models/domain.models';
import type { DocumentInlineResolution, DocumentLinkMeta } from '../../dtos/mcp.dto';

type DocumentStorage = Pick<StorageService, 'getDocument'>;

function extractLinkSlugs(content: string): string[] {
  const regex = /\[\[([A-Za-z0-9_\-./]+)\]\]/g;
  const seen = new Set<string>();
  const slugs: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const slug = match[1].trim();
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }

  return slugs;
}

function escapeForRegex(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

async function loadDocumentBySlug(
  storage: DocumentStorage,
  projectId: string | null,
  slug: string,
  cache: Map<string, Document | null>,
): Promise<Document | null> {
  if (cache.has(slug)) {
    return cache.get(slug) ?? null;
  }

  try {
    const linked = await storage.getDocument({ projectId, slug });
    cache.set(slug, linked);
    return linked;
  } catch (error) {
    cache.set(slug, null);
    return null;
  }
}

function applyByteLimit(
  content: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= maxBytes) {
    return { content, bytes, truncated: false };
  }

  const buffer = Buffer.from(content, 'utf8');
  const truncatedBuffer = buffer.subarray(0, maxBytes);
  return {
    content: truncatedBuffer.toString('utf8'),
    bytes: maxBytes,
    truncated: true,
  };
}

function buildInlineSnippet(document: Document, content: string, depth: number): string {
  const headingLevel = Math.min(6, 2 + depth);
  const heading = `${'#'.repeat(headingLevel)} ${document.title || document.slug}`;
  return `\n\n---\n${heading}\n\n${content}\n---\n\n`;
}

async function inlineDocumentContent(
  storage: DocumentStorage,
  content: string,
  projectId: string | null,
  depth: number,
  options: { maxDepth: number; maxBytes: number },
  cache: Map<string, Document | null>,
  path: Set<string>,
): Promise<{ content: string; depthUsed: number; bytes: number; truncated: boolean }> {
  if (options.maxDepth === 0 || depth >= options.maxDepth) {
    const bytes = Buffer.byteLength(content, 'utf8');
    return { content, depthUsed: depth, bytes, truncated: false };
  }

  let workingContent = content;
  let depthUsed = depth;
  const slugs = extractLinkSlugs(content);

  for (const slug of slugs) {
    if (depth >= options.maxDepth) {
      break;
    }
    if (path.has(slug)) {
      continue;
    }

    const linked = await loadDocumentBySlug(storage, projectId, slug, cache);
    if (!linked) {
      continue;
    }

    path.add(slug);
    const childResult = await inlineDocumentContent(
      storage,
      linked.contentMd,
      linked.projectId ?? projectId,
      depth + 1,
      options,
      cache,
      path,
    );
    path.delete(slug);

    depthUsed = Math.max(depthUsed, childResult.depthUsed);
    const snippet = buildInlineSnippet(linked, childResult.content, depth + 1);
    const pattern = new RegExp(`\\[\\[${escapeForRegex(slug)}\\]\\]`, 'g');
    workingContent = workingContent.replace(pattern, snippet);
  }

  const bytes = Buffer.byteLength(workingContent, 'utf8');
  return {
    content: workingContent,
    depthUsed: Math.max(depthUsed, depth),
    bytes,
    truncated: false,
  };
}

export async function collectDocumentLinks(
  storage: DocumentStorage,
  document: Document,
): Promise<{ links: DocumentLinkMeta[]; cache: Map<string, Document | null> }> {
  const cache = new Map<string, Document | null>();
  cache.set(document.slug, document);

  const slugs = extractLinkSlugs(document.contentMd);
  const projectId = document.projectId ?? null;
  const links: DocumentLinkMeta[] = [];

  for (const slug of slugs) {
    const linked = await loadDocumentBySlug(storage, projectId, slug, cache);
    if (linked) {
      links.push({
        slug,
        title: linked.title,
        id: linked.id,
        projectId: linked.projectId,
        exists: true,
      });
    } else {
      links.push({ slug, exists: false });
    }
  }

  return { links, cache };
}

export async function buildInlineResolution(
  storage: DocumentStorage,
  document: Document,
  cache: Map<string, Document | null>,
  maxDepth: number,
  maxBytes: number,
): Promise<DocumentInlineResolution> {
  const effectiveDepth = Math.max(0, maxDepth);
  const path = new Set<string>([document.slug]);
  const result = await inlineDocumentContent(
    storage,
    document.contentMd,
    document.projectId ?? null,
    0,
    { maxDepth: effectiveDepth, maxBytes },
    cache,
    path,
  );

  const limited = applyByteLimit(result.content, maxBytes);
  return {
    contentMd: limited.content,
    depthUsed: Math.min(result.depthUsed, effectiveDepth),
    bytes: limited.bytes,
    truncated: limited.truncated || result.truncated,
  };
}
