import { z } from 'zod';

const actorSchema = z
  .object({
    type: z.enum(['agent', 'guest']),
    id: z.string().min(1),
  })
  .nullable()
  .optional();

export const agentCreatedEvent = {
  name: 'agent.created' as const,
  schema: z.object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    projectId: z.string().min(1),
    profileId: z.string().min(1),
    providerConfigId: z.string().min(1),
    actor: actorSchema,
  }),
};

export type AgentCreatedEventPayload = z.infer<typeof agentCreatedEvent.schema>;
