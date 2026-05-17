import { Module } from '@nestjs/common';
import { OrchestratorDockerService } from './services/docker.service';
import { SeedPreparationService } from './services/seed-preparation.service';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [ProcessExecutorModule],
  providers: [OrchestratorDockerService, SeedPreparationService],
  exports: [OrchestratorDockerService, SeedPreparationService],
})
export class OrchestratorDockerModule {}
