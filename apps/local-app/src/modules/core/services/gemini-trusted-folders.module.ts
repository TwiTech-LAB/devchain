import { Module } from '@nestjs/common';
import { GeminiTrustedFoldersService } from './gemini-trusted-folders.service';

@Module({
  providers: [GeminiTrustedFoldersService],
  exports: [GeminiTrustedFoldersService],
})
export class GeminiTrustedFoldersModule {}
