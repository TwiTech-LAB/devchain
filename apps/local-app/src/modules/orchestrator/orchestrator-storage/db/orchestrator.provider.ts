import { Provider } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../../storage/db/db.provider';

export const ORCHESTRATOR_DB_CONNECTION = 'ORCHESTRATOR_DB_CONNECTION';

export type OrchestratorDatabase = BetterSQLite3Database;

export const orchestratorDbProvider: Provider = {
  provide: ORCHESTRATOR_DB_CONNECTION,
  useExisting: DB_CONNECTION,
};
