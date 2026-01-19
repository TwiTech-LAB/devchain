import { Module } from '@nestjs/common';
import { GitService } from './services/git.service';
import { GitController } from './controllers/git.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [GitController],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}
