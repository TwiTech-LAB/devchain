import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';
import { HostHelperService } from '../host/host-helper.service';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { ProjectWriteAdmissionService } from './project-write-admission.service';

/**
 * Imported by every module with a project write path. It depends on storage
 * and the stateless host-state helpers only, so any feature module can
 * import it without a cycle.
 */
@Module({
  imports: [StorageModule, ProcessExecutorModule],
  providers: [ProjectFreezeService, ProjectWriteAdmissionService, HostHelperService],
  exports: [ProjectFreezeService, ProjectWriteAdmissionService, HostHelperService],
})
export class ProjectWriteAdmissionModule {}
