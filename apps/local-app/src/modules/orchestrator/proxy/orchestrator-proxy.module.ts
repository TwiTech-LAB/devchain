import { Module } from '@nestjs/common';
import { OrchestratorWorktreesModule } from '../worktrees/worktrees.module';
import { OrchestratorProxyService } from './services/orchestrator-proxy.service';

@Module({
  imports: [OrchestratorWorktreesModule],
  providers: [OrchestratorProxyService],
})
export class OrchestratorProxyModule {}
