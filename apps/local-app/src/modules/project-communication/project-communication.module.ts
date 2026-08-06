import { Module } from '@nestjs/common';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectCommunicationService } from './project-communication.service';

@Module({
  imports: [StorageModule, AgentMessageDeliveryModule],
  providers: [ProjectCommunicationService],
  exports: [ProjectCommunicationService],
})
export class ProjectCommunicationModule {}
