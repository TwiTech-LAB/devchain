import type { PromptStorage } from '../../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type PromptToolStorage = PromptStorage;

export interface PromptToolContext {
  storage: PromptToolStorage;
  teamsService: TeamsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
