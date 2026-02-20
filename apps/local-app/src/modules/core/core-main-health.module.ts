import { Global, Module } from '@nestjs/common';
import { HEALTH_READINESS_CHECKER } from './services/health.service';
import { MainReadinessCheckerService } from './services/main-readiness-checker.service';
import { OrchestratorStorageModule } from '../orchestrator/orchestrator-storage/orchestrator-storage.module';
import { OrchestratorDockerModule } from '../orchestrator/docker/docker.module';

@Global()
@Module({
  imports: [OrchestratorStorageModule, OrchestratorDockerModule],
  providers: [
    MainReadinessCheckerService,
    {
      provide: HEALTH_READINESS_CHECKER,
      useExisting: MainReadinessCheckerService,
    },
  ],
  exports: [HEALTH_READINESS_CHECKER],
})
export class CoreMainHealthModule {}
