import { Module } from '@nestjs/common';
import { OrchestratorDockerService } from './services/docker.service';
import { SeedPreparationService } from './services/seed-preparation.service';

@Module({
  providers: [OrchestratorDockerService, SeedPreparationService],
  exports: [OrchestratorDockerService, SeedPreparationService],
})
export class OrchestratorDockerModule {}
