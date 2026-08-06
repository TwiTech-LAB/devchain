import { Injectable } from '@nestjs/common';
import { DeliveryFormatter } from '../ports/delivery-formatter';
import type { DeliveryMessage } from '../dtos/delivery.types';

function sanitizeBannerLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

@Injectable()
export class LegacyDeliveryFormatterAdapter extends DeliveryFormatter {
  format(message: DeliveryMessage): string {
    switch (message.kind) {
      case 'mcp.direct': {
        // Explicit default — do NOT derive from senderType. Mobile (human user)
        // turns opt into 'plain'; agent/guest mcp.direct stays the banner by
        // default. See DeliveryMessage.framing JSDoc for scope.
        const framing = message.framing ?? 'agent-banner';
        if (framing === 'plain') {
          // deliverImmediate pastes this verbatim then sends submit keys
          // (delivery.ts deliverImmediate). A leading/trailing newline would
          // shift prompt behavior / risk double submission, so plain is EXACTLY
          // the raw body — no surrounding whitespace.
          return message.body;
        }
        const senderType = message.senderType ?? 'agent';
        return `\n[This message is sent from "${message.senderName}" ${senderType} use devchain_send_message tool for communication]\n${message.body}\n`;
      }
      case 'mcp.project': {
        const ownerLabel = JSON.stringify(sanitizeBannerLabel(message.senderName));
        const projectLabel = JSON.stringify(
          sanitizeBannerLabel(message.sourceProjectName ?? 'Unknown project'),
        );
        const sourceProjectId = JSON.stringify(
          sanitizeBannerLabel(message.sourceProjectId ?? 'unknown'),
        );
        return `\n[This project message is sent from Project Owner ${ownerLabel} in project ${projectLabel}. To reply, use devchain_send_message with recipientProjectId: ${sourceProjectId}.]\n${message.body}\n`;
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
