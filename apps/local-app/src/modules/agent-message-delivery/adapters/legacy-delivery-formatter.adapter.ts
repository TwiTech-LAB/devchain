import { Injectable } from '@nestjs/common';
import { DeliveryFormatter } from '../ports/delivery-formatter';
import type { DeliveryMessage } from '../dtos/delivery.types';

@Injectable()
export class LegacyDeliveryFormatterAdapter extends DeliveryFormatter {
  format(message: DeliveryMessage): string {
    switch (message.kind) {
      case 'mcp.direct': {
        const senderType = message.senderType ?? 'agent';
        return `\n[This message is sent from "${message.senderName}" ${senderType} use devchain_send_message tool for communication]\n${message.body}\n`;
      }
      case 'mcp.thread':
      case 'chat.user': {
        const fromLabel = message.senderName ?? 'User';
        return `\n[CHAT] From: ${fromLabel} • Thread: ${message.threadId}\n${message.body}\n[ACK] tools/call { name: "devchain_chat_ack", arguments: { thread_id: "${message.threadId}", message_id: "${message.messageId}" } }\n`;
      }
      case 'pooled':
        return message.body;
    }
  }
}
