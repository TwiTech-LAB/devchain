import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WorkspacesController } from './controllers/workspaces.controller';
import { WorkspacesService } from './services/workspaces.service';
import { WorkspaceModeCoordinatorService } from './services/workspace-mode-coordinator.service';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [StorageModule, ProjectWriteAdmissionModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceModeCoordinatorService],
  exports: [WorkspaceModeCoordinatorService],
})
export class WorkspacesModule {}
