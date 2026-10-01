import { Module } from '@nestjs/common';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectCommunicationService } from './project-communication.service';
import { ProjectWriteAdmissionModule } from '../remotes/admission/project-write-admission.module';

@Module({
  imports: [StorageModule, AgentMessageDeliveryModule, ProjectWriteAdmissionModule],
  providers: [ProjectCommunicationService],
  exports: [ProjectCommunicationService],
})
export class ProjectCommunicationModule {}
