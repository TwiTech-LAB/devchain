import { Module } from '@nestjs/common';
import { CopilotAuthProbeService } from './copilot-auth-probe.service';

@Module({
  providers: [CopilotAuthProbeService],
  exports: [CopilotAuthProbeService],
})
export class CopilotAuthProbeModule {}
