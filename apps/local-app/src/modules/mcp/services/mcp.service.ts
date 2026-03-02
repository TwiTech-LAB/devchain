import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ChatService } from '../../chat/services/chat.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EpicsService } from '../../epics/services/epics.service';
import { SettingsService } from '../../settings/services/settings.service';
import { GuestsService } from '../../guests/services/guests.service';
import { ReviewsService } from '../../reviews/services/reviews.service';
import { SkillsService } from '../../skills/services/skills.service';
import { createLogger } from '../../../common/logging/logger';
import type { McpResponse } from '../dtos/mcp.dto';
import { InstructionsResolver } from './instructions-resolver';
import type { FeatureFlagConfig } from '../../../common/config/feature-flags';
import { ZodError, ZodIssue } from 'zod';
import { buildInlineResolution } from './utils/document-link-resolver';
import type { McpToolContext, McpToolHandler } from './handlers/types';
import {
  handleListAgents,
  handleGetAgentByName,
  handleListStatuses,
  handleListEpics,
  handleListAssignedEpicsTasks,
  handleCreateEpic,
  handleGetEpicById,
  handleAddEpicComment,
  handleUpdateEpic,
} from './handlers/epic-tools';
import {
  handleSendMessage,
  handleChatAck,
  handleChatListMembers,
  handleChatReadHistory,
} from './handlers/chat-tools';
import { handleActivityStart, handleActivityFinish } from './handlers/activity-tools';
import {
  handleCreateRecord,
  handleUpdateRecord,
  handleGetRecord,
  handleListRecords,
  handleAddTags,
  handleRemoveTags,
} from './handlers/record-tools';
import {
  handleListDocuments,
  handleGetDocument,
  handleCreateDocument,
  handleUpdateDocument,
} from './handlers/document-tools';
import { handleListPrompts, handleGetPrompt } from './handlers/prompt-tools';
import { handleListSkills, handleGetSkill } from './handlers/skill-tools';
import { handleListSessions, handleRegisterGuest } from './handlers/session-tools';
import {
  handleListReviews,
  handleGetReview,
  handleGetReviewComments,
  handleReplyComment,
  handleResolveComment,
  handleApplySuggestion,
} from './handlers/review-tools';
import { suggestNestedPath } from '../utils/param-suggestion';
import { SessionContextResolver } from './utils/session-context-resolver';
import { ResourceResolver } from './utils/resource-resolver';

const logger = createLogger('McpService');

function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

function redactParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const obj = params as Record<string, unknown>;
  if ('sessionId' in obj && typeof obj.sessionId === 'string') {
    return { ...obj, sessionId: redactSessionId(obj.sessionId) };
  }
  return params;
}

const TOOL_HANDLER_ENTRIES: Array<[string, McpToolHandler]> = [
  ['devchain_create_record', handleCreateRecord],
  ['devchain_update_record', handleUpdateRecord],
  ['devchain_get_record', handleGetRecord],
  ['devchain_list_records', handleListRecords],
  ['devchain_add_tags', handleAddTags],
  ['devchain_remove_tags', handleRemoveTags],
  ['devchain_list_documents', handleListDocuments],
  ['devchain_get_document', handleGetDocument],
  ['devchain_create_document', handleCreateDocument],
  ['devchain_update_document', handleUpdateDocument],
  ['devchain_list_prompts', handleListPrompts],
  ['devchain_get_prompt', handleGetPrompt],
  ['devchain_list_skills', handleListSkills],
  ['devchain_get_skill', handleGetSkill],
  ['devchain_list_agents', handleListAgents],
  ['devchain_get_agent_by_name', handleGetAgentByName],
  ['devchain_list_statuses', handleListStatuses],
  ['devchain_list_epics', handleListEpics],
  ['devchain_list_assigned_epics_tasks', handleListAssignedEpicsTasks],
  ['devchain_create_epic', handleCreateEpic],
  ['devchain_get_epic_by_id', handleGetEpicById],
  ['devchain_add_epic_comment', handleAddEpicComment],
  ['devchain_update_epic', handleUpdateEpic],
  ['devchain_send_message', handleSendMessage],
  ['devchain_chat_ack', handleChatAck],
  ['devchain_chat_list_members', handleChatListMembers],
  ['devchain_chat_read_history', handleChatReadHistory],
  ['devchain_activity_start', handleActivityStart],
  ['devchain_activity_finish', handleActivityFinish],
  ['devchain_list_sessions', handleListSessions],
  ['devchain_register_guest', handleRegisterGuest],
  ['devchain_list_reviews', handleListReviews],
  ['devchain_get_review', handleGetReview],
  ['devchain_get_review_comments', handleGetReviewComments],
  ['devchain_reply_comment', handleReplyComment],
  ['devchain_resolve_comment', handleResolveComment],
  ['devchain_apply_suggestion', handleApplySuggestion],
];

