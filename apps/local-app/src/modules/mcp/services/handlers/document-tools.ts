import type { Document } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import {
  McpResponse,
  ListDocumentsResponse,
  GetDocumentResponse,
  CreateDocumentResponse,
  UpdateDocumentResponse,
  type ListDocumentsParams,
  type GetDocumentParams,
  type CreateDocumentParams,
  type UpdateDocumentParams,
} from '../../dtos/mcp.dto';
import { mapDocumentSummary, mapDocumentDetail } from '../mappers/dto-mappers';
import { collectDocumentLinks, buildInlineResolution } from '../utils/document-link-resolver';
import type { DocumentToolContext } from './document-context';
import { resolveSessionContext } from '../utils/session-context-helpers';
import { redactSessionId } from '../utils/redact';
import { requireProject } from '../utils/require-project';

const logger = createLogger('McpService');

export async function handleListDocuments(
  ctx: DocumentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListDocumentsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  logger.debug(
    { sessionId: redactSessionId(validated.sessionId), projectId: project.id },
    'Resolved session to project',
  );

  const filters: {
    projectId: string;
    tags?: string[];
    q?: string;
    limit?: number;
    offset?: number;
  } = {
    projectId: project.id,
  };

  if (validated.tags?.length) {
    filters.tags = validated.tags;
  }
  if (validated.q) {
    filters.q = validated.q;
  }
  if (validated.limit !== undefined) {
    filters.limit = validated.limit;
  }
  if (validated.offset !== undefined) {
    filters.offset = validated.offset;
  }

  const result = await ctx.storage.listDocuments(filters);
  const response: ListDocumentsResponse = {
    documents: result.items.map((document) => mapDocumentSummary(document)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };

  return { success: true, data: response };
}

export async function handleGetDocument(
  ctx: DocumentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetDocumentParams;
  const includeLinks = validated.includeLinks ?? 'meta';

  let document: Document;
  if (validated.id) {
    document = await ctx.storage.getDocument({ id: validated.id });
  } else {
    const projectId = validated.projectId === '' ? null : validated.projectId!;
    document = await ctx.storage.getDocument({ slug: validated.slug!, projectId });
  }

  const response: GetDocumentResponse = {
    document: mapDocumentDetail(document),
    links: [],
  };

  let cache = new Map<string, Document | null>();
  if (includeLinks !== 'none') {
    const collected = await collectDocumentLinks(ctx.storage, document);
    response.links = collected.links;
    cache = collected.cache;

    if (includeLinks === 'inline') {
      const inline = await buildInlineResolution(
        ctx.storage,
        document,
        cache,
        validated.maxDepth ?? 1,
        validated.maxBytes ?? ctx.defaultInlineMaxBytes,
      );
      response.resolved = inline;
    }
  }

  return { success: true, data: response };
}

export async function handleCreateDocument(
  ctx: DocumentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as CreateDocumentParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  logger.debug(
    { sessionId: redactSessionId(validated.sessionId), projectId: project.id },
    'Resolved session to project for document creation',
  );

  const document = await ctx.storage.createDocument({
    projectId: project.id,
    title: validated.title,
    contentMd: validated.contentMd,
    tags: validated.tags,
  });

  const response: CreateDocumentResponse = {
    id: document.id,
    version: document.version,
  };

  return { success: true, data: response };
}

export async function handleUpdateDocument(
  ctx: DocumentToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as UpdateDocumentParams;
  const document = await ctx.storage.updateDocument(validated.id, {
    title: validated.title,
    slug: validated.slug,
    contentMd: validated.contentMd,
    tags: validated.tags,
    archived: validated.archived,
    version: validated.version,
  });

  const response: UpdateDocumentResponse = {
    id: document.id,
    version: document.version,
  };

  return { success: true, data: response };
}
