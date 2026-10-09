import { Injectable } from '@nestjs/common';
import { SessionLaunchPipeline } from './session-launch-pipeline.service';
import { SessionRestorePipeline } from './session-restore-pipeline.service';
import type { LaunchSessionDto, SessionDetailDto } from '../../dtos/sessions.dto';
import { ProjectWriteGate } from '../../../storage/write-gate/project-write-gate';

/** Every launch and restore, including automatic ones, enters here. */
@Injectable()
export class SessionRuntime {
  constructor(
    private readonly launchPipeline: SessionLaunchPipeline,
    private readonly restorePipeline: SessionRestorePipeline,
    private readonly gate: ProjectWriteGate,
  ) {}

  async launch(data: LaunchSessionDto): Promise<SessionDetailDto> {
    // Admit before launching tmux and provider processes.
    this.gate.assertWritable(data.projectId);
    return this.launchPipeline.launch(data);
  }

  async restore(sessionId: string, projectId: string): Promise<SessionDetailDto> {
    // Admit before restoring tmux and provider processes.
    this.gate.assertWritable(projectId);
    return this.restorePipeline.restore(sessionId, projectId);
  }
}
