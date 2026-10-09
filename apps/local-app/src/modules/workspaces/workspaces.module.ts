import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WorkspacesController } from './controllers/workspaces.controller';
import { WorkspacesService } from './services/workspaces.service';
import { WorkspaceModeCoordinatorService } from './services/workspace-mode-coordinator.service';

@Module({
  imports: [StorageModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceModeCoordinatorService],
  exports: [WorkspaceModeCoordinatorService],
})
export class WorkspacesModule {}
