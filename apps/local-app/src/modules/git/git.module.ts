import { Module } from '@nestjs/common';
import { GitService } from './services/git.service';
import { GitController } from './controllers/git.controller';
import { StorageModule } from '../storage/storage.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [StorageModule, ProcessExecutorModule],
  controllers: [GitController],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}
