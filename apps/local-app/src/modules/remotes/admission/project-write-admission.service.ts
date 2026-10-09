import { Injectable } from '@nestjs/common';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import type { RemoteOwnedProject } from '../../storage/write-gate/project-write-gate';

export type { RemoteOwnedProject } from '../../storage/write-gate/project-write-gate';

@Injectable()
export class ProjectWriteAdmissionService {
  constructor(private readonly gate: ProjectWriteGate) {}

  async refreshBindings(): Promise<void> {
    await this.gate.refresh();
  }

  assertWritable(projectId: string | null | undefined): void {
    this.gate.assertWritable(projectId);
  }

  isWritable(projectId: string): boolean {
    return this.gate.isWritable(projectId);
  }

  listNonWritableProjectIds(): string[] {
    return this.gate.listNonWritableProjectIds();
  }

  listRemoteOwnedProjectIds(): string[] {
    return this.gate.listRemoteOwnedProjectIds();
  }

  getRemoteOwner(projectId: string): RemoteOwnedProject | null {
    return this.gate.getRemoteOwner(projectId);
  }
}
