import type { AgentStorage, GuestStorage } from '../../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import type { McpResponse } from '../../dtos/mcp.dto';
import type { ProjectCommunicationService } from '../../../project-communication/project-communication.service';
import type { ProjectWriteAdmissionService } from '../../../remotes/admission/project-write-admission.service';

export type ChatToolStorage = AgentStorage & GuestStorage;

export interface ChatToolContext {
  storage: ChatToolStorage;
  teamsService: TeamsService;
  agentMessageDelivery: AgentMessageDeliveryService;
  settingsService: SettingsService;
  projectCommunicationService: ProjectCommunicationService;
  /** Absent in standalone MCP mode, which has no project writes to refuse. */
  projectWriteAdmission?: Pick<ProjectWriteAdmissionService, 'assertWritable'>;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
