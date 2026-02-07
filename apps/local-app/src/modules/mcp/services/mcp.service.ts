import { Injectable, Inject, forwardRef, NotFoundException } from '@nestjs/common';
import {
  StorageService,
  STORAGE_SERVICE,
  PromptSummary as StoragePromptSummary,
} from '../../storage/interfaces/storage.interface';
import { ChatService } from '../../chat/services/chat.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EpicsService, EpicOperationContext } from '../../epics/services/epics.service';
import { SettingsService } from '../../settings/services/settings.service';
import { GuestsService } from '../../guests/services/guests.service';
import { ReviewsService } from '../../reviews/services/reviews.service';
import { Document, Prompt, Status, Epic, EpicComment } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { ListSessionsParamsSchema } from '../dtos/schema-registry';
import {
  McpResponse,
  CreateRecordResponse,
  UpdateRecordResponse,
  GetRecordResponse,
  ListRecordsResponse,
  AddTagsResponse,
  RemoveTagsResponse,
  CreateRecordParamsSchema,
  UpdateRecordParamsSchema,
  GetRecordParamsSchema,
  ListRecordsParamsSchema,
  AddTagsParamsSchema,
  RemoveTagsParamsSchema,
  ListDocumentsParamsSchema,
  GetDocumentParamsSchema,
  CreateDocumentParamsSchema,
  UpdateDocumentParamsSchema,
  ListPromptsParamsSchema,
  GetPromptParamsSchema,
  ListDocumentsResponse,
  GetDocumentResponse,
  CreateDocumentResponse,
  UpdateDocumentResponse,
  DocumentDetail,
  DocumentSummary,
  DocumentLinkMeta,
  DocumentInlineResolution,
  ListPromptsResponse,
  GetPromptResponse,
  PromptSummary,
  PromptDetail,
  ListAgentsParamsSchema,
  GetAgentByNameParamsSchema,
  ListAgentsResponse,
  GetAgentByNameResponse,
  AgentSummary,
  ListStatusesParamsSchema,
  ListStatusesResponse,
  StatusSummary,
  ListEpicsParamsSchema,
  ListEpicsResponse,
  ListAssignedEpicsTasksParamsSchema,
  ListAssignedEpicsTasksResponse,
  CreateEpicParamsSchema,
  CreateEpicResponse,
  GetEpicByIdParamsSchema,
  GetEpicByIdResponse,
  AddEpicCommentParamsSchema,
  AddEpicCommentResponse,
  UpdateEpicParamsSchema,
  UpdateEpicResponse,
  EpicSummary,
  EpicCommentSummary,
  EpicChildSummary,
  EpicParentSummary,
  SendMessageParamsSchema,
  SendMessageResponse,
  ChatAckParamsSchema,
  ChatAckResponse,
  ChatReadHistoryParamsSchema,
  ChatListMembersParamsSchema,
  ChatListMembersResponse,
  ActivityStartParamsSchema,
  ActivityFinishParamsSchema,
  ListSessionsResponse,
  SessionSummary,
  SessionContext,
  AgentSessionContext,
  GuestSessionContext,
  RegisterGuestParamsSchema,
  RegisterGuestResponse,
  // Review tools
  ListReviewsParamsSchema,
  ListReviewsResponse,
  ReviewSummary,
  GetReviewParamsSchema,
  GetReviewResponse,
  ReviewCommentSummary,
  ChangedFileSummary,
  GetReviewCommentsParamsSchema,
  GetReviewCommentsResponse,
  ReplyCommentParamsSchema,
  ReplyCommentResponse,
  ResolveCommentParamsSchema,
  ResolveCommentResponse,
  ApplySuggestionParamsSchema,
  ApplySuggestionResponse,
} from '../dtos/mcp.dto';
import { InstructionsResolver } from './instructions-resolver';
import type { FeatureFlagConfig } from '../../../common/config/feature-flags';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import {
  validatePathWithinRoot,
  validateResolvedPathWithinRoot,
  validateLineBounds,
} from '../../../common/validation/path-validation';
import { BadRequestException } from '@nestjs/common';
import { ZodError, ZodIssue } from 'zod';

import { suggestNestedPath } from '../utils/param-suggestion';

const logger = createLogger('McpService');

/** Helper to extract actor info from session context */
function getActorFromContext(
  ctx: SessionContext,
): { id: string; name: string; projectId: string } | null {
  if (ctx.type === 'agent') {
    return ctx.agent;
  } else if (ctx.type === 'guest') {
    return {
      id: ctx.guest.id,
      name: ctx.guest.name,
      projectId: ctx.guest.projectId,
    };
  }
  return null;
}

/** Resolved recipient info for messaging */
interface ResolvedRecipient {
  type: 'agent' | 'guest';
  id: string;
  name: string;
  /** For guests, their tmux session ID for direct delivery */
  tmuxSessionId?: string;
}

/** Redact sessionId for logging - show only first 4 chars */
function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

/** Redact sensitive fields from params object for logging */
function redactParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const obj = params as Record<string, unknown>;
  if ('sessionId' in obj && typeof obj.sessionId === 'string') {
    return { ...obj, sessionId: redactSessionId(obj.sessionId) };
  }
  return params;
}

/**
 * MCP Service
 * Handles MCP tool calls for records operations
 */
