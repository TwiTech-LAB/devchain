import type {
  EpicStorage,
  StatusStorage,
  AgentStorage,
} from '../../../storage/interfaces/storage.interface';
import type { EpicsService } from '../../../epics/services/epics.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type EpicToolStorage = EpicStorage & StatusStorage & AgentStorage;

export interface EpicToolContext {
  storage: EpicToolStorage;
  epicsService: EpicsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
