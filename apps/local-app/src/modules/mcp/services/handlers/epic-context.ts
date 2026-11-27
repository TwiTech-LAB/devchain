import type {
  EpicStorage,
  StatusStorage,
  AgentStorage,
  WorktreeStorage,
  IntegrationStorage,
} from '../../../storage/interfaces/storage.interface';
import type { EpicsService } from '../../../epics/services/epics.service';
import type { EpicRelationsService } from '../../../epics/services/epic-relations.service';
import type { McpResponse } from '../../dtos/mcp.dto';
import type { ExternalTaskReadDeps } from './external-task-resolution';

export type EpicToolStorage = EpicStorage &
  StatusStorage &
  AgentStorage &
  WorktreeStorage &
  Pick<IntegrationStorage, 'listExternalTaskLinksForEpic'>;

export interface EpicToolContext extends ExternalTaskReadDeps {
  storage: EpicToolStorage;
  epicsService: EpicsService;
  epicRelationsService?: EpicRelationsService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
