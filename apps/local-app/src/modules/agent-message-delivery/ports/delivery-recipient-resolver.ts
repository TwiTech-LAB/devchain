export interface ResolvedRecipients {
  readonly agentIds: string[];
}

export abstract class DeliveryRecipientResolver {
  abstract resolve(
    recipients: string[],
    options?: { threadId?: string },
  ): Promise<ResolvedRecipients>;
}
