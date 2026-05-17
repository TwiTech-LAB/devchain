import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { WatchersService } from '../../watchers/services/watchers.service';
import type { createLogger } from '../../../common/logging/logger';

export interface SeederContext {
  storage: StorageService;
  watchersService: WatchersService;
  db: BetterSQLite3Database;
  logger: ReturnType<typeof createLogger>;
}

export interface DataSeeder {
  name: string;
  version: number;
  run: (ctx: SeederContext) => Promise<void>;
}
