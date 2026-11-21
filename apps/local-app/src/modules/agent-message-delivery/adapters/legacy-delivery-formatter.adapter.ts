import { Injectable } from '@nestjs/common';
import { DeliveryFormatter } from '../ports/delivery-formatter';
import type { DeliveryMessage } from '../dtos/delivery.types';

function sanitizeOneLineLabel(value: string): string {
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
        if (framing === 'sender-footer') {
          if (message.body.startsWith('/')) return message.body;
          const senderName = sanitizeOneLineLabel(message.senderName);
          if (!senderName) return message.body;
          return `${message.body}\n[SentBy:${JSON.stringify(senderName)}]`;
        }
        const senderType = message.senderType ?? 'agent';
        return `\n[This message is sent from "${message.senderName}" ${senderType} use devchain_send_message tool for communication]\n${message.body}\n`;
      }
      case 'mcp.project': {
        const ownerLabel = JSON.stringify(sanitizeOneLineLabel(message.senderName));
        const projectLabel = JSON.stringify(
          sanitizeOneLineLabel(message.sourceProjectName ?? 'Unknown project'),
        );
        const sourceProjectId = JSON.stringify(
          sanitizeOneLineLabel(message.sourceProjectId ?? 'unknown'),
        );
        return `\n[This project message is sent from Project Owner ${ownerLabel} in project ${projectLabel}. To reply, use devchain_send_message with recipientProjectId: ${sourceProjectId}.]\n${message.body}\n`;
      }
      case 'pooled':
        return message.body;
    }
  }
}
