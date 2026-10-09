import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/error-types';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import type {
  DeleteProjectWorkspaceResult,
  ProjectWorkspace,
} from '../../storage/models/domain.models';
import { WorkspaceModeCoordinatorService } from './workspace-mode-coordinator.service';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly modeCoordinator: WorkspaceModeCoordinatorService,
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly gate: ProjectWriteGate,
  ) {}

  list(): Promise<ProjectWorkspace[]> {
    return this.modeCoordinator.list();
  }

  create(name: string): Promise<ProjectWorkspace> {
    return this.modeCoordinator.create(name);
  }

  rename(id: string, name: string): Promise<ProjectWorkspace> {
    return this.modeCoordinator.rename(id, name);
  }

  reorder(workspaceIds: string[]): Promise<ProjectWorkspace[]> {
    return this.modeCoordinator.reorder(workspaceIds);
  }

  /** Deleting a workspace moves its projects, so it needs every one of them writable. */
  async delete(id: string, replacementWorkspaceId: string): Promise<DeleteProjectWorkspaceResult> {
    for (const projectId of this.gate.listNonWritableProjectIds()) {
      let workspaceId: string;
      try {
        workspaceId = (await this.storage.getProject(projectId)).workspaceId;
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      if (workspaceId === id) {
        // Admit before workspace deletion relocates project rows.
        this.gate.assertWritable(projectId);
      }
    }
    return this.modeCoordinator.delete(id, replacementWorkspaceId);
  }
}
