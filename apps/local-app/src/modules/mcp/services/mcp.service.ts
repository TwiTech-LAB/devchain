import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ChatService } from '../../chat/services/chat.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { EpicsService } from '../../epics/services/epics.service';
import { SettingsService } from '../../settings/services/settings.service';
import { GuestsService } from '../../guests/services/guests.service';
import { ReviewsService } from '../../reviews/services/reviews.service';
import { ReviewSuggestionApplier } from '../../reviews/services/review-suggestion-applier.service';
import { SkillsService } from '../../skills/services/skills.service';
import { TeamsService } from '../../teams/services/teams.service';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { createLogger } from '../../../common/logging/logger';
import type { McpResponse } from '../dtos/mcp.dto';
import { InstructionsResolver } from './instructions-resolver';
import type { FeatureFlagConfig } from '../../../common/config/feature-flags';
import { ZodError, ZodIssue } from 'zod';
import { buildInlineResolution } from './utils/document-link-resolver';
import type { McpToolHandler } from './handlers/types';
import type { ChatToolContext } from './handlers/chat-context';
import type { EpicToolContext } from './handlers/epic-context';
import type { ReviewToolContext } from './handlers/review-context';
import type { TeamsToolContext } from './handlers/teams-context';
import type { RecordToolContext } from './handlers/record-context';
import type { DocumentToolContext } from './handlers/document-context';
import type { PromptToolContext } from './handlers/prompt-context';
import type { SkillToolContext } from './handlers/skill-context';
import type { SessionToolContext } from './handlers/session-context';
import type { ActivityToolContext } from './handlers/activity-context';
import type { AgentToolContext } from './handlers/agent-context';
import { allBindings, allMetadata, type ToolMetadataEntry } from '../tool-descriptors';
import { suggestNestedPath } from '../utils/param-suggestion';
import { SessionContextResolver } from './utils/session-context-resolver';
import { ResourceResolver } from './utils/resource-resolver';
import { redactParams } from './utils/redact';
import { createNullAdapter } from './handlers/null-adapter';

const logger = createLogger('McpService');

const CHAT_TOOLS = new Set([
  'devchain_send_message',
  'devchain_chat_ack',
  'devchain_chat_read_history',
  'devchain_chat_list_members',
]);

const EPIC_TOOLS = new Set([
  'devchain_list_epics',
  'devchain_list_assigned_epics_tasks',
  'devchain_create_epic',
  'devchain_get_epic_by_id',
  'devchain_add_epic_comment',
  'devchain_update_epic',
  'devchain_delete_epic',
]);

const REVIEW_TOOLS = new Set([
  'devchain_list_reviews',
  'devchain_get_review',
  'devchain_get_review_comments',
  'devchain_reply_comment',
  'devchain_resolve_comment',
  'devchain_apply_suggestion',
]);

const TEAMS_TOOLS = new Set([
  'devchain_teams_list',
  'devchain_teams_members_list',
  'devchain_teams_configs_list',
  'devchain_teams_create_agent',
  'devchain_teams_delete_agent',
  'devchain_team',
]);

const RECORD_TOOLS = new Set([
  'devchain_create_record',
  'devchain_update_record',
  'devchain_get_record',
  'devchain_list_records',
  'devchain_add_tags',
  'devchain_remove_tags',
]);

const DOCUMENT_TOOLS = new Set([
  'devchain_list_documents',
  'devchain_get_document',
  'devchain_create_document',
  'devchain_update_document',
]);

const PROMPT_TOOLS = new Set(['devchain_list_prompts', 'devchain_get_prompt']);

const SKILL_TOOLS = new Set(['devchain_list_skills', 'devchain_get_skill']);

const SESSION_TOOLS = new Set(['devchain_list_sessions', 'devchain_register_guest']);

const ACTIVITY_TOOLS = new Set(['devchain_activity_start', 'devchain_activity_finish']);

const AGENT_TOOLS = new Set([
  'devchain_list_agents',
  'devchain_get_agent_by_name',
  'devchain_list_statuses',
]);

