import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentMessageDeliveryService } from '../agent-message-delivery.service';

interface ChatMessageCreatedPayload {
  threadId: string;
  projectId?: string;
  recipientIds?: string[];
  message: {
    id: string;
    threadId: string;
    authorType: 'user' | 'agent' | 'system';
    authorAgentId: string | null;
    content: string;
    targets?: string[];
    createdAt: string;
  };
}

@Injectable()
export class ChatMessageDeliverySubscriber {
  private readonly logger = new Logger(ChatMessageDeliverySubscriber.name);

  constructor(private readonly delivery: AgentMessageDeliveryService) {}

  @OnEvent('chat.message.created', { async: true })
  async handleChatMessageCreated(payload: ChatMessageCreatedPayload): Promise<void> {
    const { threadId, projectId, recipientIds, message } = payload;

    if (message.authorType === 'agent' || message.authorType === 'system') {
      return;
    }

    if (!projectId) {
      this.logger.warn({ threadId }, 'Missing projectId in payload, skipping delivery');
      return;
    }

    try {
      const recipients =
        recipientIds && recipientIds.length > 0 ? Array.from(new Set(recipientIds)) : [];

      if (recipients.length === 0) return;

      await this.delivery.deliver(recipients, {
        kind: 'chat.user',
        body: message.content,
        source: 'chat.message',
        projectId,
        senderName: 'User',
        senderType: 'user',
        threadId,
        messageId: message.id,
        senderAgentId: message.authorAgentId ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        { error, threadId, messageId: message.id },
        'Failed to deliver chat message',
      );
    }
  }
}
