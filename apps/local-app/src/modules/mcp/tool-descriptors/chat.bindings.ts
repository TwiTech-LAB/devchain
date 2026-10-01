import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { ProjectCommunicationService } from '../../project-communication/project-communication.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { TeamsService } from '../../teams/services/teams.service';
import type { ChatToolContext } from '../services/handlers/chat-context';
import { handleSendMessage } from '../services/handlers/chat-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createChatContext(runtime: McpBindingRuntime): ChatToolContext {
  return {
    storage: runtime.storage,
    teamsService: runtime.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
    agentMessageDelivery:
      runtime.agentMessageDelivery ??
      createNullAdapter<AgentMessageDeliveryService>('AgentMessageDeliveryService'),
    settingsService:
      runtime.settingsService ?? createNullAdapter<SettingsService>('SettingsService'),
    projectCommunicationService:
      runtime.projectCommunicationService ??
      createNullAdapter<ProjectCommunicationService>('ProjectCommunicationService'),
    projectWriteAdmission: runtime.projectWriteAdmission,
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const chatBindings = defineToolGroup<ChatToolContext>(createChatContext, [
  ['devchain_send_message', handleSendMessage],
]);
