import { Module } from '@nestjs/common';
import { orchestratorDbProvider, ORCHESTRATOR_DB_CONNECTION } from './db/orchestrator.provider';
import { DbModule } from '../../storage/db/db.module';

@Module({
  imports: [DbModule],
  providers: [orchestratorDbProvider],
  exports: [ORCHESTRATOR_DB_CONNECTION],
})
export class OrchestratorStorageModule {}