@Injectable()
export class McpService {
  private readonly instructionsResolver: InstructionsResolver;
  private readonly featureFlags: FeatureFlagConfig;
  private readonly sessionContextResolver: SessionContextResolver;
  private readonly resourceResolver: ResourceResolver;
  private readonly toolHandlers: Map<string, McpToolHandler>;
  private readonly DEFAULT_INLINE_MAX_BYTES = 64 * 1024;

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
    @Inject(forwardRef(() => SkillsService)) private readonly skillsService?: SkillsService,
    @Inject(forwardRef(() => ReviewsService)) private readonly reviewsService?: ReviewsService,
  ) {
    logger.info('McpService initialized');
    this.featureFlags = this.storage.getFeatureFlags();
    this.instructionsResolver = new InstructionsResolver(
      this.storage,
      (document, cache, maxDepth, maxBytes) =>
        buildInlineResolution(this.storage, document, cache, maxDepth, maxBytes),
      this.featureFlags,
    );
    this.sessionContextResolver = new SessionContextResolver(
      this.storage,
      this.sessionsService,
      this.guestsService,
      this.tmuxService,
    );
    this.resourceResolver = new ResourceResolver(this.storage);
    this.toolHandlers = new Map<string, McpToolHandler>(TOOL_HANDLER_ENTRIES);
  }

  private buildHandlerContext(): McpToolContext {
    return {
      storage: this.storage,
      chatService: this.chatService,
      sessionsService: this.sessionsService,
      messagePoolService: this.messagePoolService,
      terminalGateway: this.terminalGateway,
      tmuxService: this.tmuxService,
      epicsService: this.epicsService,
      settingsService: this.settingsService,
      guestsService: this.guestsService,
      skillsService: this.skillsService,
      reviewsService: this.reviewsService,
      instructionsResolver: this.instructionsResolver,
      featureFlags: this.featureFlags,
      defaultInlineMaxBytes: this.DEFAULT_INLINE_MAX_BYTES,
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  async handleToolCall(tool: string, params: unknown): Promise<McpResponse> {
    const normalizedParams = params ?? {};
    const normalizedTool = tool.replace(/[.\-/]/g, '_');

    try {
      logger.info(
        { tool: normalizedTool, originalTool: tool, params: redactParams(normalizedParams) },
        'Handling MCP tool call',
      );

      if (normalizedTool === 'notifications_initialized') {
        return { success: true, data: { acknowledged: true } };
      }

      const handler = this.toolHandlers.get(normalizedTool);
      if (!handler) {
        logger.warn({ tool: normalizedTool }, 'Unknown MCP tool');
        return {
          success: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${tool}`,
          },
        };
      }

      return await handler(this.buildHandlerContext(), normalizedParams);
    } catch (error) {
      logger.error({ tool, error }, 'MCP tool call failed');
      if (error instanceof ZodError) {
        const suggestions: string[] = [];
        for (const issue of error.issues) {
          if (issue.code !== 'unrecognized_keys') continue;
          const unknownKeys = (issue as ZodIssue & { keys: string[] }).keys;
          for (const key of unknownKeys) {
            const suggestion = suggestNestedPath(key, normalizedTool);
            if (suggestion) suggestions.push(suggestion);
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

  async handleResourceRequest(uri: string): Promise<McpResponse> {
    try {
      logger.info({ uri }, 'Handling MCP resource request');
      return await this.resourceResolver.resolve(uri);
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

  async resolveSessionContext(sessionId: string): Promise<McpResponse> {
    return this.sessionContextResolver.resolve(sessionId);
  }
}
