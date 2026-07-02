import { Module } from '@nestjs/common';
import { CopilotTrustedFoldersService } from './copilot-trusted-folders.service';

@Module({
  providers: [CopilotTrustedFoldersService],
  exports: [CopilotTrustedFoldersService],
})
export class CopilotTrustedFoldersModule {}
