import { Injectable } from '@nestjs/common';
import { SessionLaunchPipeline } from './session-launch-pipeline.service';
import { SessionRestorePipeline } from './session-restore-pipeline.service';
import type { LaunchSessionDto, SessionDetailDto } from '../../dtos/sessions.dto';

@Injectable()
export class SessionRuntime {
  constructor(
    private readonly launchPipeline: SessionLaunchPipeline,
    private readonly restorePipeline: SessionRestorePipeline,
  ) {}

  async launch(data: LaunchSessionDto): Promise<SessionDetailDto> {
    return this.launchPipeline.launch(data);
  }

  async restore(sessionId: string, projectId: string): Promise<SessionDetailDto> {
    return this.restorePipeline.restore(sessionId, projectId);
  }
}
