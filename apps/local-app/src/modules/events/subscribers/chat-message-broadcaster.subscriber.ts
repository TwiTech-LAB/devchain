import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';

interface ChatMessageCreatedPayload {
  threadId: string;
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

/**
 * Subscriber that broadcasts chat message events via WebSocket
 */
@Injectable()
export class ChatMessageBroadcasterSubscriber {
  private readonly logger = new Logger(ChatMessageBroadcasterSubscriber.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
  ) {}

  @OnEvent('chat.message.created', { async: true })
  async handleChatMessageCreated(payload: ChatMessageCreatedPayload): Promise<void> {
    try {
      this.terminalGateway.broadcastEvent(
        `chat/${payload.threadId}`,
        'message.created',
        payload.message,
      );
      this.logger.debug(
        { threadId: payload.threadId, messageId: payload.message.id },
        'Broadcasted chat message via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, threadId: payload.threadId, messageId: payload.message.id },
        'Failed to broadcast chat message',
      );
    }
  }
}
