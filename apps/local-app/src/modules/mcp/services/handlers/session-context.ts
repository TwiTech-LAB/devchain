import type { AgentStorage, ProjectStorage } from '../../../storage/interfaces/storage.interface';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { GuestsService } from '../../../guests/services/guests.service';

export type SessionToolStorage = AgentStorage & ProjectStorage;

export interface SessionToolContext {
  storage: SessionToolStorage;
  sessionsService: SessionsService;
  guestsService: GuestsService;
}
