import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { ChatService } from '../../../chat/services/chat.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { SessionsMessagePoolService } from '../../../sessions/services/sessions-message-pool.service';
import type { TerminalGateway } from '../../../terminal/gateways/terminal.gateway';
import type { TmuxService } from '../../../terminal/services/tmux.service';
import type { EpicsService } from '../../../epics/services/epics.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import type { GuestsService } from '../../../guests/services/guests.service';
import type { ReviewsService } from '../../../reviews/services/reviews.service';
import type { SkillsService } from '../../../skills/services/skills.service';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { InstructionsResolver } from '../instructions-resolver';
import type { FeatureFlagConfig } from '../../../../common/config/feature-flags';
import type { McpResponse, SessionContext } from '../../dtos/mcp.dto';

/**
 * Shared execution context for extracted MCP tool handlers.
 * Services are optional except storage so handlers can depend only on what they need.
 */
export interface McpToolContext {
  storage: StorageService;
  chatService?: ChatService;
  sessionsService?: SessionsService;
  messagePoolService?: SessionsMessagePoolService;
  terminalGateway?: TerminalGateway;
  tmuxService?: TmuxService;
  epicsService?: EpicsService;
  settingsService?: SettingsService;
  guestsService?: GuestsService;
  skillsService?: SkillsService;
  reviewsService?: ReviewsService;
  teamsService?: TeamsService;
  sessionContext?: SessionContext;
  instructionsResolver?: InstructionsResolver;
  featureFlags?: FeatureFlagConfig;
  defaultInlineMaxBytes?: number;
  resolveSessionContext?: (sessionId: string) => Promise<McpResponse>;
}

/**
 * Matches current McpService handler parameter/return shape:
 * - params: unknown (validated inside each tool handler)
 * - return: Promise<McpResponse>
 */
export type McpToolHandler<TParams = unknown> = (
  ctx: McpToolContext,
  params: TParams,
) => Promise<McpResponse>;