@Injectable()
export class McpService {
  private readonly instructionsResolver: InstructionsResolver;
  private readonly featureFlags: FeatureFlagConfig;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => ChatService)) private readonly chatService?: ChatService,
    @Inject(forwardRef(() => SessionsService)) private readonly sessionsService?: SessionsService,
    @Inject(forwardRef(() => SessionsMessagePoolService))
    private readonly messagePoolService?: SessionsMessagePoolService,
    @Inject(forwardRef(() => TerminalGateway)) private readonly terminalGateway?: TerminalGateway,
    @Inject(forwardRef(() => TmuxService)) private readonly tmuxService?: TmuxService,
    @Inject(forwardRef(() => EpicsService)) private readonly epicsService?: EpicsService,
    @Inject(forwardRef(() => SettingsService)) private readonly settingsService?: SettingsService,
    @Inject(forwardRef(() => GuestsService)) private readonly guestsService?: GuestsService,
    @Inject(forwardRef(() => ReviewsService)) private readonly reviewsService?: ReviewsService,
  ) {
    logger.info('McpService initialized');
    this.featureFlags = this.storage.getFeatureFlags();
    this.instructionsResolver = new InstructionsResolver(
      this.storage,
      (document, cache, maxDepth, maxBytes) =>
        this.buildInlineResolution(document, cache, maxDepth, maxBytes),
      this.featureFlags,
    );
  }

  private readonly DEFAULT_INLINE_MAX_BYTES = 64 * 1024;
  private async resolveAgentByNameUnique(
    projectId: string,
    name: string,
  ): Promise<{ id: string; name: string } | McpResponse> {
    const normalized = name.trim().toLowerCase();
    const list = await this.storage.listAgents(projectId, { limit: 1000, offset: 0 });
    const matches = list.items.filter((a) => a.name.toLowerCase() === normalized);
    if (matches.length === 0) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${name}" not found in project`,
          data: { availableNames: list.items.map((a) => a.name) },
        },
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: {
          code: 'AMBIGUOUS_AGENT_NAME',
          message: `Multiple agents named "${name}" found in project; please disambiguate`,
          data: { matches: matches.map((a) => ({ id: a.id, name: a.name })) },
        },
      };
    }
    return { id: matches[0].id, name: matches[0].name };
  }

  /**
   * Route tool call to appropriate handler
   */
  async handleToolCall(tool: string, params: unknown): Promise<McpResponse> {
    // Normalize nullish params to {} for consistent behavior across all entrypoints
    const normalizedParams = params ?? {};
    // Normalize common separators used by various MCP clients
    // Defined outside try block so it's accessible in catch for suggestion generation
    const normalizedTool = tool.replace(/[.\-/]/g, '_');

    try {
      logger.info(
        { tool: normalizedTool, originalTool: tool, params: redactParams(normalizedParams) },
        'Handling MCP tool call',
      );

      switch (normalizedTool) {
        case 'devchain_create_record':
          return await this.createRecord(normalizedParams);
        case 'devchain_update_record':
          return await this.updateRecord(normalizedParams);
        case 'devchain_get_record':
          return await this.getRecord(normalizedParams);
        case 'devchain_list_records':
          return await this.listRecords(normalizedParams);
        case 'devchain_add_tags':
          return await this.addTags(normalizedParams);
        case 'devchain_remove_tags':
          return await this.removeTags(normalizedParams);
        case 'devchain_list_documents':
          return await this.listDocuments(normalizedParams);
        case 'devchain_get_document':
          return await this.getDocument(normalizedParams);
        case 'devchain_create_document':
          return await this.createDocument(normalizedParams);
        case 'devchain_update_document':
          return await this.updateDocument(normalizedParams);
        case 'devchain_list_prompts':
          return await this.listPrompts(normalizedParams);
        case 'devchain_get_prompt':
          return await this.getPrompt(normalizedParams);
        case 'devchain_list_agents':
          return await this.listAgents(normalizedParams);
        case 'devchain_get_agent_by_name':
          return await this.getAgentByName(normalizedParams);
        case 'devchain_list_statuses':
          return await this.listStatuses(normalizedParams);
        case 'devchain_list_epics':
          return await this.listEpics(normalizedParams);
        case 'devchain_list_assigned_epics_tasks':
          return await this.listAssignedEpicsTasks(normalizedParams);
        case 'devchain_create_epic':
          return await this.createEpic(normalizedParams);
        case 'devchain_get_epic_by_id':
          return await this.getEpicById(normalizedParams);
        case 'devchain_add_epic_comment':
          return await this.addEpicComment(normalizedParams);
        case 'devchain_update_epic':
          return await this.updateEpic(normalizedParams);
        case 'notifications_initialized':
          // Some MCP clients send a readiness notification; acknowledge without warning
          return { success: true, data: { acknowledged: true } };
        case 'devchain_send_message':
          return await this.sendMessage(normalizedParams);
        case 'devchain_chat_ack':
          return await this.chatAck(normalizedParams);
        case 'devchain_chat_list_members':
          return await this.chatListMembers(normalizedParams);
        case 'devchain_chat_read_history':
          return await this.chatReadHistory(normalizedParams);
        case 'devchain_activity_start':
          return await this.activityStart(normalizedParams);
        case 'devchain_activity_finish':
          return await this.activityFinish(normalizedParams);
        case 'devchain_list_sessions':
          ListSessionsParamsSchema.parse(normalizedParams);
          return await this.listSessions();
        case 'devchain_register_guest':
          return await this.registerGuest(normalizedParams);
        // Review tools
        case 'devchain_list_reviews':
          return await this.listReviews(normalizedParams);
        case 'devchain_get_review':
          return await this.getReview(normalizedParams);
        case 'devchain_get_review_comments':
          return await this.getReviewComments(normalizedParams);
        case 'devchain_reply_comment':
          return await this.replyComment(normalizedParams);
        case 'devchain_resolve_comment':
          return await this.resolveComment(normalizedParams);
        case 'devchain_apply_suggestion':
          return await this.applySuggestion(normalizedParams);
        default:
          logger.warn({ tool: normalizedTool }, 'Unknown MCP tool');
          return {
            success: false,
            error: {
              code: 'UNKNOWN_TOOL',
              message: `Unknown tool: ${tool}`,
            },
          };
      }
    } catch (error) {
      logger.error({ tool, error }, 'MCP tool call failed');
      if (error instanceof ZodError) {
        // Generate helpful suggestions for unrecognized keys (from strict mode)
        const suggestions: string[] = [];
        for (const issue of error.issues) {
          if (issue.code === 'unrecognized_keys') {
            // ZodIssue for unrecognized_keys has a 'keys' property with the unknown key names
            const unknownKeys = (issue as ZodIssue & { keys: string[] }).keys;
            for (const key of unknownKeys) {
              const suggestion = suggestNestedPath(key, normalizedTool);
              if (suggestion) {
                suggestions.push(suggestion);
              }
            }
          }
        }

        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid parameters supplied to MCP tool.',
            data: {
              issues: error.issues,
              ...(suggestions.length > 0 && { suggestions }),
            },
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Route resource request to appropriate handler
   */
  async handleResourceRequest(uri: string): Promise<McpResponse> {
    try {
      logger.info({ uri }, 'Handling MCP resource request');

      if (uri.startsWith('doc://')) {
        return await this.resolveDocumentResource(uri);
      }

      if (uri.startsWith('prompt://')) {
        return await this.resolvePromptResource(uri);
      }

      return {
        success: false,
        error: {
          code: 'UNKNOWN_RESOURCE',
          message: `Unknown resource: ${uri}`,
        },
      };
    } catch (error) {
      logger.error({ uri, error }, 'MCP resource handler failed');
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * devchain.create_record
   */
  private async createRecord(params: unknown): Promise<McpResponse> {
    const validated = CreateRecordParamsSchema.parse(params);
    const record = await this.storage.createRecord({
      epicId: validated.epicId,
      type: validated.type,
      data: validated.data,
      tags: validated.tags || [],
    });

    const response: CreateRecordResponse = {
      id: record.id,
      epicId: record.epicId,
      type: record.type,
      data: record.data,
      tags: record.tags,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.update_record
   */
  private async updateRecord(params: unknown): Promise<McpResponse> {
    const validated = UpdateRecordParamsSchema.parse(params);
    const record = await this.storage.updateRecord(
      validated.id,
      {
        data: validated.data,
        type: validated.type,
        tags: validated.tags,
      },
      validated.version,
    );

    const response: UpdateRecordResponse = {
      id: record.id,
      epicId: record.epicId,
      type: record.type,
      data: record.data,
      tags: record.tags,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.get_record
   */
  private async getRecord(params: unknown): Promise<McpResponse> {
    const validated = GetRecordParamsSchema.parse(params);
    const record = await this.storage.getRecord(validated.id);

    const response: GetRecordResponse = {
      id: record.id,
      epicId: record.epicId,
      type: record.type,
      data: record.data,
      tags: record.tags,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.list_records
   */
  private async listRecords(params: unknown): Promise<McpResponse> {
    const validated = ListRecordsParamsSchema.parse(params);
    const result = await this.storage.listRecords(validated.epicId, {
      limit: validated.limit,
      offset: validated.offset,
    });

    // Filter by type if provided
    let filtered = result.items;
    if (validated.type) {
      filtered = filtered.filter((r) => r.type === validated.type);
    }

    // Filter by tags if provided
    if (validated.tags && validated.tags.length > 0) {
      filtered = filtered.filter((r) => {
        return validated.tags!.every((tag) => r.tags.includes(tag));
      });
    }

    const response: ListRecordsResponse = {
      records: filtered.map((r) => ({
        id: r.id,
        epicId: r.epicId,
        type: r.type,
        data: r.data,
        tags: r.tags,
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total: filtered.length,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.add_tags
   */
  private async addTags(params: unknown): Promise<McpResponse> {
    const validated = AddTagsParamsSchema.parse(params);
    const record = await this.storage.getRecord(validated.id);

    // Merge tags (avoid duplicates)
    const newTags = Array.from(new Set([...record.tags, ...validated.tags]));

    const updated = await this.storage.updateRecord(
      validated.id,
      { tags: newTags },
      record.version,
    );

    const response: AddTagsResponse = {
      id: updated.id,
      tags: updated.tags,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.remove_tags
   */
  private async removeTags(params: unknown): Promise<McpResponse> {
    const validated = RemoveTagsParamsSchema.parse(params);
    const record = await this.storage.getRecord(validated.id);

    // Remove specified tags
    const newTags = record.tags.filter((tag) => !validated.tags.includes(tag));

    const updated = await this.storage.updateRecord(
      validated.id,
      { tags: newTags },
      record.version,
    );

    const response: RemoveTagsResponse = {
      id: updated.id,
      tags: updated.tags,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.list_documents
   */
  private async listDocuments(params: unknown): Promise<McpResponse> {
    const validated = ListDocumentsParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

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

    const result = await this.storage.listDocuments(filters);
    const response: ListDocumentsResponse = {
      documents: result.items.map((doc) => this.mapDocumentSummary(doc)),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.get_document
   */
  private async getDocument(params: unknown): Promise<McpResponse> {
    const validated = GetDocumentParamsSchema.parse(params);
    const includeLinks = validated.includeLinks ?? 'meta';

    let document: Document;
    if (validated.id) {
      document = await this.storage.getDocument({ id: validated.id });
    } else {
      const projectId = validated.projectId === '' ? null : validated.projectId!;
      document = await this.storage.getDocument({ slug: validated.slug!, projectId });
    }

    const response: GetDocumentResponse = {
      document: this.mapDocumentDetail(document),
      links: [],
    };

    let cache = new Map<string, Document | null>();
    if (includeLinks !== 'none') {
      const collected = await this.collectDocumentLinks(document);
      response.links = collected.links;
      cache = collected.cache;

      if (includeLinks === 'inline') {
        const inline = await this.buildInlineResolution(
          document,
          cache,
          validated.maxDepth ?? 1,
          validated.maxBytes ?? this.DEFAULT_INLINE_MAX_BYTES,
        );
        response.resolved = inline;
      }
    }

    return { success: true, data: response };
  }

  /**
   * devchain.create_document
   */
  private async createDocument(params: unknown): Promise<McpResponse> {
    const validated = CreateDocumentParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

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

    const document = await this.storage.createDocument({
      projectId: project.id,
      title: validated.title,
      contentMd: validated.contentMd,
      tags: validated.tags,
    });

    const response: CreateDocumentResponse = {
      document: this.mapDocumentDetail(document),
    };

    return { success: true, data: response };
  }

  /**
   * devchain.update_document
   */
  private async updateDocument(params: unknown): Promise<McpResponse> {
    const validated = UpdateDocumentParamsSchema.parse(params);
    const document = await this.storage.updateDocument(validated.id, {
      title: validated.title,
      slug: validated.slug,
      contentMd: validated.contentMd,
      tags: validated.tags,
      archived: validated.archived,
      version: validated.version,
    });

    const response: UpdateDocumentResponse = {
      document: this.mapDocumentDetail(document),
    };

    return { success: true, data: response };
  }

  /**
   * devchain.list_prompts
   */
  private async listPrompts(params: unknown): Promise<McpResponse> {
    const validated = ListPromptsParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    const projectId = project.id;

    const result = await this.storage.listPrompts({
      projectId: projectId ?? null,
      q: validated.q,
    });

    let items = result.items;
    if (validated.tags?.length) {
      items = items.filter((prompt) => validated.tags!.every((tag) => prompt.tags.includes(tag)));
    }

    const response: ListPromptsResponse = {
      prompts: items.map((prompt) => this.mapPromptSummary(prompt)),
      total: items.length,
    };

    return { success: true, data: response };
  }

  /**
   * devchain.get_prompt
   */
  private async getPrompt(params: unknown): Promise<McpResponse> {
    const validated = GetPromptParamsSchema.parse(params);
    let prompt: Prompt | undefined;

    if (validated.id) {
      prompt = await this.storage.getPrompt(validated.id);
    } else if (validated.name) {
      // Resolve project via sessionId
      if (!validated.sessionId) {
        return {
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'sessionId is required when querying prompt by name',
          },
        };
      }

      const ctx = await this.resolveSessionContext(validated.sessionId);
      if (!ctx.success) return ctx;
      const { project } = ctx.data as SessionContext;

      if (!project) {
        return {
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'No project associated with this session' },
        };
      }

      const projectId = project.id;

      const list = await this.storage.listPrompts({ projectId: projectId ?? null });
      const found = list.items.find((item) => {
        if (item.title !== validated.name) {
          return false;
        }
        if (validated.version !== undefined) {
          return item.version === validated.version;
        }
        return true;
      });

      if (found) {
        prompt = await this.storage.getPrompt(found.id);
      }
    }

    if (!prompt) {
      return {
        success: false,
        error: {
          code: 'PROMPT_NOT_FOUND',
          message: validated.id
            ? `Prompt with id "${validated.id}" not found`
            : `Prompt "${validated.name}"${validated.version ? ` version ${validated.version}` : ''} not found`,
        },
      };
    }

    const response: GetPromptResponse = {
      prompt: this.mapPromptDetail(prompt),
    };

    return { success: true, data: response };
  }

  /**
   * devchain_list_agents
   * Returns both agents and guests for the project with type markers and online status.
   * Pagination is applied to the combined list with stable ordering (name ASC, then type).
   */
  private async listAgents(params: unknown): Promise<McpResponse> {
    const validated = ListAgentsParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    const limit = validated.limit ?? 100;
    const offset = validated.offset ?? 0;
    const normalizedQuery = validated.q?.toLowerCase();

    // Fetch all agents and guests for combined pagination
    // We fetch all to ensure correct pagination semantics across both types
    const MAX_COMBINED_FETCH = 1000;
    const [agentsResult, guests] = await Promise.all([
      this.storage.listAgents(project.id, { limit: MAX_COMBINED_FETCH, offset: 0 }),
      this.storage.listGuests(project.id),
    ]);

    // Get agent presence (online status) and tmux sessions in parallel
    const [agentPresence, tmuxSessions] = await Promise.all([
      this.sessionsService
        ? this.sessionsService.getAgentPresence(project.id)
        : Promise.resolve(new Map<string, { online: boolean }>()),
      // Batch fetch all tmux session names for O(1) guest online checks
      this.tmuxService
        ? this.tmuxService.listAllSessionNames()
        : Promise.resolve(new Set<string>()),
    ]);

    // Map agents with type and online status
    const agentItems: AgentSummary[] = agentsResult.items.map((agent) => ({
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      description: agent.description,
      type: 'agent' as const,
      online: agentPresence.get(agent.id)?.online ?? false,
    }));

    // Map guests with online status using O(1) Set lookup (no N+1 tmux calls)
    const guestItems: AgentSummary[] = guests.map((guest) => ({
      id: guest.id,
      name: guest.name,
      profileId: null,
      description: guest.description,
      type: 'guest' as const,
      online: tmuxSessions.has(guest.tmuxSessionId),
    }));

    // Combine agents and guests with stable ordering (name ASC, then type: agent before guest)
    let allItems = [...agentItems, ...guestItems].sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) return nameCompare;
      // Agents come before guests when names are equal
      return a.type === 'agent' ? -1 : 1;
    });

    // Apply query filter if provided
    if (normalizedQuery) {
      allItems = allItems.filter((item) => item.name.toLowerCase().includes(normalizedQuery));
    }

    // Calculate total before pagination
    const total = allItems.length;

    // Apply pagination to combined list
    const paginatedItems = allItems.slice(offset, offset + limit);

    const response: ListAgentsResponse = {
      agents: paginatedItems,
      total,
      limit,
      offset,
    };

    return { success: true, data: response };
  }

  /**
   * devchain_get_agent_by_name
   */
  private async getAgentByName(params: unknown): Promise<McpResponse> {
    const validated = GetAgentByNameParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    const normalizedName = validated.name.trim().toLowerCase();
    const agentsList = await this.storage.listAgents(project.id, { limit: 1000, offset: 0 });

    const candidate = agentsList.items.find((agent) => agent.name.toLowerCase() === normalizedName);

    if (!candidate) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent "${validated.name}" not found in project`,
          data: {
            availableNames: agentsList.items.map((agent) => agent.name),
          },
        },
      };
    }

    let agentWithProfile;
    try {
      agentWithProfile = await this.storage.getAgentByName(project.id, candidate.name);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: `Agent "${validated.name}" not found in project`,
            data: {
              availableNames: agentsList.items.map((agent) => agent.name),
            },
          },
        };
      }
      logger.warn(
        { projectId: project.id, name: candidate.name, error },
        'Agent lookup failed after matching by name',
      );
      throw error;
    }

    const profile = agentWithProfile.profile;
    const resolvedInstructions = profile
      ? await this.instructionsResolver.resolve(project.id, profile.instructions ?? null, {
          maxBytes: this.DEFAULT_INLINE_MAX_BYTES,
        })
      : null;

    if (profile && this.featureFlags.enableProfileInstructionTemplates) {
      // Placeholder: profile instructions will support template variables behind this flag.
    }

    const response: GetAgentByNameResponse = {
      agent: {
        id: agentWithProfile.id,
        name: agentWithProfile.name,
        profileId: agentWithProfile.profileId,
        description: agentWithProfile.description,
        profile: profile
          ? {
              id: profile.id,
              name: profile.name,
              instructions: profile.instructions ?? null,
              instructionsResolved: resolvedInstructions ?? undefined,
            }
          : undefined,
      },
    };

    return { success: true, data: response };
  }

  private async listStatuses(params: unknown): Promise<McpResponse> {
    const validated = ListStatusesParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    const result = await this.storage.listStatuses(project.id, {
      limit: 1000,
      offset: 0,
    });
    const response: ListStatusesResponse = {
      statuses: result.items.map((status) => this.mapStatusSummary(status)),
    };

    return { success: true, data: response };
  }

  private async listEpics(params: unknown): Promise<McpResponse> {
    const validated = ListEpicsParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    let statusId: string | undefined;
    if (validated.statusName) {
      const status = await this.storage.findStatusByName(project.id, validated.statusName);
      if (!status) {
        return {
          success: false,
          error: {
            code: 'STATUS_NOT_FOUND',
            message: `Status "${validated.statusName}" was not found for project ${project.id}.`,
          },
        };
      }
      statusId = status.id;
    }

    const limit = validated.limit ?? 100;
    const offset = validated.offset ?? 0;
    const query = validated.q?.trim();

    // Fetch only parent epics (parentId IS NULL) for hierarchical response
    const result = await this.storage.listProjectEpics(project.id, {
      statusId,
      q: query && query.length ? query : undefined,
      limit,
      offset,
      excludeMcpHidden: true,
      parentOnly: true,
    });

    // Resolve statuses once for mapping onto epics and sub-epics
    const statusesResult = await this.storage.listStatuses(project.id, {
      limit: 1000,
      offset: 0,
    });
    const statusById = new Map<string, Status>();
    for (const s of statusesResult.items) statusById.set(s.id, s);

    // Resolve agent names for all parent epics
    const agentIds = new Set<string>();
    for (const epic of result.items) {
      if (epic.agentId) agentIds.add(epic.agentId);
    }

    const agentNameById = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const agent = await this.storage.getAgent(agentId);
        agentNameById.set(agentId, agent.name);
      } catch (error) {
        logger.warn({ agentId }, 'Failed to resolve agent name');
      }
    }

    // Batch-fetch sub-epics for all parent epics
    const parentIds = result.items.map((epic) => epic.id);
    const subEpicsMap = await this.storage.listSubEpicsForParents(project.id, parentIds, {
      excludeMcpHidden: true,
      type: 'active',
      limitPerParent: 50,
    });

    // Map parent epics with their sub-epics attached
    const epicsWithStatus = result.items.map((epic) => {
      const summary = this.mapEpicSummary(epic, agentNameById);
      const s = statusById.get(epic.statusId);
      if (s) {
        summary.status = this.mapStatusSummary(s);
      }

      // Attach sub-epics with resolved status
      const subEpics = subEpicsMap.get(epic.id) ?? [];
      summary.subEpics = subEpics.map((subEpic) => {
        const child = this.mapEpicChild(subEpic);
        const subStatus = statusById.get(subEpic.statusId);
        if (subStatus) {
          child.status = this.mapStatusSummary(subStatus);
        }
        return child;
      });

      return summary;
    });

    const response: ListEpicsResponse = {
      epics: epicsWithStatus,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  }

  private async listAssignedEpicsTasks(params: unknown): Promise<McpResponse> {
    const validated = ListAssignedEpicsTasksParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    const limit = validated.limit ?? 100;
    const offset = validated.offset ?? 0;

    try {
      const result = await this.storage.listAssignedEpics(project.id, {
        agentName: validated.agentName,
        limit,
        offset,
        excludeMcpHidden: true,
      });

      // Resolve statuses once for mapping onto epics
      const statusesResult = await this.storage.listStatuses(project.id, {
        limit: 1000,
        offset: 0,
      });
      const statusById = new Map<string, Status>();
      for (const s of statusesResult.items) statusById.set(s.id, s);

      // Resolve agent names for all epics
      const agentIds = new Set<string>();
      for (const epic of result.items) {
        if (epic.agentId) agentIds.add(epic.agentId);
      }

      const agentNameById = new Map<string, string>();
      for (const agentId of agentIds) {
        try {
          const agent = await this.storage.getAgent(agentId);
          agentNameById.set(agentId, agent.name);
        } catch (error) {
          logger.warn({ agentId }, 'Failed to resolve agent name');
        }
      }

      const epicsWithStatus = result.items.map((epic) => {
        const summary = this.mapEpicSummary(epic, agentNameById);
        const s = statusById.get(epic.statusId);
        if (s) {
          summary.status = this.mapStatusSummary(s);
        }
        return summary;
      });

      const response: ListAssignedEpicsTasksResponse = {
        epics: epicsWithStatus,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: `Agent "${validated.agentName}" was not found for project ${project.id}.`,
          },
        };
      }

      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
            data: error.details,
          },
        };
      }

      throw error;
    }
  }

  private async createEpic(params: unknown): Promise<McpResponse> {
    if (!this.epicsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Epic creation requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    const validated = CreateEpicParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    // Resolve statusName to statusId if provided
    let statusId: string | undefined;
    if (validated.statusName) {
      const status = await this.storage.findStatusByName(project.id, validated.statusName);
      if (!status) {
        const statusesResult = await this.storage.listStatuses(project.id, {
          limit: 1000,
          offset: 0,
        });
        return {
          success: false,
          error: {
            code: 'STATUS_NOT_FOUND',
            message: `Status "${validated.statusName}" was not found for project.`,
            data: {
              availableStatuses: statusesResult.items.map((s) => ({ id: s.id, name: s.label })),
            },
          },
        };
      }
      statusId = status.id;
    }

    try {
      // Build actor from session context
      const sessionCtx = ctx.data as SessionContext;
      const actor =
        sessionCtx.type === 'agent'
          ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
          : sessionCtx.type === 'guest'
            ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
            : null;

      const context: EpicOperationContext = { actor };

      const epic = await this.epicsService.createEpicForProject(
        project.id,
        {
          title: validated.title,
          description: validated.description ?? null,
          statusId,
          tags: validated.tags ?? [],
          agentName: validated.agentName,
          parentId: validated.parentId ?? null,
        },
        context,
      );

      // Resolve agent name if epic has an agent assigned
      let agentNameById: Map<string, string> | undefined;
      if (epic.agentId) {
        agentNameById = new Map();
        try {
          const agent = await this.storage.getAgent(epic.agentId);
          agentNameById.set(epic.agentId, agent.name);
        } catch (error) {
          logger.warn({ agentId: epic.agentId }, 'Failed to resolve agent name');
        }
      }

      const response: CreateEpicResponse = {
        epic: this.mapEpicSummary(epic, agentNameById),
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: `Agent "${validated.agentName}" was not found for project ${project.id}.`,
          },
        };
      }

      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
            data: error.details,
          },
        };
      }

      throw error;
    }
  }

  private async getEpicById(params: unknown): Promise<McpResponse> {
    const validated = GetEpicByIdParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    let epic: Epic;
    try {
      epic = await this.storage.getEpic(validated.id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'EPIC_NOT_FOUND',
            message: `Epic ${validated.id} was not found.`,
          },
        };
      }
      throw error;
    }

    if (epic.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${validated.id} does not belong to the resolved project.`,
        },
      };
    }

    const commentsResult = await this.storage.listEpicComments(epic.id, {
      limit: 250,
      offset: 0,
    });
    const subEpicsResult = await this.storage.listSubEpics(epic.id, { limit: 250, offset: 0 });

    // Fetch parent epic early so we can include parent.agentId in resolution
    let parentEpic: Epic | undefined;
    if (epic.parentId) {
      try {
        const parent = await this.storage.getEpic(epic.parentId);
        if (parent.projectId === project.id) {
          parentEpic = parent;
        }
      } catch (error) {
        if (error instanceof NotFoundError) {
          logger.warn({ epicId: epic.id, parentId: epic.parentId }, 'Parent epic missing');
        } else {
          throw error;
        }
      }
    }

    // Resolve statuses once for epic + sub-epics (project scoped)
    const statusesResult = await this.storage.listStatuses(project.id, {
      limit: 1000,
      offset: 0,
    });
    const statusById = new Map<string, Status>();
    for (const s of statusesResult.items) statusById.set(s.id, s);

    // Resolve agent names for epic, sub-epics, and parent
    const agentIds = new Set<string>();
    if (epic.agentId) agentIds.add(epic.agentId);
    for (const child of subEpicsResult.items) {
      if (child.agentId) agentIds.add(child.agentId);
    }
    if (parentEpic?.agentId) agentIds.add(parentEpic.agentId);

    const agentNameById = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const agent = await this.storage.getAgent(agentId);
        agentNameById.set(agentId, agent.name);
      } catch (error) {
        logger.warn({ agentId }, 'Failed to resolve agent name');
      }
    }

    // Build parent summary with resolved agent name
    let parentSummary: EpicParentSummary | undefined;
    if (parentEpic) {
      parentSummary = this.mapEpicParent(parentEpic, agentNameById);
    }

    // Build response and attach resolved statuses and agent names for epic and sub-epics
    const epicSummary = this.mapEpicSummary(epic, agentNameById);
    const epicStatus = statusById.get(epic.statusId);
    if (epicStatus) {
      epicSummary.status = this.mapStatusSummary(epicStatus);
    }

    const subEpicsWithStatus = subEpicsResult.items.map((child) => {
      const childSummary = this.mapEpicChild(child);
      const childStatus = statusById.get(child.statusId);
      if (childStatus) {
        childSummary.status = this.mapStatusSummary(childStatus);
      }
      return childSummary;
    });

    const response: GetEpicByIdResponse = {
      epic: epicSummary,
      // Reverse comments and add a sequential commentNumber starting at 1
      comments: [...commentsResult.items]
        .reverse()
        .map((comment, idx) => ({ ...this.mapEpicComment(comment), commentNumber: idx + 1 })),
      subEpics: subEpicsWithStatus,
    };

    if (parentSummary) {
      response.parent = parentSummary;
    }

    return { success: true, data: response };
  }

  private async addEpicComment(params: unknown): Promise<McpResponse> {
    const validated = AddEpicCommentParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const sessionCtx = ctx.data as SessionContext;

    // Author identity is derived from session's agent or guest
    const authorActor = getActorFromContext(sessionCtx);
    if (!authorActor) {
      return {
        success: false,
        error: {
          code: 'AGENT_REQUIRED',
          message: 'Session must be associated with an agent or guest to add comments',
        },
      };
    }

    const project = sessionCtx.project;
    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    let epic: Epic;
    try {
      epic = await this.storage.getEpic(validated.epicId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'EPIC_NOT_FOUND',
            message: `Epic ${validated.epicId} was not found.`,
          },
        };
      }
      throw error;
    }

    if (epic.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${validated.epicId} does not belong to the resolved project.`,
        },
      };
    }

    const comment = await this.storage.createEpicComment({
      epicId: validated.epicId,
      authorName: authorActor.name,
      content: validated.content,
    });

    const response: AddEpicCommentResponse = {
      comment: this.mapEpicComment(comment),
    };

    return { success: true, data: response };
  }

  private async updateEpic(params: unknown): Promise<McpResponse> {
    if (!this.epicsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Epic updates require full app context (not available in standalone MCP mode)',
        },
      };
    }

    // Preprocess assignment: some MCP clients may pass nested objects as JSON strings
    let preprocessedParams = params;
    if (params && typeof params === 'object' && 'assignment' in params) {
      const p = params as Record<string, unknown>;
      if (typeof p.assignment === 'string') {
        try {
          preprocessedParams = { ...p, assignment: JSON.parse(p.assignment) };
        } catch {
          // Leave as-is; Zod will report the validation error
        }
      }
    }

    const validated = UpdateEpicParamsSchema.parse(preprocessedParams);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    // Fetch epic and verify it belongs to this project
    let epic: Epic;
    try {
      epic = await this.storage.getEpic(validated.id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'EPIC_NOT_FOUND',
            message: `Epic ${validated.id} was not found.`,
          },
        };
      }
      throw error;
    }

    if (epic.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: `Epic ${validated.id} does not belong to the resolved project.`,
        },
      };
    }

    // Build update payload
    const updateData: {
      title?: string;
      description?: string;
      statusId?: string;
      agentId?: string | null;
      parentId?: string | null;
      tags?: string[];
    } = {};

    if (validated.title !== undefined) {
      updateData.title = validated.title;
    }

    if (validated.description !== undefined) {
      updateData.description = validated.description;
    }

    // Resolve statusName to statusId
    if (validated.statusName) {
      const status = await this.storage.findStatusByName(project.id, validated.statusName);
      if (!status) {
        const statusesResult = await this.storage.listStatuses(project.id, {
          limit: 1000,
          offset: 0,
        });
        return {
          success: false,
          error: {
            code: 'STATUS_NOT_FOUND',
            message: `Status "${validated.statusName}" was not found for project.`,
            data: {
              availableStatuses: statusesResult.items.map((s) => ({ id: s.id, name: s.label })),
            },
          },
        };
      }
      updateData.statusId = status.id;
    }

    // Resolve assignment
    if (validated.assignment) {
      if ('clear' in validated.assignment && validated.assignment.clear) {
        updateData.agentId = null;
      } else if ('agentName' in validated.assignment) {
        try {
          const agent = await this.storage.getAgentByName(
            project.id,
            validated.assignment.agentName,
          );
          updateData.agentId = agent.id;
        } catch (error) {
          if (error instanceof NotFoundError) {
            const agentsList = await this.storage.listAgents(project.id, {
              limit: 1000,
              offset: 0,
            });
            return {
              success: false,
              error: {
                code: 'AGENT_NOT_FOUND',
                message: `Agent "${validated.assignment.agentName}" was not found for project.`,
                data: {
                  availableAgents: agentsList.items.map((a) => ({ id: a.id, name: a.name })),
                },
              },
            };
          }
          throw error;
        }
      }
    }

    // Handle parent updates
    if (validated.clearParent) {
      updateData.parentId = null;
    } else if (validated.parentId !== undefined) {
      // Validate parent epic
      if (validated.parentId === validated.id) {
        return {
          success: false,
          error: {
            code: 'PARENT_INVALID',
            message: 'An epic cannot be its own parent.',
          },
        };
      }

      let parentEpic: Epic;
      try {
        parentEpic = await this.storage.getEpic(validated.parentId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return {
            success: false,
            error: {
              code: 'PARENT_INVALID',
              message: `Parent epic ${validated.parentId} was not found.`,
            },
          };
        }
        throw error;
      }

      if (parentEpic.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'PARENT_INVALID',
            message: 'Parent epic must belong to the same project.',
          },
        };
      }

      // Check one-level hierarchy: parent must not have a parent
      if (parentEpic.parentId !== null) {
        return {
          success: false,
          error: {
            code: 'HIERARCHY_CONFLICT',
            message:
              'Only one level of epic hierarchy is allowed. The specified parent already has a parent.',
          },
        };
      }

      updateData.parentId = validated.parentId;
    }

    // Handle tag operations
    if (validated.setTags !== undefined) {
      updateData.tags = validated.setTags;
    } else if (validated.addTags || validated.removeTags) {
      const currentTags = new Set(epic.tags);

      if (validated.addTags) {
        validated.addTags.forEach((tag) => currentTags.add(tag));
      }

      if (validated.removeTags) {
        validated.removeTags.forEach((tag) => currentTags.delete(tag));
      }

      updateData.tags = Array.from(currentTags);
    }

    // Update epic with optimistic locking
    let updatedEpic: Epic;
    try {
      // Build actor from session context
      const sessionCtx = ctx.data as SessionContext;
      const actor =
        sessionCtx.type === 'agent'
          ? { type: 'agent' as const, id: (sessionCtx as AgentSessionContext).agent!.id }
          : sessionCtx.type === 'guest'
            ? { type: 'guest' as const, id: (sessionCtx as GuestSessionContext).guest!.id }
            : null;

      const context: EpicOperationContext = { actor };

      updatedEpic = await this.epicsService.updateEpic(
        validated.id,
        updateData,
        validated.version,
        context,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('was modified by another operation')) {
        // Fetch current version
        const currentEpic = await this.storage.getEpic(validated.id);
        return {
          success: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: `Epic version conflict. Expected version ${validated.version}, but current version is ${currentEpic.version}.`,
            data: {
              currentVersion: currentEpic.version,
            },
          },
        };
      }
      throw error;
    }

    // Resolve agent name if epic has an agent assigned
    let agentNameById: Map<string, string> | undefined;
    if (updatedEpic.agentId) {
      agentNameById = new Map();
      try {
        const agent = await this.storage.getAgent(updatedEpic.agentId);
        agentNameById.set(updatedEpic.agentId, agent.name);
      } catch (error) {
        logger.warn({ agentId: updatedEpic.agentId }, 'Failed to resolve agent name');
      }
    }

    const response: UpdateEpicResponse = {
      epic: this.mapEpicSummary(updatedEpic, agentNameById),
    };

    return { success: true, data: response };
  }

  /**
   * Resolves a recipient by name, checking agents first then guests.
   * Returns null if not found. Propagates real storage errors.
   */
  private async resolveRecipientByName(
    projectId: string,
    name: string,
  ): Promise<ResolvedRecipient | null> {
    // Try to find as agent first
    try {
      const agent = await this.storage.getAgentByName(projectId, name);
      return {
        type: 'agent',
        id: agent.id,
        name: agent.name,
      };
    } catch (error) {
      // Only proceed to guest lookup if agent was not found
      // Propagate real storage errors (connection issues, etc.)
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }

    // Try to find as guest (getGuestByName returns null if not found)
    const guest = await this.storage.getGuestByName(projectId, name);
    if (guest) {
      return {
        type: 'guest',
        id: guest.id,
        name: guest.name,
        tmuxSessionId: guest.tmuxSessionId,
      };
    }

    return null;
  }

  /**
   * Gets available recipient names (agents + guests) for error messages.
   */
  private async getAvailableRecipientNames(projectId: string): Promise<string[]> {
    const [agentsResult, guests] = await Promise.all([
      this.storage.listAgents(projectId, { limit: 100, offset: 0 }),
      this.storage.listGuests(projectId),
    ]);

    const agentNames = agentsResult.items.map((a) => a.name);
    const guestNames = guests.map((g) => `${g.name} (guest)`);

    return [...agentNames, ...guestNames];
  }

  /**
   * devchain_send_message
   * Delivers a chat message to agent sessions via tmux injection
   */
  private async sendMessage(params: unknown): Promise<McpResponse> {
    if (!this.sessionsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Chat functionality requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    const validated = SendMessageParamsSchema.parse(params);

    // Resolve session to get project context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const sessionCtx = ctx.data as SessionContext;
    const sender = getActorFromContext(sessionCtx);
    const project = sessionCtx.project;

    // Sender identity is derived from session's agent or guest
    if (!sender) {
      return {
        success: false,
        error: {
          code: 'AGENT_REQUIRED',
          message: 'Session must be associated with an agent or guest to send messages',
        },
      };
    }

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    // Block guests from thread-backed messaging and user DMs
    // Guests can only use pooled direct messaging via recipientAgentNames
    if (sessionCtx.type === 'guest') {
      if (validated.threadId) {
        return {
          success: false,
          error: {
            code: 'GUEST_THREAD_NOT_ALLOWED',
            message:
              'Guests cannot use threaded messaging. Use recipientAgentNames for direct messaging.',
          },
        };
      }
      if (validated.recipient === 'user') {
        return {
          success: false,
          error: {
            code: 'GUEST_USER_DM_NOT_ALLOWED',
            message: 'Guests cannot send direct messages to users.',
          },
        };
      }
    }

    try {
      const autoLaunchSessions = process.env.NODE_ENV !== 'test';

      // Sender identity from session context (agent or guest)
      const senderId = sender.id;
      const senderName = sender.name;
      const senderType = sessionCtx.type; // 'agent' or 'guest'
      const recipientType = validated.recipient ?? 'agents';

      // Resolve recipients from names (agents and guests)
      const resolvedRecipients: ResolvedRecipient[] = [];
      if (validated.recipientAgentNames && validated.recipientAgentNames.length > 0) {
        for (const name of validated.recipientAgentNames) {
          const recipient = await this.resolveRecipientByName(project.id, name);
          if (!recipient) {
            const availableNames = await this.getAvailableRecipientNames(project.id);
            return {
              success: false,
              error: {
                code: 'RECIPIENT_NOT_FOUND',
                message: `Recipient "${name}" not found. Available: ${availableNames.join(', ') || 'none'}`,
              },
            };
          }
          // Skip sender
          if (recipient.id !== senderId) {
            resolvedRecipients.push(recipient);
          }
        }
      }
      // Deduplicate by id
      const uniqueRecipients = resolvedRecipients.filter(
        (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
      );

      // Special case: direct messaging without threadId uses pooled injection
      if (!validated.threadId && senderId && recipientType !== 'user') {
        if (!this.messagePoolService || !this.settingsService) {
          return {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message:
                'Message pool functionality requires full app context (not available in standalone MCP mode)',
            },
          };
        }

        if (uniqueRecipients.length === 0) {
          return {
            success: false,
            error: {
              code: 'RECIPIENTS_REQUIRED',
              message: 'Recipients must be provided when sending without threadId.',
            },
          };
        }

        const queued: Array<{
          name: string;
          type: 'agent' | 'guest';
          status: 'queued' | 'launched' | 'delivered' | 'failed';
          error?: string;
        }> = [];
        const poolConfig = this.settingsService.getMessagePoolConfigForProject(project.id);

        // Fetch active sessions once before loop to check if agents need auto-launch
        const activeSessions = this.sessionsService
          ? await this.sessionsService.listActiveSessions()
          : [];

        for (const recipient of uniqueRecipients) {
          const injectionText = `\n[This message is sent from "${senderName}" ${senderType} use devchain_send_message tool for communication]\n${validated.message}\n`;

          if (recipient.type === 'agent') {
            // Agent recipient - use existing pooled delivery
            let session = activeSessions.find((s) => s.agentId === recipient.id);
            let wasLaunched = false;

            if (!session && autoLaunchSessions && this.sessionsService) {
              try {
                const launched = await this.sessionsService.launchSession({
                  projectId: project.id,
                  agentId: recipient.id,
                  options: { silent: true },
                });
                session = launched;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                activeSessions.push(launched as any);
                wasLaunched = true;
              } catch {
                // Continue with queueing - agent will receive when online
              }
            }

            await this.messagePoolService.enqueue(recipient.id, injectionText, {
              source: 'mcp.send_message',
              submitKeys: ['Enter'],
              senderAgentId: senderId, // Note: interface uses 'senderAgentId' for historical reasons
              projectId: project.id,
              agentName: recipient.name,
            });

            queued.push({
              name: recipient.name,
              type: 'agent',
              status: wasLaunched ? 'launched' : 'queued',
            });
          } else {
            // Guest recipient - check if online and deliver directly via tmux
            // Guests don't have message pooling, so we deliver immediately or fail
            const isOnline = this.tmuxService
              ? await this.tmuxService.hasSession(recipient.tmuxSessionId!)
              : false;

            if (!isOnline) {
              // Guest is offline - no pooling available for guests
              queued.push({
                name: recipient.name,
                type: 'guest',
                status: 'failed',
                error: 'Recipient offline',
              });
            } else if (this.tmuxService) {
              // Deliver directly to guest's tmux session
              try {
                await this.tmuxService.pasteAndSubmit(recipient.tmuxSessionId!, injectionText);
                queued.push({
                  name: recipient.name,
                  type: 'guest',
                  status: 'delivered',
                });
              } catch (error) {
                logger.warn(
                  { guestId: recipient.id, tmuxSessionId: recipient.tmuxSessionId, error },
                  'Failed to deliver message to guest',
                );
                queued.push({
                  name: recipient.name,
                  type: 'guest',
                  status: 'failed',
                  error: error instanceof Error ? error.message : 'Delivery failed',
                });
              }
            } else {
              // tmuxService not available
              queued.push({
                name: recipient.name,
                type: 'guest',
                status: 'failed',
                error: 'Tmux service unavailable',
              });
            }
          }
        }

        const response: SendMessageResponse = {
          mode: 'pooled',
          queuedCount: queued.length,
          queued,
          estimatedDeliveryMs: poolConfig.delayMs,
        };

        return { success: true, data: response };
      }

      // Remaining modes require ChatService (thread-backed behavior).
      if (!this.chatService) {
        return {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              'Chat functionality requires full app context (not available in standalone MCP mode)',
          },
        };
      }

      // Determine thread ID - create new group thread or DM if needed
      // Note: This path is only for agents (guests are blocked above)
      let threadId = validated.threadId;
      if (!threadId && senderId) {
        if (recipientType === 'user') {
          // Agent -> User DM: ensure/create direct thread
          const direct = await this.chatService.createDirectThread({
            projectId: project.id,
            agentId: senderId,
          });
          threadId = direct.id;
        } else {
          // Agent-to-agent without threadId is handled above (direct injection).
        }
      }

      if (!threadId) {
        // This should be unreachable given current validation, but kept as safety net
        return {
          success: false,
          error: {
            code: 'THREAD_REQUIRED',
            message: 'Unable to determine thread for message delivery',
          },
        };
      }

      // Get thread to determine fan-out recipients
      const thread = await this.chatService.getThread(threadId);

      // Create the message (sender is always an agent in thread mode - guests are blocked)
      const message = await this.chatService.createMessage(threadId, {
        authorType: 'agent',
        authorAgentId: senderId,
        content: validated.message,
      });

      // Determine delivery targets (agents only for thread mode, do not deliver to user)
      // Extract agent IDs from resolved recipients
      let targetAgentIds = uniqueRecipients.filter((r) => r.type === 'agent').map((r) => r.id);

      // Fan-out rule: if author is agent and thread has multiple agents, deliver to all agents
      if (senderId && thread.members && thread.members.length > 1 && targetAgentIds.length === 0) {
        targetAgentIds = thread.members.filter((id) => id !== senderId);
      }

      // Get active sessions and agent details
      const activeSessions = await this.sessionsService.listActiveSessions();
      const delivered: Array<{
        agentName: string;
        agentId: string;
        sessionId: string;
        status: 'delivered' | 'queued';
      }> = [];

      for (const agentId of targetAgentIds) {
        const agent = await this.storage.getAgent(agentId);
        let session = activeSessions.find((s) => s.agentId === agentId);

        if (!session && autoLaunchSessions) {
          try {
            const launched = await this.sessionsService.launchSession({
              projectId: project.id,
              agentId,
              options: { silent: true },
            });
            session = launched;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            activeSessions.push(launched as any);
          } catch {
            // fall back to queued
          }
        }

        if (!session) {
          delivered.push({ agentId, agentName: agent.name, sessionId: '', status: 'queued' });
          continue;
        }

        // Inject message into tmux session
        const injectionText = `\n[CHAT] From: ${senderName} • Thread: ${threadId}\n${validated.message}\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { sessionId: "${session.id}", thread_id: "${threadId}", message_id: "${message.id}" } }\n`;

        await this.sessionsService.injectTextIntoSession(session.id, injectionText);

        delivered.push({
          agentId,
          agentName: agent.name,
          sessionId: session.id,
          status: 'delivered',
        });
      }

      const response: SendMessageResponse = {
        mode: 'thread',
        threadId,
        messageId: message.id,
        deliveryCount: delivered.filter((d) => d.status === 'delivered').length,
        delivered,
      };

      return { success: true, data: response };
    } catch (error) {
      logger.error({ error, params: redactParams(validated) }, 'sendMessage failed');
      return {
        success: false,
        error: {
          code: 'SEND_MESSAGE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to send message',
        },
      };
    }
  }

  /**
   * devchain_chat_ack
   * Marks a message as read and emits WebSocket event
   */
  private async chatAck(params: unknown): Promise<McpResponse> {
    if (!this.chatService || !this.terminalGateway) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Chat acknowledgment requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    const validated = ChatAckParamsSchema.parse(params);
    const { thread_id: threadId, message_id: messageId } = validated;

    // Resolve session to get agent identity
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const sessionCtx = ctx.data as SessionContext;
    const agent = getActorFromContext(sessionCtx);

    if (!agent) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'No agent associated with this session',
        },
      };
    }

    const agentId = agent.id;

    try {
      // Verify agent is a member of the thread
      const thread = await this.chatService.getThread(threadId);
      const memberIds = thread.members ?? [];
      if (!memberIds.includes(agentId)) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_IN_THREAD',
            message: `Agent ${agent.name} is not a member of thread ${threadId}`,
          },
        };
      }

      const now = new Date().toISOString();

      // Insert read record (or update if exists)
      await this.storage.markMessageAsRead(messageId, agentId!, now);

      // Check if this message is an invite and acknowledge it if the agent has an active session
      if (this.sessionsService) {
        const activeSessions = await this.sessionsService.listActiveSessions();
        const agentSession = activeSessions.find((s) => s.agentId === agentId);
        if (agentSession && agentSession.tmuxSessionId) {
          await this.chatService.acknowledgeInvite(
            threadId,
            messageId,
            agentId!,
            agentSession.tmuxSessionId,
          );
        }
      }

      // Broadcast WebSocket event
      this.terminalGateway.broadcastEvent(`chat/${threadId}`, 'message.read', {
        messageId,
        agentId,
        readAt: now,
      });

      const response: ChatAckResponse = {
        threadId,
        messageId,
        agentId,
        agentName: agent.name,
        acknowledged: true,
      };

      return { success: true, data: response };
    } catch (error) {
      logger.error({ error, params: redactParams(validated) }, 'chatAck failed');
      return {
        success: false,
        error: {
          code: 'CHAT_ACK_FAILED',
          message: error instanceof Error ? error.message : 'Failed to acknowledge message',
        },
      };
    }
  }

  private async chatListMembers(params: unknown): Promise<McpResponse> {
    if (!this.chatService || !this.sessionsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Chat members listing requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    const validated = ChatListMembersParamsSchema.parse(params);

    try {
      const thread = await this.chatService.getThread(validated.thread_id);
      const memberIds = thread.members ?? [];

      if (memberIds.length === 0) {
        const emptyResponse: ChatListMembersResponse = {
          thread: {
            id: thread.id,
            title: thread.title,
          },
          members: [],
          total: 0,
        };

        return { success: true, data: emptyResponse };
      }

      const agents = await Promise.all(
        memberIds.map(async (agentId) => {
          try {
            return await this.storage.getAgent(agentId);
          } catch (error) {
            logger.error(
              { error, agentId, threadId: thread.id },
              'Failed to resolve agent for chat members',
            );
            throw error;
          }
        }),
      );

      const activeSessions = await this.sessionsService.listActiveSessions();
      const onlineAgents = new Set(activeSessions.map((session) => session.agentId));

      const members: ChatListMembersResponse['members'] = agents.map((agent) => ({
        agent_id: agent.id,
        agent_name: agent.name,
        online: onlineAgents.has(agent.id),
      }));

      const response: ChatListMembersResponse = {
        thread: {
          id: thread.id,
          title: thread.title,
        },
        members,
        total: members.length,
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Thread ${validated.thread_id} was not found.`,
          },
        };
      }

      logger.error({ error, params: validated }, 'chatListMembers failed');
      return {
        success: false,
        error: {
          code: 'CHAT_LIST_MEMBERS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to list chat members',
        },
      };
    }
  }

  /**
   * devchain_chat_read_history
   * Returns thread summary and recent messages with author/target names resolved
   */
  private async chatReadHistory(params: unknown): Promise<McpResponse> {
    if (!this.chatService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Chat history requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    const validated = ChatReadHistoryParamsSchema.parse(params);

    try {
      const thread = await this.chatService.getThread(validated.thread_id);

      const limit = validated.limit ?? 50;
      const validatedWithExcludeSystem = validated as typeof validated & {
        exclude_system?: boolean;
      };
      const excludeSystem =
        typeof validatedWithExcludeSystem.exclude_system === 'boolean'
          ? validatedWithExcludeSystem.exclude_system
          : true;

      const messagesList = await this.chatService.listMessages(validated.thread_id, {
        since: validated.since,
        limit,
        offset: 0,
      });

      // Preload names for authors and targets
      const authorIds = new Set<string>();
      const targetIds = new Set<string>();
      for (const m of messagesList.items) {
        if (m.authorAgentId) authorIds.add(m.authorAgentId);
        if (m.targets) for (const t of m.targets) targetIds.add(t);
      }

      const idToName = new Map<string, string>();
      const toLoad = Array.from(new Set([...authorIds, ...targetIds]));
      for (const id of toLoad) {
        try {
          const a = await this.storage.getAgent(id);
          idToName.set(id, a.name);
        } catch {
          // ignore
        }
      }

      const filteredItems = excludeSystem
        ? messagesList.items.filter((m) => m.authorType !== 'system')
        : messagesList.items;

      const messages = filteredItems.map((m) => {
        const base: Record<string, unknown> = {
          id: m.id,
          author_type: m.authorType,
          author_agent_id: m.authorAgentId ?? null,
          author_agent_name: m.authorAgentId ? (idToName.get(m.authorAgentId) ?? null) : null,
          content: m.content,
          created_at: m.createdAt,
          targets: m.targets,
        };

        if (m.targets && m.targets.length > 0) {
          const names = m.targets
            .map((tid) => idToName.get(tid))
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          if (names.length > 0) {
            base.target_agent_names = names;
          }
        }

        return base;
      });

      const response = {
        thread: {
          id: thread.id,
          title: thread.title,
        },
        messages,
        // Conservative has_more: true only when we filled the requested limit
        has_more: messages.length === limit,
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Thread ${validated.thread_id} was not found.`,
          },
        };
      }
      logger.error({ error, params: validated }, 'chatReadHistory failed');
      return {
        success: false,
        error: {
          code: 'CHAT_READ_HISTORY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read chat history',
        },
      };
    }
  }

  /**
   * devchain_activity_start
   */
  private async activityStart(params: unknown): Promise<McpResponse> {
    if (!this.chatService) {
      return {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Chat service unavailable' },
      };
    }
    const validated = ActivityStartParamsSchema.parse(params);

    // Resolve session to get project and agent context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const sessionCtx = ctx.data as SessionContext;
    const project = sessionCtx.project;
    const agent = getActorFromContext(sessionCtx);

    // Block guests from activity tools (they use thread-backed chat)
    if (sessionCtx.type === 'guest') {
      return {
        success: false,
        error: {
          code: 'GUEST_ACTIVITY_NOT_ALLOWED',
          message: 'Guests cannot use activity tools.',
        },
      };
    }

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!agent) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'No agent associated with this session',
        },
      };
    }

    const agentId = agent.id;

    // Determine thread
    let threadId = validated.threadId;
    if (threadId) {
      const thread = await this.chatService.getThread(threadId);
      const members = thread.members ?? [];
      if (!members.includes(agentId)) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_IN_THREAD',
            message: `Agent ${agent.name} is not a member of thread ${threadId}`,
          },
        };
      }
    } else {
      const direct = await this.chatService.createDirectThread({ projectId: project.id, agentId });
      threadId = direct.id;
    }

    const result = await this.chatService.startActivity(threadId!, agentId, validated.title, {
      announce: validated.announce,
    });

    const response = {
      activity_id: result.activityId,
      thread_id: threadId!,
      start_message_id: result.startMessageId,
      started_at: result.startedAt,
      auto_finished_prior: result.autoFinishedPrior,
    };
    return { success: true, data: response };
  }

  /**
   * devchain_activity_finish
   */
  private async activityFinish(params: unknown): Promise<McpResponse> {
    if (!this.chatService) {
      return {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Chat service unavailable' },
      };
    }
    const validated = ActivityFinishParamsSchema.parse(params);

    // Resolve session to get project and agent context
    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const sessionCtx = ctx.data as SessionContext;
    const project = sessionCtx.project;
    const agent = getActorFromContext(sessionCtx);

    // Block guests from activity tools (they use thread-backed chat)
    if (sessionCtx.type === 'guest') {
      return {
        success: false,
        error: {
          code: 'GUEST_ACTIVITY_NOT_ALLOWED',
          message: 'Guests cannot use activity tools.',
        },
      };
    }

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!agent) {
      return {
        success: false,
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'No agent associated with this session',
        },
      };
    }

    const agentId = agent.id;

    let threadId = validated.threadId;
    if (threadId) {
      const thread = await this.chatService.getThread(threadId);
      const members = thread.members ?? [];
      if (!members.includes(agentId)) {
        return {
          success: false,
          error: {
            code: 'AGENT_NOT_IN_THREAD',
            message: `Agent ${agent.name} is not a member of thread ${threadId}`,
          },
        };
      }
    } else {
      const direct = await this.chatService.createDirectThread({ projectId: project.id, agentId });
      threadId = direct.id;
    }

    try {
      const result = await this.chatService.finishActivity(threadId!, agentId, {
        message: validated.message,
        status: validated.status,
      });
      const response = {
        activity_id: result.activityId,
        thread_id: threadId!,
        finish_message_id: result.finishMessageId,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        status: result.status,
      };
      return { success: true, data: response };
    } catch (error) {
      if (error instanceof ValidationError || error instanceof BadRequestException) {
        return {
          success: false,
          error: { code: 'NO_RUNNING_ACTIVITY', message: 'No running activity to finish' },
        };
      }
      throw error;
    }
  }

  /**
   * devchain_list_sessions
   * Returns active sessions for discovery (bootstrap tool - no sessionId required)
   */
  private async listSessions(): Promise<McpResponse> {
    if (!this.sessionsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Session listing requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    try {
      const activeSessions = await this.sessionsService.listActiveSessions();

      // Batch-load agents: collect unique agentIds and fetch in parallel
      const agentIds = [
        ...new Set(activeSessions.map((s) => s.agentId).filter((id): id is string => !!id)),
      ];
      const agentResults = await Promise.all(
        agentIds.map((id) =>
          this.storage
            .getAgent(id)
            .catch(() => null as { id: string; name: string; projectId: string } | null),
        ),
      );
      const agentMap = new Map(
        agentResults.filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.id, a]),
      );

      // Batch-load projects: collect unique projectIds from agents and fetch in parallel
      const projectIds = [
        ...new Set(
          Array.from(agentMap.values())
            .map((a) => a.projectId)
            .filter((id): id is string => !!id),
        ),
      ];
      const projectResults = await Promise.all(
        projectIds.map((id) =>
          this.storage.getProject(id).catch(() => null as { id: string; name: string } | null),
        ),
      );
      const projectMap = new Map(
        projectResults.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => [p.id, p]),
      );

      // Map results back to sessions
      const sessions: SessionSummary[] = activeSessions.map((session) => {
        const agent = session.agentId ? agentMap.get(session.agentId) : undefined;
        const project = agent?.projectId ? projectMap.get(agent.projectId) : undefined;

        return {
          sessionIdShort: session.id.slice(0, 8), // Only expose 8-char prefix for security
          agentName: agent?.name ?? 'Unknown',
          // Empty string if agent not resolved (can't determine project), 'Unknown' if agent found but project not
          projectName: agent ? (project?.name ?? 'Unknown') : '',
          status: session.status,
          startedAt: session.startedAt,
        };
      });

      const response: ListSessionsResponse = { sessions };
      return { success: true, data: response };
    } catch (error) {
      logger.error({ error }, 'listSessions failed');
      return {
        success: false,
        error: {
          code: 'LIST_SESSIONS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to list sessions',
        },
      };
    }
  }

  /**
   * Resolves a sessionId (full UUID or 8+ char prefix) to session, agent, and project context.
   * Used by MCP tools for session-based authentication.
   */
  async resolveSessionContext(sessionId: string): Promise<McpResponse> {
    if (!this.sessionsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Session resolution requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    // Validate minimum length
    if (!sessionId || sessionId.length < 8) {
      return {
        success: false,
        error: {
          code: 'INVALID_SESSION_ID',
          message: 'Session ID must be at least 8 characters (full UUID or prefix)',
        },
      };
    }

    try {
      const activeSessions = await this.sessionsService.listActiveSessions();

      // Find matching sessions
      let matchingSessions: typeof activeSessions;

      if (sessionId.length === 36) {
        // Full UUID - exact match
        matchingSessions = activeSessions.filter((s) => s.id === sessionId);
      } else {
        // Prefix match (8-35 chars)
        matchingSessions = activeSessions.filter((s) => s.id.startsWith(sessionId));
      }

      // Handle no match - check if it's a guest ID
      if (matchingSessions.length === 0) {
        // Try to find a guest with this ID
        const guestContext = await this.tryResolveGuestContext(sessionId);
        if (guestContext) {
          return { success: true, data: guestContext };
        }

        return {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: `No active session or guest found matching '${sessionId}'`,
          },
        };
      }

      // Handle ambiguous prefix
      if (matchingSessions.length > 1) {
        const prefixLength = 12;
        const matchingPrefixes = matchingSessions.map((s) => s.id.slice(0, prefixLength));
        return {
          success: false,
          error: {
            code: 'AMBIGUOUS_SESSION',
            message: `Multiple active sessions match prefix '${sessionId}': ${matchingPrefixes.join(', ')}. Use a longer prefix (e.g., 12+ chars) or full UUID.`,
            data: {
              matchingSessionIdPrefixes: matchingPrefixes,
            },
          },
        };
      }

      // Single match found
      const session = matchingSessions[0];

      // Resolve agent
      let agent: AgentSessionContext['agent'] = null;
      if (session.agentId) {
        try {
          const agentEntity = await this.storage.getAgent(session.agentId);
          agent = {
            id: agentEntity.id,
            name: agentEntity.name,
            projectId: agentEntity.projectId,
          };
        } catch {
          logger.warn(
            { sessionId: redactSessionId(session.id), agentId: session.agentId },
            'Agent not found for session',
          );
        }
      }

      // Resolve project through agent
      let project: AgentSessionContext['project'] = null;
      if (agent?.projectId) {
        try {
          const projectEntity = await this.storage.getProject(agent.projectId);
          project = {
            id: projectEntity.id,
            name: projectEntity.name,
            rootPath: projectEntity.rootPath,
          };
        } catch {
          logger.warn(
            { sessionId: redactSessionId(session.id), projectId: agent.projectId },
            'Project not found for session',
          );
        }
      }

      const context: AgentSessionContext = {
        type: 'agent',
        session: {
          id: session.id,
          agentId: session.agentId,
          status: session.status,
          startedAt: session.startedAt,
        },
        agent,
        project,
      };

      return { success: true, data: context };
    } catch (error) {
      logger.error(
        { error, sessionId: redactSessionId(sessionId) },
        'resolveSessionContext failed',
      );
      return {
        success: false,
        error: {
          code: 'SESSION_RESOLUTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to resolve session context',
        },
      };
    }
  }

  /**
   * Try to resolve a guest context by guest ID.
   * Verifies the tmux session is still alive before returning.
   */
  private async tryResolveGuestContext(guestId: string): Promise<GuestSessionContext | null> {
    if (!this.guestsService || !this.tmuxService) {
      return null;
    }

    try {
      // Try to find guest by ID (supports both full UUID and prefix)
      let guest;
      if (guestId.length === 36) {
        // Full UUID - exact match
        guest = await this.storage.getGuest(guestId);
      } else {
        // Prefix match - use targeted SQL query for O(1) lookup instead of loading all guests
        const matches = await this.storage.getGuestsByIdPrefix(guestId);
        if (matches.length === 1) {
          guest = matches[0];
        } else {
          return null; // No match or ambiguous
        }
      }

      // Verify tmux session is still alive
      const sessionAlive = await this.tmuxService.hasSession(guest.tmuxSessionId);
      if (!sessionAlive) {
        logger.warn(
          { guestId: guest.id, tmuxSessionId: guest.tmuxSessionId },
          'Guest tmux session no longer exists',
        );
        return null;
      }

      // Resolve project
      const project = await this.storage.getProject(guest.projectId);

      const context: GuestSessionContext = {
        type: 'guest',
        guest: {
          id: guest.id,
          name: guest.name,
          projectId: guest.projectId,
          tmuxSessionId: guest.tmuxSessionId,
        },
        project: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
        },
      };

      return context;
    } catch (error) {
      // Guest not found or other error
      logger.debug(
        { guestId: redactSessionId(guestId), error: String(error) },
        'Failed to resolve guest context',
      );
      return null;
    }
  }

  /**
   * Register a new guest agent (bootstrap tool - no session required)
   */
  private async registerGuest(params: unknown): Promise<McpResponse> {
    if (!this.guestsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Guest registration requires full app context',
        },
      };
    }

    const validated = RegisterGuestParamsSchema.parse(params);

    try {
      const result = await this.guestsService.register({
        name: validated.name,
        tmuxSessionId: validated.tmuxSessionId,
        description: validated.description,
      });

      const response: RegisterGuestResponse = {
        guestId: result.guestId,
        name: validated.name,
        projectId: result.projectId,
        projectName: result.projectName,
        isSandbox: result.isSandbox,
        registeredAt: new Date().toISOString(),
      };

      logger.info(
        { guestId: result.guestId, projectId: result.projectId, isSandbox: result.isSandbox },
        'Guest registered successfully',
      );

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
            data: error.details,
          },
        };
      }
      if (error instanceof Error && error.name === 'ConflictError') {
        return {
          success: false,
          error: {
            code: 'CONFLICT',
            message: error.message,
            data: (error as { data?: unknown }).data,
          },
        };
      }
      throw error;
    }
  }

  private mapStatusSummary(status: Status): StatusSummary {
    return {
      id: status.id,
      name: status.label,
      position: status.position,
      color: status.color,
    };
  }

  private mapEpicSummary(epic: Epic, agentNameById?: Map<string, string>): EpicSummary {
    const summary: EpicSummary = {
      id: epic.id,
      title: epic.title,
      description: epic.description ?? null,
      statusId: epic.statusId,
      version: epic.version,
    };

    if (epic.agentId && agentNameById) {
      const agentName = agentNameById.get(epic.agentId);
      if (agentName) {
        summary.agentName = agentName;
      }
    }

    if (epic.parentId) {
      summary.parentId = epic.parentId;
    }

    // Always include tags (empty array if none)
    summary.tags = epic.tags ?? [];

    return summary;
  }

  private mapEpicChild(epic: Epic): EpicChildSummary {
    return {
      id: epic.id,
      title: epic.title,
      statusId: epic.statusId,
    };
  }

  private mapEpicParent(epic: Epic, agentNameById: Map<string, string>): EpicParentSummary {
    return {
      id: epic.id,
      title: epic.title,
      description: epic.description ?? null,
      agentName: epic.agentId ? (agentNameById.get(epic.agentId) ?? null) : null,
    };
  }

  private mapEpicComment(comment: EpicComment): EpicCommentSummary {
    return {
      id: comment.id,
      authorName: comment.authorName,
      content: comment.content,
      createdAt: comment.createdAt,
    };
  }

  private mapDocumentSummary(document: Document): DocumentSummary {
    return {
      id: document.id,
      projectId: document.projectId,
      title: document.title,
      slug: document.slug,
      tags: document.tags,
      archived: document.archived,
      version: document.version,
      updatedAt: document.updatedAt,
    };
  }

  private mapDocumentDetail(document: Document): DocumentDetail {
    const summary = this.mapDocumentSummary(document);
    return {
      ...summary,
      contentMd: document.contentMd,
      createdAt: document.createdAt,
    };
  }

  private mapPromptSummary(prompt: StoragePromptSummary): PromptSummary {
    return {
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      contentPreview: prompt.contentPreview,
      tags: prompt.tags,
      version: prompt.version,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  }

  private mapPromptDetail(prompt: Prompt): PromptDetail {
    const PREVIEW_LENGTH = 200;
    const contentPreview =
      prompt.content.length > PREVIEW_LENGTH
        ? prompt.content.slice(0, PREVIEW_LENGTH) + '…'
        : prompt.content;

    return {
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      contentPreview,
      content: prompt.content,
      tags: prompt.tags,
      version: prompt.version,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  }

  private extractLinkSlugs(content: string): string[] {
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

  private escapeForRegex(value: string): string {
    return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  private async collectDocumentLinks(
    document: Document,
  ): Promise<{ links: DocumentLinkMeta[]; cache: Map<string, Document | null> }> {
    const cache = new Map<string, Document | null>();
    cache.set(document.slug, document);

    const slugs = this.extractLinkSlugs(document.contentMd);
    const projectId = document.projectId ?? null;
    const links: DocumentLinkMeta[] = [];

    for (const slug of slugs) {
      const linked = await this.loadDocumentBySlug(projectId, slug, cache);
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

  private async buildInlineResolution(
    document: Document,
    cache: Map<string, Document | null>,
    maxDepth: number,
    maxBytes: number,
  ): Promise<DocumentInlineResolution> {
    const effectiveDepth = Math.max(0, maxDepth);
    const path = new Set<string>([document.slug]);
    const result = await this.inlineDocumentContent(
      document.contentMd,
      document.projectId ?? null,
      0,
      { maxDepth: effectiveDepth, maxBytes },
      cache,
      path,
    );

    const limited = this.applyByteLimit(result.content, maxBytes);
    return {
      contentMd: limited.content,
      depthUsed: Math.min(result.depthUsed, effectiveDepth),
      bytes: limited.bytes,
      truncated: limited.truncated || result.truncated,
    };
  }

  private async inlineDocumentContent(
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
    const slugs = this.extractLinkSlugs(content);

    for (const slug of slugs) {
      if (depth >= options.maxDepth) {
        break;
      }
      if (path.has(slug)) {
        continue;
      }

      const linked = await this.loadDocumentBySlug(projectId, slug, cache);
      if (!linked) {
        continue;
      }

      path.add(slug);
      const childResult = await this.inlineDocumentContent(
        linked.contentMd,
        linked.projectId ?? projectId,
        depth + 1,
        options,
        cache,
        path,
      );
      path.delete(slug);

      depthUsed = Math.max(depthUsed, childResult.depthUsed);
      const snippet = this.buildInlineSnippet(linked, childResult.content, depth + 1);
      const pattern = new RegExp(`\\[\\[${this.escapeForRegex(slug)}\\]\\]`, 'g');
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

  private buildInlineSnippet(document: Document, content: string, depth: number): string {
    const headingLevel = Math.min(6, 2 + depth);
    const heading = `${'#'.repeat(headingLevel)} ${document.title || document.slug}`;
    return `\n\n---\n${heading}\n\n${content}\n---\n\n`;
  }

  private async loadDocumentBySlug(
    projectId: string | null,
    slug: string,
    cache: Map<string, Document | null>,
  ): Promise<Document | null> {
    if (cache.has(slug)) {
      return cache.get(slug) ?? null;
    }

    try {
      const linked = await this.storage.getDocument({ projectId, slug });
      cache.set(slug, linked);
      return linked;
    } catch (error) {
      cache.set(slug, null);
      return null;
    }
  }

  private applyByteLimit(
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

  private async resolveDocumentResource(uri: string): Promise<McpResponse> {
    const spec = uri.slice('doc://'.length);
    const slashIndex = spec.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`Invalid document resource URI: ${uri}`);
    }

    const projectPart = spec.slice(0, slashIndex);
    const slugPart = spec.slice(slashIndex + 1);

    const projectSlug = decodeURIComponent(projectPart);
    const documentSlug = decodeURIComponent(slugPart);

    const projectIdCandidate = await this.findProjectIdBySlug(projectSlug);
    if (projectIdCandidate === undefined) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Unknown project slug: ${projectSlug}`,
        },
      };
    }

    try {
      const document = await this.storage.getDocument({
        projectId: projectIdCandidate ?? null,
        slug: documentSlug,
      });

      return {
        success: true,
        data: {
          uri,
          mimeType: 'text/markdown',
          content: document.contentMd,
          document: this.mapDocumentDetail(document),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DOCUMENT_NOT_FOUND',
          message: `Document not found: ${documentSlug}`,
        },
      };
    }
  }

  private async resolvePromptResource(uri: string): Promise<McpResponse> {
    const spec = uri.slice('prompt://'.length);
    if (!spec) {
      throw new Error(`Invalid prompt resource URI: ${uri}`);
    }

    const atIndex = spec.lastIndexOf('@');
    const namePart = atIndex === -1 ? spec : spec.slice(0, atIndex);
    const versionPart = atIndex === -1 ? undefined : spec.slice(atIndex + 1);

    const name = decodeURIComponent(namePart).trim();
    if (!name) {
      throw new Error(`Prompt name missing in URI: ${uri}`);
    }

    let version: number | undefined;
    if (versionPart && versionPart.length > 0) {
      version = Number(versionPart);
      if (!Number.isFinite(version) || version <= 0) {
        throw new Error(`Invalid prompt version in URI: ${uri}`);
      }
    }

    const list = await this.storage.listPrompts({ projectId: null });
    const candidates = list.items.filter(
      (prompt) => prompt.title === name && (version === undefined || prompt.version === version),
    );

    const selected = candidates.find((prompt) => prompt.projectId === null) ?? candidates[0];

    if (!selected) {
      return {
        success: false,
        error: {
          code: 'PROMPT_NOT_FOUND',
          message: `Prompt not found: ${name}${version ? `@${version}` : ''}`,
        },
      };
    }

    const prompt = await this.storage.getPrompt(selected.id);

    return {
      success: true,
      data: {
        uri,
        mimeType: 'text/markdown',
        content: prompt.content,
        prompt: this.mapPromptDetail(prompt),
      },
    };
  }

  private async findProjectIdBySlug(projectSlug: string): Promise<string | null | undefined> {
    if (!projectSlug || projectSlug === 'global') {
      return null;
    }

    const projects = await this.storage.listProjects({ limit: 1000, offset: 0 });
    const match = projects.items.find(
      (project) => this.slugifyProjectName(project.name) === projectSlug,
    );

    return match?.id;
  }

  private slugifyProjectName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  // ============================================
  // Review Tools
  // ============================================

  /**
   * devchain_list_reviews
   * List reviews for the current project with optional filters.
   */
  private async listReviews(params: unknown): Promise<McpResponse> {
    const validated = ListReviewsParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    const result = await this.reviewsService.listReviews(project.id, {
      status: validated.status,
      epicId: validated.epicId,
      limit: validated.limit ?? 100,
      offset: validated.offset ?? 0,
    });

    const reviews: ReviewSummary[] = result.items.map((review) => ({
      id: review.id,
      title: review.title,
      description: review.description,
      status: review.status,
      baseRef: review.baseRef,
      headRef: review.headRef,
      baseSha: review.baseSha,
      headSha: review.headSha,
      epicId: review.epicId,
      createdBy: review.createdBy,
      createdByAgentId: review.createdByAgentId,
      version: review.version,
      commentCount: review.commentCount,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    }));

    const response: ListReviewsResponse = {
      reviews,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  }

  /**
   * devchain_get_review
   * Get a review with its changed files and comments.
   */
  private async getReview(params: unknown): Promise<McpResponse> {
    const validated = GetReviewParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    try {
      const reviewWithFiles = await this.reviewsService.getReview(validated.reviewId);

      if (reviewWithFiles.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} does not belong to this project`,
          },
        };
      }

      // Fetch comments
      const commentsResult = await this.reviewsService.listComments(validated.reviewId, {
        limit: 500,
      });

      // Resolve agent names for comments
      const agentIds = new Set<string>();
      for (const comment of commentsResult.items) {
        if (comment.authorAgentId) agentIds.add(comment.authorAgentId);
      }

      const agentNameById = new Map<string, string>();
      for (const agentId of agentIds) {
        try {
          const agent = await this.storage.getAgent(agentId);
          agentNameById.set(agentId, agent.name);
        } catch {
          // Graceful degradation
        }
      }

      const comments: ReviewCommentSummary[] = commentsResult.items.map((comment) => ({
        id: comment.id,
        filePath: comment.filePath,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        side: comment.side,
        content: comment.content,
        commentType: comment.commentType,
        status: comment.status,
        authorType: comment.authorType,
        authorAgentId: comment.authorAgentId,
        authorAgentName: comment.authorAgentId
          ? agentNameById.get(comment.authorAgentId)
          : undefined,
        parentId: comment.parentId,
        version: comment.version,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      }));

      const changedFiles: ChangedFileSummary[] = (reviewWithFiles.changedFiles ?? []).map(
        (file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          oldPath: file.oldPath,
        }),
      );

      const response: GetReviewResponse = {
        review: {
          id: reviewWithFiles.id,
          title: reviewWithFiles.title,
          description: reviewWithFiles.description,
          status: reviewWithFiles.status,
          baseRef: reviewWithFiles.baseRef,
          headRef: reviewWithFiles.headRef,
          baseSha: reviewWithFiles.baseSha,
          headSha: reviewWithFiles.headSha,
          epicId: reviewWithFiles.epicId,
          createdBy: reviewWithFiles.createdBy,
          createdByAgentId: reviewWithFiles.createdByAgentId,
          version: reviewWithFiles.version,
          createdAt: reviewWithFiles.createdAt,
          updatedAt: reviewWithFiles.updatedAt,
        },
        changedFiles,
        comments,
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} was not found`,
          },
        };
      }
      throw error;
    }
  }

  /**
   * devchain_get_review_comments
   * Get comments for a review with optional filters.
   */
  private async getReviewComments(params: unknown): Promise<McpResponse> {
    const validated = GetReviewCommentsParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    try {
      // Verify review belongs to project
      const review = await this.storage.getReview(validated.reviewId);
      if (review.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} does not belong to this project`,
          },
        };
      }

      const result = await this.reviewsService.listComments(validated.reviewId, {
        status: validated.status,
        filePath: validated.filePath,
        limit: validated.limit ?? 100,
        offset: validated.offset ?? 0,
      });

      // Resolve agent names
      const agentIds = new Set<string>();
      for (const comment of result.items) {
        if (comment.authorAgentId) agentIds.add(comment.authorAgentId);
      }

      const agentNameById = new Map<string, string>();
      for (const agentId of agentIds) {
        try {
          const agent = await this.storage.getAgent(agentId);
          agentNameById.set(agentId, agent.name);
        } catch {
          // Graceful degradation
        }
      }

      const comments: ReviewCommentSummary[] = result.items.map((comment) => ({
        id: comment.id,
        filePath: comment.filePath,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        side: comment.side,
        content: comment.content,
        commentType: comment.commentType,
        status: comment.status,
        authorType: comment.authorType,
        authorAgentId: comment.authorAgentId,
        authorAgentName: comment.authorAgentId
          ? agentNameById.get(comment.authorAgentId)
          : undefined,
        parentId: comment.parentId,
        version: comment.version,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      }));

      const response: GetReviewCommentsResponse = {
        comments,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} was not found`,
          },
        };
      }
      throw error;
    }
  }

  /**
   * devchain_reply_comment
   * Reply to a comment or create a new comment on a review.
   */
  private async replyComment(params: unknown): Promise<McpResponse> {
    const validated = ReplyCommentParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;
    const actor = getActorFromContext(ctx.data as SessionContext);

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    try {
      // Verify review belongs to project
      const review = await this.storage.getReview(validated.reviewId);
      if (review.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} does not belong to this project`,
          },
        };
      }

      const comment = await this.reviewsService.createComment(validated.reviewId, {
        parentId: validated.parentCommentId,
        content: validated.content,
        filePath: validated.filePath,
        lineStart: validated.lineStart,
        lineEnd: validated.lineEnd,
        commentType: validated.commentType ?? 'comment',
        authorType: 'agent',
        authorAgentId: actor?.id,
        targetAgentIds: validated.targetAgentIds,
      });

      const response: ReplyCommentResponse = {
        comment: {
          id: comment.id,
          filePath: comment.filePath,
          lineStart: comment.lineStart,
          lineEnd: comment.lineEnd,
          side: comment.side,
          content: comment.content,
          commentType: comment.commentType,
          status: comment.status,
          authorType: comment.authorType,
          authorAgentId: comment.authorAgentId,
          authorAgentName: actor?.name,
          parentId: comment.parentId,
          version: comment.version,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        },
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'REVIEW_NOT_FOUND',
            message: `Review ${validated.reviewId} was not found`,
          },
        };
      }
      throw error;
    }
  }

  /**
   * devchain_resolve_comment
   * Mark a comment as resolved or wont_fix.
   */
  private async resolveComment(params: unknown): Promise<McpResponse> {
    const validated = ResolveCommentParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    try {
      // Verify comment belongs to a review in this project
      const comment = await this.storage.getReviewComment(validated.commentId);
      const review = await this.storage.getReview(comment.reviewId);
      if (review.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'COMMENT_NOT_FOUND',
            message: `Comment ${validated.commentId} does not belong to this project`,
          },
        };
      }

      const updatedComment = await this.reviewsService.resolveComment(
        comment.reviewId,
        validated.commentId,
        validated.resolution,
        validated.version,
      );

      // Resolve author name if agent
      let authorAgentName: string | undefined;
      if (updatedComment.authorAgentId) {
        try {
          const agent = await this.storage.getAgent(updatedComment.authorAgentId);
          authorAgentName = agent.name;
        } catch {
          // Graceful degradation
        }
      }

      const response: ResolveCommentResponse = {
        comment: {
          id: updatedComment.id,
          filePath: updatedComment.filePath,
          lineStart: updatedComment.lineStart,
          lineEnd: updatedComment.lineEnd,
          side: updatedComment.side,
          content: updatedComment.content,
          commentType: updatedComment.commentType,
          status: updatedComment.status,
          authorType: updatedComment.authorType,
          authorAgentId: updatedComment.authorAgentId,
          authorAgentName,
          parentId: updatedComment.parentId,
          version: updatedComment.version,
          createdAt: updatedComment.createdAt,
          updatedAt: updatedComment.updatedAt,
        },
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'COMMENT_NOT_FOUND',
            message: `Comment ${validated.commentId} was not found`,
          },
        };
      }
      throw error;
    }
  }

  /**
   * devchain_apply_suggestion
   * Apply a code suggestion from a comment to the file.
   * Extracts the suggestion block, applies it to the specified lines, and resolves the comment.
   */
  private async applySuggestion(params: unknown): Promise<McpResponse> {
    const validated = ApplySuggestionParamsSchema.parse(params);

    const ctx = await this.resolveSessionContext(validated.sessionId);
    if (!ctx.success) return ctx;
    const { project } = ctx.data as SessionContext;

    if (!project) {
      return {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'No project associated with this session',
        },
      };
    }

    if (!this.reviewsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }

    try {
      // Get the comment
      const comment = await this.storage.getReviewComment(validated.commentId);
      const review = await this.storage.getReview(comment.reviewId);

      if (review.projectId !== project.id) {
        return {
          success: false,
          error: {
            code: 'COMMENT_NOT_FOUND',
            message: `Comment ${validated.commentId} does not belong to this project`,
          },
        };
      }

      // Verify comment has file path and line info
      if (!comment.filePath || comment.lineStart === null) {
        return {
          success: false,
          error: {
            code: 'INVALID_SUGGESTION',
            message: 'Comment does not have file path or line information',
          },
        };
      }

      // Extract suggestion from comment content
      const suggestionMatch = comment.content.match(/```suggestion\s*\n([\s\S]*?)```/);
      if (!suggestionMatch) {
        return {
          success: false,
          error: {
            code: 'NO_SUGGESTION',
            message: 'Comment does not contain a suggestion block',
          },
        };
      }

      const suggestedCode = suggestionMatch[1].trimEnd();
      const lineStart = comment.lineStart;
      const lineEnd = comment.lineEnd ?? comment.lineStart;

      // SECURITY: Validate file path to prevent path traversal attacks
      // This rejects paths containing '..', absolute paths, and paths escaping project root
      let validatedPath;
      try {
        validatedPath = validatePathWithinRoot(project.rootPath, comment.filePath, {
          errorPrefix: 'Invalid file path in comment',
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: {
              code: 'PATH_TRAVERSAL_BLOCKED',
              message: error.message,
              data: error.details,
            },
          };
        }
        throw error;
      }

      // SECURITY: Validate symlinks don't escape the project root
      // This resolves the actual path after following symlinks
      let realFilePath: string;
      try {
        realFilePath = await validateResolvedPathWithinRoot(
          validatedPath.absolutePath,
          project.rootPath,
          { errorPrefix: 'Symlink validation failed' },
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: {
              code: 'SYMLINK_ESCAPE_BLOCKED',
              message: error.message,
              data: error.details,
            },
          };
        }
        throw error;
      }

      // Read the file, apply the suggestion, and write it back
      const fs = await import('fs/promises');
      const filePath = realFilePath;

      const fileContent = await fs.readFile(filePath, 'utf-8');
      const lines = fileContent.split('\n');

      // SECURITY: Validate line bounds to prevent out-of-bounds access
      try {
        validateLineBounds(lineStart, lineEnd, lines.length);
      } catch (error) {
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: {
              code: 'INVALID_LINE_BOUNDS',
              message: error.message,
              data: error.details,
            },
          };
        }
        throw error;
      }

      // Replace the lines with the suggestion
      const suggestedLines = suggestedCode.split('\n');
      lines.splice(lineStart - 1, lineEnd - lineStart + 1, ...suggestedLines);

      await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

      // Auto-resolve the comment
      const updatedComment = await this.reviewsService.resolveComment(
        comment.reviewId,
        validated.commentId,
        'resolved',
        validated.version,
      );

      // Resolve author name if agent
      let authorAgentName: string | undefined;
      if (updatedComment.authorAgentId) {
        try {
          const agent = await this.storage.getAgent(updatedComment.authorAgentId);
          authorAgentName = agent.name;
        } catch {
          // Graceful degradation
        }
      }

      const response: ApplySuggestionResponse = {
        comment: {
          id: updatedComment.id,
          filePath: updatedComment.filePath,
          lineStart: updatedComment.lineStart,
          lineEnd: updatedComment.lineEnd,
          side: updatedComment.side,
          content: updatedComment.content,
          commentType: updatedComment.commentType,
          status: updatedComment.status,
          authorType: updatedComment.authorType,
          authorAgentId: updatedComment.authorAgentId,
          authorAgentName,
          parentId: updatedComment.parentId,
          version: updatedComment.version,
          createdAt: updatedComment.createdAt,
          updatedAt: updatedComment.updatedAt,
        },
        applied: {
          filePath: comment.filePath,
          lineStart,
          lineEnd,
          suggestedCode,
        },
      };

      return { success: true, data: response };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return {
          success: false,
          error: {
            code: 'COMMENT_NOT_FOUND',
            message: `Comment ${validated.commentId} was not found`,
          },
        };
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          success: false,
          error: {
            code: 'FILE_NOT_FOUND',
            message: `File not found at path`,
          },
        };
      }
      throw error;
    }
  }
}
