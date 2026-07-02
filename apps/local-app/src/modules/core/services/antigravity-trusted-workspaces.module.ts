import { Module } from '@nestjs/common';
import { AntigravityTrustedWorkspacesService } from './antigravity-trusted-workspaces.service';

@Module({
  providers: [AntigravityTrustedWorkspacesService],
  exports: [AntigravityTrustedWorkspacesService],
})
export class AntigravityTrustedWorkspacesModule {}
