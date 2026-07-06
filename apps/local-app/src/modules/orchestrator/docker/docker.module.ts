import { Module } from '@nestjs/common';
import { OrchestratorDockerService } from './services/docker.service';
import { WorktreeMountDiscoveryService } from './services/worktree-mount-discovery.service';
import { SeedPreparationService } from './services/seed-preparation.service';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [ProcessExecutorModule],
  providers: [WorktreeMountDiscoveryService, OrchestratorDockerService, SeedPreparationService],
  exports: [OrchestratorDockerService, SeedPreparationService],
})
export class OrchestratorDockerModule {}
