import type {
  AgentStorage,
  GuestStorage,
  StatusStorage,
} from '../../../storage/interfaces/storage.interface';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import type { InstructionsResolver } from '../instructions-resolver';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type AgentToolStorage = AgentStorage & GuestStorage & StatusStorage;

export interface AgentToolContext {
  storage: AgentToolStorage;
  sessionsService: SessionsService;
  terminalIO: TerminalIOService;
  instructionsResolver: InstructionsResolver;
  teamsService: TeamsService;
  defaultInlineMaxBytes: number;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
