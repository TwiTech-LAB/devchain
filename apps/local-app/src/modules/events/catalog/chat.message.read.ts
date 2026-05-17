import { z } from 'zod';

export const chatMessageReadEvent = {
  name: 'chat.message.read',
  schema: z.object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    agentId: z.string().min(1),
    readAt: z.string().min(1),
  }),
} as const;

export type ChatMessageReadEventPayload = z.infer<typeof chatMessageReadEvent.schema>;
