import { Injectable } from '@nestjs/common';
import { SessionLaunchPipeline } from './session-launch-pipeline.service';
import { SessionRestorePipeline } from './session-restore-pipeline.service';
import type { LaunchSessionDto, SessionDetailDto } from '../../dtos/sessions.dto';
import { ProjectWriteAdmissionService } from '../../../remotes/admission/project-write-admission.service';

/** Every launch and restore, including automatic ones, enters here. */
@Injectable()
export class SessionRuntime {
  constructor(
    private readonly launchPipeline: SessionLaunchPipeline,
    private readonly restorePipeline: SessionRestorePipeline,
    private readonly admission: ProjectWriteAdmissionService,
  ) {}

  async launch(data: LaunchSessionDto): Promise<SessionDetailDto> {
    this.admission.assertWritable(data.projectId);
    return this.launchPipeline.launch(data);
  }

  async restore(sessionId: string, projectId: string): Promise<SessionDetailDto> {
    this.admission.assertWritable(projectId);
    return this.restorePipeline.restore(sessionId, projectId);
  }
}
