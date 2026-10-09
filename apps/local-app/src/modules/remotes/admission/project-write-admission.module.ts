import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { ProjectWriteAdmissionService } from './project-write-admission.service';

/** Remotes compatibility facades over the storage write gate. */
@Module({
  imports: [StorageModule],
  providers: [ProjectFreezeService, ProjectWriteAdmissionService],
  exports: [ProjectFreezeService, ProjectWriteAdmissionService],
})
export class ProjectWriteAdmissionModule {}
