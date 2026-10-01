import { Module } from '@nestjs/common';
import { PromptsController } from './controllers/prompts.controller';
import { StorageModule } from '../storage/storage.module';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [StorageModule, ProjectWriteAdmissionModule],
  controllers: [PromptsController],
})
export class PromptsModule {}
