import type {
  AgentStorage,
  AgentProfileStorage,
  ProfileProviderConfigStorage,
} from '../../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type TeamsToolStorage = AgentStorage & AgentProfileStorage & ProfileProviderConfigStorage;

export interface TeamsToolContext {
  storage: TeamsToolStorage;
  teamsService: TeamsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
