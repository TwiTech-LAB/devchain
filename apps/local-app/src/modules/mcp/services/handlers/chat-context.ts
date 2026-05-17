import type { AgentStorage, GuestStorage } from '../../../storage/interfaces/storage.interface';
import type { ChatService } from '../../../chat/services/chat.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type ChatToolStorage = AgentStorage & GuestStorage;

export interface ChatToolContext {
  storage: ChatToolStorage;
  chatService: ChatService;
  sessionsService: SessionsService;
  teamsService: TeamsService;
  agentMessageDelivery: AgentMessageDeliveryService;
  settingsService: SettingsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