@Injectable()
export class McpService {
  private readonly instructionsResolver: InstructionsResolver;
  private readonly featureFlags: FeatureFlagConfig;
  private readonly sessionContextResolver: SessionContextResolver;
  private readonly resourceResolver: ResourceResolver;
  private readonly toolHandlers: Map<string, McpToolHandler>;
  private readonly toolMetadata: Map<string, ToolMetadataEntry>;
  private readonly DEFAULT_INLINE_MAX_BYTES = 64 * 1024;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Optional() @Inject(forwardRef(() => ChatService)) private readonly chatService?: ChatService,
    @Optional()
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService?: SessionsService,
    @Optional() @Inject(REALTIME_BROADCASTER) private readonly broadcaster?: RealtimeBroadcaster,
    @Optional()
    @Inject(forwardRef(() => EpicsService))
    private readonly epicsService?: EpicsService,
    @Optional()
    @Inject(forwardRef(() => SettingsService))
    private readonly settingsService?: SettingsService,
    @Optional()
    @Inject(forwardRef(() => GuestsService))
    private readonly guestsService?: GuestsService,
    @Optional()
    @Inject(forwardRef(() => SkillsService))
    private readonly skillsService?: SkillsService,
    @Optional()
    @Inject(forwardRef(() => ReviewsService))
    private readonly reviewsService?: ReviewsService,
    @Optional()
    @Inject(forwardRef(() => ReviewSuggestionApplier))
    private readonly reviewSuggestionApplier?: ReviewSuggestionApplier,
    @Optional()
    @Inject(forwardRef(() => TeamsService))
    private readonly teamsService?: TeamsService,
    @Optional() private readonly terminalIO?: TerminalIOService,
    @Optional()
    @Inject(forwardRef(() => AgentMessageDeliveryService))
    private readonly agentMessageDelivery?: AgentMessageDeliveryService,
  ) {
    logger.info('McpService initialized');
    this.featureFlags = this.storage.getFeatureFlags();
    this.instructionsResolver = new InstructionsResolver(
      this.storage,
      (document, cache, maxDepth, maxBytes) =>
        buildInlineResolution(this.storage, document, cache, maxDepth, maxBytes),
    );
    this.sessionContextResolver = new SessionContextResolver(
      this.storage,
      this.sessionsService,
      this.guestsService,
      this.terminalIO,
    );
    this.resourceResolver = new ResourceResolver(this.storage);
    this.toolHandlers = new Map<string, McpToolHandler>(allBindings);
    this.toolMetadata = new Map(allMetadata.map((m) => [m.name, m]));
  }

  private buildChatToolContext(): ChatToolContext {
    return {
      storage: this.storage,
      chatService: this.chatService ?? createNullAdapter<ChatService>('ChatService'),
      sessionsService:
        this.sessionsService ?? createNullAdapter<SessionsService>('SessionsService'),
      teamsService: this.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
      agentMessageDelivery:
        this.agentMessageDelivery ??
        createNullAdapter<AgentMessageDeliveryService>('AgentMessageDeliveryService'),
      settingsService:
        this.settingsService ?? createNullAdapter<SettingsService>('SettingsService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildEpicToolContext(): EpicToolContext {
    return {
      storage: this.storage,
      epicsService: this.epicsService ?? createNullAdapter<EpicsService>('EpicsService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildReviewToolContext(): ReviewToolContext {
    return {
      storage: this.storage,
      reviewsService: this.reviewsService ?? createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        this.reviewSuggestionApplier ??
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildTeamsToolContext(): TeamsToolContext {
    return {
      storage: this.storage,
      teamsService: this.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildRecordToolContext(): RecordToolContext {
    return {
      storage: this.storage,
    };
  }

  private buildDocumentToolContext(): DocumentToolContext {
    return {
      storage: this.storage,
      defaultInlineMaxBytes: this.DEFAULT_INLINE_MAX_BYTES,
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildPromptToolContext(): PromptToolContext {
    return {
      storage: this.storage,
      teamsService: this.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildSkillToolContext(): SkillToolContext {
    return {
      skillsService: this.skillsService ?? createNullAdapter<SkillsService>('SkillsService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildSessionToolContext(): SessionToolContext {
    return {
      storage: this.storage,
      sessionsService:
        this.sessionsService ?? createNullAdapter<SessionsService>('SessionsService'),
      guestsService: this.guestsService ?? createNullAdapter<GuestsService>('GuestsService'),
    };
  }

  private buildActivityToolContext(): ActivityToolContext {
    return {
      chatService: this.chatService ?? createNullAdapter<ChatService>('ChatService'),
      resolveSessionContext: (sessionId: string) => this.resolveSessionContext(sessionId),
    };
  }

  private buildAgentToolContext(): AgentToolContext {
    return {
      storage: this.storage,
      sessionsService:
        this.sessionsService ?? createNullAdapter<SessionsService>('SessionsService'),
      terminalIO: this.terminalIO ?? createNullAdapter<TerminalIOService>('TerminalIOService'),
      instructionsResolver:
        this.instructionsResolver ??
        (createNullAdapter<InstructionsResolver>(
          'InstructionsResolver',
        ) as unknown as InstructionsResolver),
      teamsService: this.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
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

      const metadata = this.toolMetadata.get(normalizedTool);
      const parsed = metadata?.paramsSchema
        ? metadata.paramsSchema.parse(normalizedParams)
        : normalizedParams;

      return await handler(
        CHAT_TOOLS.has(normalizedTool)
          ? this.buildChatToolContext()
          : EPIC_TOOLS.has(normalizedTool)
            ? this.buildEpicToolContext()
            : REVIEW_TOOLS.has(normalizedTool)
              ? this.buildReviewToolContext()
              : TEAMS_TOOLS.has(normalizedTool)
                ? this.buildTeamsToolContext()
                : RECORD_TOOLS.has(normalizedTool)
                  ? this.buildRecordToolContext()
                  : DOCUMENT_TOOLS.has(normalizedTool)
                    ? this.buildDocumentToolContext()
                    : PROMPT_TOOLS.has(normalizedTool)
                      ? this.buildPromptToolContext()
                      : SKILL_TOOLS.has(normalizedTool)
                        ? this.buildSkillToolContext()
                        : SESSION_TOOLS.has(normalizedTool)
                          ? this.buildSessionToolContext()
                          : ACTIVITY_TOOLS.has(normalizedTool)
                            ? this.buildActivityToolContext()
                            : AGENT_TOOLS.has(normalizedTool)
                              ? this.buildAgentToolContext()
                              : {
                                  success: false,
                                  error: {
                                    code: 'UNKNOWN_TOOL',
                                    message: `Unknown tool: ${tool}`,
                                  },
                                },
        parsed,
      );
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
