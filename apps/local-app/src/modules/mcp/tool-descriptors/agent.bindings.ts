import type { ToolBindingEntry } from './types';
import {
  handleListAgents,
  handleGetAgentByName,
  handleListStatuses,
} from '../services/handlers/agent-tools';

export const agentBindings: ToolBindingEntry[] = [
  ['devchain_list_agents', handleListAgents as unknown as ToolBindingEntry[1]],
  ['devchain_get_agent_by_name', handleGetAgentByName as unknown as ToolBindingEntry[1]],
  ['devchain_list_statuses', handleListStatuses as unknown as ToolBindingEntry[1]],
];
