import { Injectable } from '@nestjs/common';
import {
  DeliveryRecipientResolver,
  ResolvedRecipients,
} from '../ports/delivery-recipient-resolver';

@Injectable()
export class LegacyRecipientResolverAdapter extends DeliveryRecipientResolver {
  async resolve(
    recipients: string[],
    _options?: { threadId?: string },
  ): Promise<ResolvedRecipients> {
    const agentIds = Array.from(new Set(recipients));
    return { agentIds };
  }
}
