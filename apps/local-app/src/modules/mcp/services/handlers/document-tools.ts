import type { Document } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import {
  McpResponse,
  ListDocumentsParamsSchema,
  GetDocumentParamsSchema,
  CreateDocumentParamsSchema,
  UpdateDocumentParamsSchema,
  ListDocumentsResponse,
  GetDocumentResponse,
  CreateDocumentResponse,
  UpdateDocumentResponse,
  SessionContext,
} from '../../dtos/mcp.dto';
import { mapDocumentSummary, mapDocumentDetail } from '../mappers/dto-mappers';
import { collectDocumentLinks, buildInlineResolution } from '../utils/document-link-resolver';
import type { McpToolContext } from './types';

const logger = createLogger('McpService');

function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

function missingSessionResolver(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Session resolution requires full app context (not available in standalone MCP mode)',
    },
  };
}

async function resolveSessionContext(ctx: McpToolContext, sessionId: string): Promise<McpResponse> {
  if (!ctx.resolveSessionContext) {
    return missingSessionResolver();
  }
  return ctx.resolveSessionContext(sessionId);
}

export async function handleListDocuments(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListDocumentsParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

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
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = GetDocumentParamsSchema.parse(params);
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
        validated.maxBytes ?? ctx.defaultInlineMaxBytes ?? 64 * 1024,
      );
      response.resolved = inline;
    }
  }

  return { success: true, data: response };
}

export async function handleCreateDocument(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = CreateDocumentParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

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
    document: mapDocumentDetail(document),
  };

  return { success: true, data: response };
}

export async function handleUpdateDocument(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = UpdateDocumentParamsSchema.parse(params);
  const document = await ctx.storage.updateDocument(validated.id, {
    title: validated.title,
    slug: validated.slug,
    contentMd: validated.contentMd,
    tags: validated.tags,
    archived: validated.archived,
    version: validated.version,
  });

  const response: UpdateDocumentResponse = {
    document: mapDocumentDetail(document),
  };

  return { success: true, data: response };
}
