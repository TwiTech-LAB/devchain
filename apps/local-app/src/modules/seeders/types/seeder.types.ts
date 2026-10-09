import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  StorageService,
  ProjectStorage,
  SkillSourceStorage,
  SubscriberStorage,
  WatcherStorage,
} from '../../storage/interfaces/storage.interface';
import type { WatchersService } from '../../watchers/services/watchers.service';
import type { ProviderEffortSeedingService } from '../../providers/services/provider-effort-seeding.service';
import type { createLogger } from '../../../common/logging/logger';

export interface SeederContext {
  storage: ProjectStorage &
    SkillSourceStorage &
    SubscriberStorage &
    WatcherStorage &
    Pick<
      StorageService,
      'listEnvScopesByProviderIds' | 'listProviders' | 'updateProvider' | 'updateProviderWithScopes'
    >;
  watchersService: WatchersService;
  providerEffortSeeding: ProviderEffortSeedingService;
  db: BetterSQLite3Database;
  logger: ReturnType<typeof createLogger>;
}

export interface DataSeeder {
  name: string;
  version: number;
  run: (ctx: SeederContext) => Promise<void>;
}
