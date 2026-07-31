import { z } from 'zod';

const recipientSchema = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    status: z.enum(['queued', 'delivered', 'failed', 'unconfirmed']),
  })
  .strict();

const baseSchema = z.object({
  projectId: z.string().min(1),
  senderAgentId: z.string().min(1),
  senderAgentName: z.string().min(1),
  recipients: z.array(recipientSchema).min(1),
  recipientCount: z.number().int().positive(),
  deliveryStatus: z.enum(['queued', 'delivered', 'failed', 'unconfirmed', 'partial']),
});

const payloadSchema = z
  .union([
    baseSchema
      .extend({
        routingKind: z.literal('direct'),
      })
      .strict(),
    baseSchema
      .extend({
        routingKind: z.literal('group'),
        groupKind: z.literal('explicit'),
      })
      .strict(),
    baseSchema
      .extend({
        routingKind: z.literal('group'),
        groupKind: z.literal('team'),
        teamId: z.string().min(1),
        teamName: z.string().min(1),
        teamDeliveryMode: z.enum(['lead', 'lead_excluded', 'no_lead']),
      })
      .strict(),
  ])
  .superRefine((payload, context) => {
    if (payload.recipientCount !== payload.recipients.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientCount'],
        message: 'recipientCount must match recipients.length',
      });
    }

    const recipientIds = payload.recipients.map((recipient) => recipient.agentId);
    if (new Set(recipientIds).size !== recipientIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipients'],
        message: 'recipients must contain unique agent IDs',
      });
    }
  });

export const agentMessageSentEvent = {
  name: 'agent.message.sent',
  schema: payloadSchema,
} as const;

export type AgentMessageSentEventPayload = z.infer<typeof agentMessageSentEvent.schema>;
